/** Type declarations for the `envalid` module (v7.x). */

declare module 'envalid' {
  /** Options accepted by individual validators. */
  interface ValidatorSpec<T = any> {
    default?: T;
    desc?: string;
    docs?: string;
    example?: T;
    choices?: T[];
    devDefault?: T | ((env: any) => T);
    env?: string;
    nullable?: boolean;
  }

  /** String env var validator. */
  export function str(spec?: ValidatorSpec<string>): any;
  /** Number env var validator. */
  export function num(spec?: ValidatorSpec<number>): any;
  /** Boolean env var validator. */
  export function bool(spec?: ValidatorSpec<boolean>): any;
  /** JSON-parsed env var validator. */
  export function json(spec?: ValidatorSpec<any>): any;

  /** Validate and clean environment variables. */
  export function cleanEnv(
    env: Record<string, string | undefined>,
    spec: Record<string, any>,
    options?: {
      strict?: boolean;
      devDefaults?: Record<string, any>;
    }
  ): Record<string, any>;
}
