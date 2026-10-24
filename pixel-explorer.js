"use strict";

const explorer = require("./pixel-explorer.ts");
const fallback = require("./pixel-fallback.ts");

if (typeof fallback.generatePixelFallbackAction === "function") {
  explorer.generatePixelFallbackAction = fallback.generatePixelFallbackAction;
}

if (typeof explorer.explore !== "function") {
  explorer.explore = async (page, currentState) =>
    explorer.generatePixelFallbackAction(page, currentState);
}

if (typeof explorer.observeOutcome !== "function") {
  explorer.observeOutcome = async () => undefined;
}

module.exports = explorer;
