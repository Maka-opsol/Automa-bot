/**
 * INTEGRATION GUIDE: critical-patch-consensus.js
 *
 * This file shows the exact code changes needed in three existing files
 * to wire the new module into the bot.
 * ====================================================================
 */

// ===========================================================================
// 1. database.js — Add migration step 19
// ===========================================================================
//
// Find this line in database.js:
//   const target = 18;
//
// Change it to:
//   const target = 19;
//
// Then add this as the LAST entry in the migrationSteps array:
//
//   () => {
//     db.exec(`
//       CREATE TABLE IF NOT EXISTS critical_consensus (
//         id INTEGER PRIMARY KEY AUTOINCREMENT,
//         timestamp INTEGER NOT NULL,
//         phase TEXT NOT NULL,
//         target_file TEXT,
//         provider TEXT,
//         approved INTEGER DEFAULT 0,
//         confidence REAL DEFAULT 0,
//         reasoning TEXT,
//         patch_hash TEXT,
//         details TEXT
//       );
//       CREATE INDEX IF NOT EXISTS idx_critical_consensus_timestamp ON critical_consensus(timestamp);
//       CREATE INDEX IF NOT EXISTS idx_critical_consensus_phase ON critical_consensus(phase);
//       CREATE INDEX IF NOT EXISTS idx_critical_consensus_file ON critical_consensus(target_file);
//       CREATE INDEX IF NOT EXISTS idx_critical_consensus_hash ON critical_consensus(patch_hash);
//     `);
//   },


// ===========================================================================
// 2. self-heal.js — Route critical file patches through consensus
// ===========================================================================
//
// At the top of self-heal.js, add the require:
//
//   const { requestCriticalPatch, isRunning: isCriticalConsensusRunning } = require('./critical-patch-consensus');
//
// Find the function `selfHeal()` (or the main self-heal entry point)
// and locate the section where it determines which files to patch.
// Currently it checks `isPatchAllowed(file)` which blocks critical files.
//
// ADD THIS BLOCK right after the `isPatchAllowed` check fails for a
// critical file, BEFORE the patch is skipped:
//
//   // --- CRITICAL FILE CONSENSUS GATE ---
//   if (CRITICAL_FILES.includes(file) && !isPatchAllowed(file)) {
//     log(`🛡️ Self-heal wants to modify critical file ${file} — routing to critical consensus`, 'WARN', 'self-heal');
//     const consensusResult = await requestCriticalPatch({
//       description: `Self-heal triggered by: ${failureReason || 'recurring failures'}. Proposed fix: ${fix.description || 'N/A'}`,
//       targetFile: file,
//       recentErrors: getRecentErrors(),
//     });
//     if (consensusResult.applied) {
//       log(`✅ Critical consensus approved patch for ${file}`, 'INFO', 'self-heal');
//       // The consensus module already applied it — skip normal patch flow
//       continue; // or return, depending on your loop structure
//     } else {
//       log(`❌ Critical consensus rejected: ${consensusResult.reason}`, 'WARN', 'self-heal');
//       // Fall through to normal non-critical patching or skip
//       continue;
//     }
//   }
//


// ===========================================================================
// 3. agent.js — Add admin endpoints for consensus management
// ===========================================================================
//
// At the top of agent.js, add the require:
//
//   const {
//     requestCriticalPatch,
//     getCriticalFiles,
//     isRunning: isCriticalConsensusRunning,
//     getConsensusHistory,
//     manualRollback,
//   } = require('./critical-patch-consensus');
//
// Inside the HTTP server handler (where existing admin routes like
// /api/status, /api/restart, etc. are defined), add these endpoints:
//

// --- Paste this block into the HTTP request handler in agent.js ---

// GET /api/critical-consensus/files
//   Returns the list of files that the consensus module can modify.
//
// if (req.url === '/api/critical-consensus/files' && req.method === 'GET') {
//   if (!requireAuth(req)) { res.writeHead(401); res.end('Unauthorized'); return; }
//   res.writeHead(200, { 'Content-Type': 'application/json' });
//   res.end(JSON.stringify({ files: getCriticalFiles() }));
//   return;
// }

// GET /api/critical-consensus/status
//   Returns whether a consensus process is currently running.
//
// if (req.url === '/api/critical-consensus/status' && req.method === 'GET') {
//   if (!requireAuth(req)) { res.writeHead(401); res.end('Unauthorized'); return; }
//   res.writeHead(200, { 'Content-Type': 'application/json' });
//   res.end(JSON.stringify({ running: isCriticalConsensusRunning() }));
//   return;
// }

// GET /api/critical-consensus/history?limit=20
//   Returns recent consensus events from the audit trail.
//
// if (req.url.startsWith('/api/critical-consensus/history') && req.method === 'GET') {
//   if (!requireAuth(req)) { res.writeHead(401); res.end('Unauthorized'); return; }
//   const urlObj = new URL(req.url, `http://${req.headers.host}`);
//   const limit = parseInt(urlObj.searchParams.get('limit') || '20', 10);
//   res.writeHead(200, { 'Content-Type': 'application/json' });
//   res.end(JSON.stringify({ history: getConsensusHistory(limit) }));
//   return;
// }

// POST /api/critical-consensus/request
//   Manually trigger a critical consensus for a specific file.
//   Body: { "targetFile": "config.js", "description": "..." }
//
// if (req.url === '/api/critical-consensus/request' && req.method === 'POST') {
//   if (!requireAuth(req)) { res.writeHead(401); res.end('Unauthorized'); return; }
//   let body = '';
//   req.on('data', chunk => body += chunk);
//   req.on('end', async () => {
//     try {
//       const { targetFile, description } = JSON.parse(body);
//       if (!targetFile) {
//         res.writeHead(400, { 'Content-Type': 'application/json' });
//         res.end(JSON.stringify({ error: 'targetFile is required' }));
//         return;
//       }
//       const result = await requestCriticalPatch({ targetFile, description: description || 'Manual request via admin API' });
//       res.writeHead(200, { 'Content-Type': 'application/json' });
//       res.end(JSON.stringify(result));
//     } catch (err) {
//       res.writeHead(500, { 'Content-Type': 'application/json' });
//       res.end(JSON.stringify({ error: err.message }));
//     }
//   });
//   return;
// }

// POST /api/critical-consensus/rollback
//   Manually roll back the most recent critical patch for a file.
//   Body: { "targetFile": "config.js" }
//
// if (req.url === '/api/critical-consensus/rollback' && req.method === 'POST') {
//   if (!requireAuth(req)) { res.writeHead(401); res.end('Unauthorized'); return; }
//   let body = '';
//   req.on('data', chunk => body += chunk);
//   req.on('end', () => {
//     try {
//       const { targetFile } = JSON.parse(body);
//       if (!targetFile) {
//         res.writeHead(400, { 'Content-Type': 'application/json' });
//         res.end(JSON.stringify({ error: 'targetFile is required' }));
//         return;
//       }
//       const success = manualRollback(targetFile);
//       res.writeHead(200, { 'Content-Type': 'application/json' });
//       res.end(JSON.stringify({ success }));
//     } catch (err) {
//       res.writeHead(500, { 'Content-Type': 'application/json' });
//       res.end(JSON.stringify({ error: err.message }));
//     }
//   });
//   return;
// }


// ===========================================================================
// 4. config.js — Add new config variables
// ===========================================================================
//
// Add these to the env validation in config.js (alongside existing CONFIG vars):
//
//   CRITICAL_CONSENSUS_COOLING_OFF_MS: num({ default: 300000 }),       // 5 minutes
//   CRITICAL_CONSENSUS_VERIFY_WINDOW_MS: num({ default: 600000 }),    // 10 minutes
//   ENABLE_CRITICAL_CONSENSUS: bool({ default: true }),                // master switch
//
// Then in critical-patch-consensus.js, add a guard at the top of
// requestCriticalPatch():
//
//   if (!CONFIG.ENABLE_CRITICAL_CONSENSUS) {
//     return { applied: false, reason: 'Critical consensus is disabled via config', details: {} };
//   }


// ===========================================================================
// 5. .gitignore — Add backup directory
// ===========================================================================
//
// Add this line:
//   .critical-backups/