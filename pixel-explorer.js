"use strict";

// Compatibility shim for recovery callers. Node resolves this file before the
// TypeScript implementation for require("./pixel-explorer"). Keep the real
// implementation as the single source of pixel logic, but supply the legacy
// recovery hooks that cycle-cycle-manager expects.
const explorer = require("./pixel-explorer.ts");

if (typeof explorer.explore !== "function") {
  explorer.explore = async (page, currentState) =>
    explorer.generatePixelFallbackAction(page, currentState);
}

// Outcome learning is optional in the TypeScript explorer. Make old callers
// safe without pretending an observation was recorded.
if (typeof explorer.observeOutcome !== "function") {
  explorer.observeOutcome = async () => undefined;
}

module.exports = explorer;
