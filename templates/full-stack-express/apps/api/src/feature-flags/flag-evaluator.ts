/**
 * Answers whether a named flag is on. Every adapter, local or provider-backed,
 * implements this interface, so call sites never change when the adapter does.
 *
 * Implementations must be synchronous, must never throw, and must never perform
 * I/O during `isEnabled`. An adapter for a remote provider answers from an
 * in-memory cache that it refreshes outside the request path.
 */
export interface FlagEvaluator {
  /**
   * Returns the configured value of `name`, or `defaultValue` when the flag is
   * not defined or the configuration could not be read.
   */
  isEnabled(name: string, defaultValue: boolean): boolean;
}

/** Structural logger type. A Pino logger satisfies it without a wrapper. */
export interface FlagLogger {
  warn(fields: Record<string, unknown>, message: string): void;
}
