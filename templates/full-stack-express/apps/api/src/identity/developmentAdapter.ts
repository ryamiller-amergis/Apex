import type { Env } from '../config/env.ts';
import type { IdentityLogger, IdentityProviderAdapter } from './adapter.ts';
import { DevelopmentAdapterInProductionError } from './errors.ts';
import type { Principal } from './principal.ts';

/**
 * The one synthetic caller for local work. The .invalid domain is reserved
 * (RFC 2606), so the email can never reach a real mailbox. Seed data and
 * tests import this constant rather than repeating the values.
 */
export const DEVELOPMENT_PRINCIPAL: Principal = Object.freeze({
  subject: 'synthetic-dev-subject',
  displayName: 'Synthetic Developer',
  email: 'synthetic.developer@example.invalid',
});

export interface DevelopmentAdapterOptions {
  nodeEnv: Env['NODE_ENV'];
  logger: IdentityLogger;
}

/**
 * Every request runs as DEVELOPMENT_PRINCIPAL. The request is never read, so
 * no header can pick a different identity. The environment schema already
 * rejects this mode in production; this check stops a caller that builds the
 * adapter without going through the schema.
 */
export function createDevelopmentAdapter(
  options: DevelopmentAdapterOptions
): IdentityProviderAdapter {
  if (options.nodeEnv === 'production') {
    throw new DevelopmentAdapterInProductionError();
  }
  options.logger.warn(
    { event: 'auth.development_adapter_active' },
    'development identity adapter is active; every request runs as the synthetic principal'
  );
  return {
    authenticate: () => Promise.resolve(DEVELOPMENT_PRINCIPAL),
  };
}
