/* Global type declarations for browser-context globals used in Playwright page.evaluate() callbacks.
   These are not available from @types/node (which only provides Node.js globals).
   At runtime, Playwright injects window/document into the page context.
   We declare them here so tsc doesn't complain when they're referenced inside
   strings passed to page.evaluate() or similar callbacks. */

/* eslint-disable @typescript-eslint/no-explicit-any */
declare var window: any;
declare var document: any;

/** Declared in browser.ts, accessed via typeof check in cycle-cycle-manager.ts */
declare var resetBrowserLaunchCount: (() => void) | undefined;

/* DOM types referenced in Playwright evaluation callbacks and a11y utilities.
   These are loosely typed as `any` since we only need tsc to recognise the name,
   not to enforce full DOM interface compliance. */
declare class Event { type: string; target: any; currentTarget: any; preventDefault(): void; stopPropagation(): void; }
declare class TouchEvent extends Event { touches: any[]; changedTouches: any[]; }
declare class Element { tagName: string; className: string; id: string; getAttribute(name: string): string | null; querySelector(sel: string): any; querySelectorAll(sel: string): any[]; children: any[]; innerHTML: string; outerHTML: string; textContent: string; parentElement: any; closest(sel: string): any; matches(sel: string): boolean; getBoundingClientRect(): any; }
declare class HTMLElement extends Element { style: any; click(): void; focus(): void; blur(): void; disabled: boolean; value: string; type: string; hidden: boolean; offsetWidth: number; offsetHeight: number; getBoundingClientRect(): any; }
declare class HTMLInputElement extends HTMLElement { checked: boolean; files: any[]; placeholder: string; }