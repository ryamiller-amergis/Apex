// Replaced by FEAT-006 Health and Self-Service Profile API.
import { loadEnv } from './config/env.ts';
import { createLocalFlagEvaluator } from './feature-flags/index.ts';
import {
  createIdentityAdapter,
  IdentityConfigurationError,
  type IdentityProviderAdapter,
} from './identity/index.ts';
import { createLogger } from './observability/logger.ts';
import { CONTRACTS_STUB } from '@project-scope/contracts';

const env = loadEnv();
const logger = createLogger(env);

// Runs before anything listens, so a bad AUTH_MODE stops the process with no
// port open. FEAT-006 passes this adapter to createAuthMiddleware.
function buildIdentityAdapter(): IdentityProviderAdapter {
  try {
    return createIdentityAdapter(env, { logger });
  } catch (error) {
    if (error instanceof IdentityConfigurationError) {
      logger.fatal(
        { event: 'auth.startup_aborted', errorName: error.name },
        error.message
      );
      process.exit(1);
    }
    throw error;
  }
}

export const identityAdapter = buildIdentityAdapter();

// The flag provider extension point: swap this adapter, not the call sites.
// The console stands in for the Pino logger until observability lands.
export const flags = createLocalFlagEvaluator({
  source: env.FEATURE_FLAGS,
  logger: console,
});

export function readContractsStub(): string {
  return CONTRACTS_STUB;
}

if (readContractsStub() !== 'contracts-stub') {
  throw new Error('contracts stub mismatch');
}
