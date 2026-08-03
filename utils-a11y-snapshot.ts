'use strict';

/**
 * Non-deprecated replacement for page.accessibility.snapshot().
 *
 * Playwright deprecated the Accessibility API in 1.44+. This compat helper
 * builds an equivalent tree from DOM + ARIA attributes via page.evaluate().
 *
 * The output shape mirrors Playwright's SerializedAXNode so existing consumers
 * (semantics overlord, blackbox recorder, UI drift) work without changes.
 */

/**
 * Get an accessibility snapshot from the page using DOM evaluation.
 * Drop-in replacement for page.accessibility.snapshot().
 */
async function getA11ySnapshot(page: any, options?: { interestingOnly?: boolean }): Promise<any> {
  const interestingOnly = options?.interestingOnly ?? true;
  try {
    return await page.evaluate((onlyInteresting: boolean) => {
      const INTERESTING_ROLES = new Set([
        'button', 'link', 'textbox', 'checkbox', 'radio', 'menuitem',
        'listitem', 'img', 'dialog', 'alertdialog', 'alert', 'banner',
        'navigation', 'main', 'search', 'form', 'heading', 'tab', 'tablist',
        'treeitem', 'combobox', 'slider', 'switch', 'progressbar',
      ]);

      function buildNode(el: Element): any {
        const tag = el.tagName || '';
        const role = (el.getAttribute('role') ||
          tag === 'BUTTON' ? 'button' :
          tag === 'A' ? 'link' :
          tag === 'INPUT' ? ((el as HTMLInputElement).type === 'checkbox' ? 'checkbox' :
            (el as HTMLInputElement).type === 'radio' ? 'radio' : 'textbox') :
          tag === 'SELECT' ? 'combobox' :
          tag === 'IMG' ? 'img' :
          (tag.startsWith('H') && tag.length === 2 && !isNaN(Number(tag[1]))) ? 'heading' :
          '').toLowerCase();

        const name = el.getAttribute('aria-label') ||
          el.getAttribute('aria-labelledby') ||
          (el as HTMLInputElement).placeholder ||
          (el.textContent || '').trim().substring(0, 100) || '';
        const description = el.getAttribute('aria-description') || '';
        const disabled = el.getAttribute('aria-disabled') === 'true' || (el as HTMLInputElement).disabled;
        const rect = el.getBoundingClientRect();

        const node: any = { role: role || 'generic', name };
        if (description) node.description = description;
        if (disabled) node.disabled = true;
        if (rect.width > 0 && rect.height > 0) {
          node.boundingRect = {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          };
        }

        const children: any[] = [];
        for (const child of el.children) {
          const childNode = buildNode(child as Element);
          if (childNode) children.push(childNode);
        }
        if (children.length > 0) node.children = children;

        if (onlyInteresting && !node.children?.length && !INTERESTING_ROLES.has(node.role) && !node.boundingRect) {
          return null;
        }
        return node;
      }

      const tree: any = { role: 'WebArea', name: document.title || '', children: [] };
      for (const child of document.documentElement.children) {
        const node = buildNode(child as Element);
        if (node) tree.children.push(node);
      }
      return tree;
    }, interestingOnly);
  } catch (e: any) {
    return null;
  }
}

module.exports = { getA11ySnapshot };
