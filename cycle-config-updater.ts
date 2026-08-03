'use strict';
const { sleep } = require('./utils-sleep');

const { getBrowser } = require('./browser');
const { runVisionPipeline } = require('./providers-vision-pipeline');
const { getProviderConfig, updateProviderConfig } = require('./providers-config-loader');
const { log, safeLog, logError } = require('./logger');
const CONFIG = require('./get-config');
const { retryWithBackoff } = require('./providers-base');

const PROVIDER_DOCS = {
  'Groq': 'https://console.groq.com/docs/models',
  'GitHub GPT': 'https://github.com/marketplace/models/azure-openai',
  'z.ai': 'https://z.ai/docs/models',
  'Agnes': 'https://docs.agnes-ai.com/models',
  'NVIDIA': 'https://build.nvidia.com/docs/models',
  'Cloudflare': 'https://developers.cloudflare.com/workers-ai/models/',
  'Cerebras': 'https://docs.cerebras.ai/models',
  'Gemini': 'https://ai.google.dev/gemini-api/docs/models'
};

const EXTRACTION_PROMPT = `
You are a configuration scanner. Look at the documentation page screenshot.
Find the current vision-capable model name (e.g., "llama-3.2-11b-vision-preview")
and the base API URL (e.g., "https://api.groq.com/openai/v1/chat/completions").
If the endpoint is not explicitly given, you can infer it from the documentation or return null.
Return ONLY JSON: { "endpoint": "...", "model": "..." }.
If unsure, return null.
`;

async function discoverAndUpdateProvider(providerName: any) { 
  const url = (PROVIDER_DOCS as any)[providerName];
  if (!url) { log(`⚠️ No docs URL for ${providerName}, skipping.`, 'WARN', 'config-updater'); return; }
  log(`🔍 Discovering config for ${providerName} from ${url}...`, 'INFO', 'config-updater');
  let context;
  try {
    const browser = getBrowser();
    if (!browser || !browser.isConnected()) { log('Browser not available for config update, skipping.', 'WARN', 'config-updater'); return; }
    context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(2000);
    const screenshot = await page.screenshot({ type: 'jpeg', quality: 50 });
    const base64 = screenshot.toString('base64');
    const result = await retryWithBackoff(() => runVisionPipeline(base64, EXTRACTION_PROMPT, {
      validator: (parsed: any) => { if (typeof parsed.model !== 'string' || parsed.model.length === 0) throw new Error('Model missing'); return { endpoint: typeof parsed.endpoint === 'string' ? parsed.endpoint : null, model: parsed.model }; },
      timeoutMs: 20000,
    }), { maxRetries: 2 });
    if (!result) { log(`⚠️ Could not extract config for ${providerName}`, 'WARN', 'config-updater'); return; }
    const newConfig = { endpoint: result.result.endpoint || getProviderConfig(providerName)?.endpoint, model: result.result.model };
    updateProviderConfig(providerName, newConfig, true);
    log(`✅ Updated ${providerName} to model ${newConfig.model}`, 'INFO', 'config-updater');
  } catch (err: any) { logError(`Updater error for ${providerName}`, err); } finally { if (context) { try { await context.close(); } catch (e: any) { /* context may already be closed */ } } }
}

async function runConfigUpdater() { 
  log('🔄 Running config updater for ALL providers...', 'INFO', 'config-updater');
  for (const name of Object.keys(PROVIDER_DOCS)) {
    await discoverAndUpdateProvider(name);
    await new Promise(r => setTimeout(r, 5000));
  }
  log(`✅ Config updater finished (${Object.keys(PROVIDER_DOCS).length} providers updated).`, 'INFO', 'config-updater');
}

module.exports = { runConfigUpdater };
