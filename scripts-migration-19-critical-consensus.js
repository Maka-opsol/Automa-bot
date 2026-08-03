/**
 * Migration 19: Add critical_consensus audit table
 *
 * Run this AFTER the existing schema version 18.
 * Add this function to the migrationSteps array in database.js.
 *
 * CREATE TABLE IF NOT EXISTS critical_consensus (
 *   id INTEGER PRIMARY KEY AUTOINCREMENT,
 *   timestamp INTEGER NOT NULL,
 *   phase TEXT NOT NULL,          -- 'analysis' | 'verification' | 'veto' | 'applied' | 'auto_rollback' | 'manual_rollback' | 'error'
 *   target_file TEXT,
 *   provider TEXT,
 *   approved INTEGER DEFAULT 0,  -- 1 = approved, 0 = rejected
 *   confidence REAL DEFAULT 0,
 *   reasoning TEXT,
 *   patch_hash TEXT,             -- SHA-256 of the proposed patch content
 *   details TEXT                 -- JSON blob with extra context
 * );
 */

// Paste this into the migrationSteps array in database.js as step 19:
module.exports = function migrationStep19(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS critical_consensus (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      phase TEXT NOT NULL,
      target_file TEXT,
      provider TEXT,
      approved INTEGER DEFAULT 0,
      confidence REAL DEFAULT 0,
      reasoning TEXT,
      patch_hash TEXT,
      details TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_critical_consensus_timestamp ON critical_consensus(timestamp);
    CREATE INDEX IF NOT EXISTS idx_critical_consensus_phase ON critical_consensus(phase);
    CREATE INDEX IF NOT EXISTS idx_critical_consensus_file ON critical_consensus(target_file);
    CREATE INDEX IF NOT EXISTS idx_critical_consensus_hash ON critical_consensus(patch_hash);
  `);
};

// ---------------------------------------------------------------------------
// How to integrate into database.js:
// ---------------------------------------------------------------------------
//
// 1. In database.js, increment `const target = 18;` to `const target = 19;`
//
// 2. Add a new entry to the `migrationSteps` array:
//
//    () => {
//      db.exec(`
//        CREATE TABLE IF NOT EXISTS critical_consensus (
//          id INTEGER PRIMARY KEY AUTOINCREMENT,
//          timestamp INTEGER NOT NULL,
//          phase TEXT NOT NULL,
//          target_file TEXT,
//          provider TEXT,
//          approved INTEGER DEFAULT 0,
//          confidence REAL DEFAULT 0,
//          reasoning TEXT,
//          patch_hash TEXT,
//          details TEXT
//        );
//        CREATE INDEX IF NOT EXISTS idx_critical_consensus_timestamp ON critical_consensus(timestamp);
//        CREATE INDEX IF NOT EXISTS idx_critical_consensus_phase ON critical_consensus(phase);
//        CREATE INDEX IF NOT EXISTS idx_critical_consensus_file ON critical_consensus(target_file);
//        CREATE INDEX IF NOT EXISTS idx_critical_consensus_hash ON critical_consensus(patch_hash);
//      `);
//    },
//
// 3. Export the new table's prepared statements alongside existing ones.