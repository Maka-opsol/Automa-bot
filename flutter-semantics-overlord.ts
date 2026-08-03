'use strict';

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
const log = (...args: any[]) => _deps.logger?.log?.(...args) ?? console.log(...args);
const logError = (...args: any[]) => _deps.logger?.logError?.(...args) ?? console.error(...args);

class FlutterSemanticsOverlord {
  semanticsCache: any;
  cacheTimestamp: any;
  cacheTTL: any;

  constructor() {
    this.semanticsCache = null;
    this.cacheTimestamp = 0;
    this.cacheTTL = 2000;
  }

  async harvest(page: any) { 
    try {
      const snapshot = await require('./utils-a11y-snapshot').getA11ySnapshot(page, { interestingOnly: false });
      if (!snapshot) return [];
      const flatNodes: any[] = [];
      this.flattenTree(snapshot, flatNodes);
      const items = [];
      for (const node of flatNodes) {
        if (node.boundingRect) {
          const rect = node.boundingRect;
          items.push({ role: node.role || 'unknown', name: node.name || '', description: node.description || '', x: rect.x, y: rect.y, width: rect.width, height: rect.height, centerX: rect.x + rect.width / 2, centerY: rect.y + rect.height / 2, disabled: node.disabled || false, raw: node });
        }
      }
      this.semanticsCache = items;
      this.cacheTimestamp = Date.now();
      log(`👁️ Semantics Overlord harvested ${items.length} Flutter widgets.`, 'INFO', 'semantics');
      return items;
    } catch (e: any) { logError('Semantics harvest failed', e); return []; }
  }

  flattenTree(node: any, list: any) { 
    if (!node) return;
    const children = node.children || [];
    const interactiveRoles = ['button', 'link', 'textbox', 'checkbox', 'radio', 'menuitem', 'listitem', 'img'];
    if (node.role && interactiveRoles.includes(node.role) && node.boundingRect) { list.push(node); }
    for (const child of children) { this.flattenTree(child, list); }
  }

  findElement(name: any, items: any) { 
    const lowerName = name.toLowerCase();
    return items.find((item: any) => item.name?.toLowerCase() === lowerName);
  }

  findElementFuzzy(name: any, items: any) { 
    const lowerName = name.toLowerCase();
    return items.find((item: any) => item.name?.toLowerCase().includes(lowerName));
  }

  async getInteractiveItems(page: any, forceRefresh = false) { 
    if (!forceRefresh && this.semanticsCache && (Date.now() - this.cacheTimestamp < this.cacheTTL)) { return this.semanticsCache; }
    return await this.harvest(page);
  }
}

module.exports = Object.assign(new FlutterSemanticsOverlord(), { _injectDependencies });
