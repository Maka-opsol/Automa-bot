'use strict';

/**
 * Dependency injection container dep-map type.
 * Each module receives a subset of these keys via its `deps` array
 * in container-modules.ts. Typed as a loose record so that adding
 * a new dependency does not require editing this file.
 */
export interface Deps {
  [key: string]: any;
}
