// Replaced by FEAT-006 Health and Self-Service Profile API.
import { loadEnv } from './config/env.ts';
import { createLocalFlagEvaluator } from './feature-flags/index.ts';
import { CONTRACTS_STUB } from '@project-scope/contracts';

const env = loadEnv();

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
