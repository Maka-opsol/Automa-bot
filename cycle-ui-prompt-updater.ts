'use strict';
const { getPageViewport } = require('./browser');
const { sleep } = require('./utils-sleep');

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getCONFIG(): Record<string, any> { return _deps.config || require('./get-config'); }

const { log, logError } = require('./logger');
const { launchBrowser, closeBrowser } = require('./browser');
const { authenticate } = require('./auth');
const { determineNextAction } = require('./providers');
const { runVisionPipeline } = require('./providers-vision-pipeline');
const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('./project-root');

const PROMPTS_PATH = path.join(PROJECT_ROOT, './providers-prompts.ts');
const BACKUP_PATH = path.join(PROJECT_ROOT, './providers-prompts.backup.ts');
const VERSION_PATH = path.join(PROJECT_ROOT, './providers-prompts.version.json');

const NAVIGATION_STEPS = [
  { state: 'assignments_page', action: async (page: any) => { await page.goto(getCONFIG().APP_URL + '/assignments', { waitUntil: 'domcontentloaded', timeout: 30000 }); await sleep(5000); } },
  { state: 'video_player', action: async (page: any) => { const watchBtn = page.locator('button:has-text("Watch"), a:has-text("Watch")').first(); if (await watchBtn.count()) { await watchBtn.click(); await sleep(5000); } else { const screenshot = await page.screenshot({ type: 'jpeg', quality: 30 }); const base64 = screenshot.toString('base64'); const action = await determineNextAction(base64, page.url()); if (action.actionType === 'click' && action.targetX && action.targetY) { const vp = getPageViewport(page); const x = action.targetX * (vp ? vp.width : getCONFIG().DISPLAY_WIDTH); const y = action.targetY * (vp ? vp.height : getCONFIG().DISPLAY_HEIGHT); await page.mouse.click(x, y); await sleep(5000); } } } },
  { state: 'exercise_info', action: async (page: any) => { await page.waitForSelector('.exercise-container, .task-content, .question', { timeout: 10000 }).catch(() => {}); } },
  { state: 'exercise_memo', action: async (page: any) => { const screenshot = await page.screenshot({ type: 'jpeg', quality: 30 }); const base64 = screenshot.toString('base64'); const action = await determineNextAction(base64, page.url()); if (action.actionType === 'click' && action.targetX && action.targetY) { const vp = getPageViewport(page); const x = action.targetX * (vp ? vp.width : getCONFIG().DISPLAY_WIDTH); const y = action.targetY * (vp ? vp.height : getCONFIG().DISPLAY_HEIGHT); await page.mouse.click(x, y); await sleep(5000); } } },
  { state: 'assessment', action: async (page: any) => { const screenshot = await page.screenshot({ type: 'jpeg', quality: 30 }); const base64 = screenshot.toString('base64'); const action = await determineNextAction(base64, page.url()); if (action.actionType === 'click' && action.targetX && action.targetY) { const vp = getPageViewport(page); const x = action.targetX * (vp ? vp.width : getCONFIG().DISPLAY_WIDTH); const y = action.targetY * (vp ? vp.height : getCONFIG().DISPLAY_HEIGHT); await page.mouse.click(x, y); await sleep(5000); } } },
  { state: 'score_screen', action: async (page: any) => { await page.waitForSelector('.score, .result, .percentage', { timeout: 10000 }).catch(() => {}); } },
  { state: 'pathway', action: async (page: any) => { const pathwayBtn = page.locator('button:has-text("Pathway"), a:has-text("Pathway")').first(); if (await pathwayBtn.count()) { await pathwayBtn.click(); await sleep(5000); } } },
  { state: 'pathway_feedback', action: async (page: any) => { const answerBlock = page.locator('.answer-block, .option, .choice').first(); if (await answerBlock.count()) { await answerBlock.click(); await sleep(3000); } } }
];

async function runUIPromptUpdater() { 
  log('Starting UI Prompt Updater...', 'INFO', 'ui-prompt');
  let page;
  try {
    page = await launchBrowser();
    await authenticate(page);
    const screenshots = [];
    for (const step of NAVIGATION_STEPS) {
      log(`Navigating to ${step.state}...`, 'DEBUG', 'ui-prompt');
      await step.action(page);
      await sleep(3000);
      const screenshot = await page.screenshot({ type: 'jpeg', quality: 30 });
      screenshots.push({ state: step.state, base64: screenshot.toString('base64') });
    }
    const newPrompts = await generatePromptsFromScreenshots(screenshots);
    if (!newPrompts) { log('Failed to generate new prompts.', 'ERROR', 'ui-prompt'); return; }
    const isValid = await validateNewPrompts(newPrompts, screenshots);
    if (!isValid) { log('New prompts validation failed. Reverting.', 'ERROR', 'ui-prompt'); return; }
    if (fs.existsSync(PROMPTS_PATH)) { fs.writeFileSync(BACKUP_PATH, fs.readFileSync(PROMPTS_PATH)); }
    let versionData = { versions: [] };
    if (fs.existsSync(VERSION_PATH)) versionData = JSON.parse(fs.readFileSync(VERSION_PATH, 'utf8'));
    (versionData.versions as any[]).push({ timestamp: new Date().toISOString(), prompts: newPrompts });
    if (versionData.versions.length > 5) versionData.versions.shift();
    fs.writeFileSync(VERSION_PATH, JSON.stringify(versionData, null, 2));
    fs.writeFileSync(PROMPTS_PATH, generatePromptFileContent(newPrompts));
    log('UI prompts updated successfully.', 'INFO', 'ui-prompt');
  } catch (err: any) { logError('UI Prompt Updater failed', err); if (fs.existsSync(BACKUP_PATH)) { fs.writeFileSync(PROMPTS_PATH, fs.readFileSync(BACKUP_PATH)); log('Restored prompts from backup.', 'INFO', 'ui-prompt'); } } finally { await closeBrowser(); }
}

async function generatePromptsFromScreenshots(screenshots: any) { 
  const existingPrompt = fs.existsSync(PROMPTS_PATH) ? fs.readFileSync(PROMPTS_PATH, 'utf8') : '';
  const metaPrompt = `
You are an expert in UI analysis and prompt engineering.
Below are screenshots of the MathU platform for each state.
Also given is the current system prompt and user instruction.
Based on these screenshots, generate an updated SYSTEM_PROMPT and USER_INSTRUCTION.
The new prompts must keep the same JSON structure and state/action definitions but update descriptions to match the current UI.
Return ONLY a JSON object with keys "systemPrompt" and "userInstruction".
Current prompts (if any):
${existingPrompt}
Screenshots are provided as base64 images (one per state). Use them to refine the descriptions.
`;
  const firstScreenshot = screenshots[0]?.base64;
  if (!firstScreenshot) return null;
  const result = await runVisionPipeline(firstScreenshot, metaPrompt, {
    validator: (parsed: any) => { if (typeof parsed.systemPrompt !== 'string' || typeof parsed.userInstruction !== 'string') throw new Error('Invalid prompt structure'); return { systemPrompt: parsed.systemPrompt, userInstruction: parsed.userInstruction }; },
    timeoutMs: 30000,
  });
  return result ? result.result : null;
}

async function validateNewPrompts(newPrompts: any, screenshots: any) {
  const testPath = path.join(PROJECT_ROOT, './providers-prompts.test.js');
  fs.writeFileSync(testPath, generatePromptFileContent(newPrompts));
  try {
    // Clear require cache to load the new prompts for validation
    const resolvedTestPath = require.resolve(testPath);
    if (require.cache[resolvedTestPath]) delete require.cache[resolvedTestPath];
    const testPrompts = require(testPath);
    // Sanity check: prompts must contain expected state names
    const requiredStates = ['assignments_page', 'video_player', 'exercise', 'score_screen'];
    const combined = (testPrompts.SYSTEM_PROMPT || testPrompts.getSystemPrompt?.() || '') + (testPrompts.USER_INSTRUCTION || testPrompts.getUserInstruction?.() || '');
    for (const state of requiredStates) {
      if (!combined.includes(state)) { log(`Validation failed: missing state "${state}" in new prompts`, 'DEBUG', 'ui-prompt'); return false; }
    }
    for (const snap of screenshots) {
      const action = await determineNextAction(snap.base64, '', null);
      if (!action || !action.actionType) { log(`Validation failed for state ${snap.state}`, 'DEBUG', 'ui-prompt'); return false; }
    }
    return true;
  } catch (e: any) { logError('Validation error', e); return false; } finally {
    try {
      const resolvedTestPath = require.resolve(testPath);
      if (fs.existsSync(testPath)) fs.unlinkSync(testPath);
      delete require.cache[resolvedTestPath];
    } catch (cleanupErr: any) { /* best effort cleanup */ }
  }
}

function generatePromptFileContent(prompts: any) { 
  return `
// AUTO-GENERATED by UI Prompt Updater on ${new Date().toISOString()}
// DO NOT MANUALLY EDIT -- changes will be overwritten.
const CONFIG = require('./get-config');
let remoteBrain;
  try { remoteBrain = require('./remote-brain-injector'); } catch (e: any) { remoteBrain = null; }
const BASE_SYSTEM_PROMPT = ${JSON.stringify(prompts.systemPrompt, null, 2)};
const BASE_USER_INSTRUCTION = ${JSON.stringify(prompts.userInstruction, null, 2)};
function getSystemPrompt() { 
  const remote = remoteBrain && remoteBrain.getActiveInstruction ? remoteBrain.getActiveInstruction() : null;
  if (remote) return BASE_SYSTEM_PROMPT + '\n\n[REMOTE OVERRIDE]: ' + remote;
  return BASE_SYSTEM_PROMPT;
}
function getUserInstruction() { 
  const remote2 = remoteBrain && remoteBrain.getActiveInstruction ? remoteBrain.getActiveInstruction() : null;
  if (remote2) return BASE_USER_INSTRUCTION + '\n\n[REMOTE OVERRIDE]: ' + remote2;
  return BASE_USER_INSTRUCTION;
}
const SYSTEM_PROMPT = getSystemPrompt();
const USER_INSTRUCTION = getUserInstruction();
module.exports = { SYSTEM_PROMPT, USER_INSTRUCTION, getSystemPrompt, getUserInstruction };
`;
}

module.exports = { runUIPromptUpdater, _injectDependencies };
