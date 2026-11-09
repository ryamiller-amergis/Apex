import type { IncomingHttpHeaders } from 'node:http';
import type { Principal } from './principal.ts';

/**
 * What an adapter may read. Headers only: an adapter cannot write the
 * response or read other middleware state, so swapping it needs no handler
 * change.
 */
export interface AdapterRequest {
  readonly headers: IncomingHttpHeaders;
}

/**
 * Resolves the caller from a request. A provider adapter must verify the
 * credential before it returns a principal, and must return null or throw
 * when it cannot. Every outcome other than a valid principal becomes a 401.
 */
export interface IdentityProviderAdapter {
  /** Sent in WWW-Authenticate on every 401. Defaults to "Bearer". */
  readonly challenge?: string;
  authenticate(request: AdapterRequest): Promise<Principal | null>;
}

/** The narrow logger the identity module needs; a Pino logger satisfies it. */
export interface IdentityLogger {
  warn(fields: object, msg: string): void;
}
