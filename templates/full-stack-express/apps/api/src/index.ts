// Replaced by FEAT-006 Health and Self-Service Profile API.
import { loadEnv } from './config/env.ts';
import { CONTRACTS_STUB } from '@project-scope/contracts';

loadEnv();

export function readContractsStub(): string {
  return CONTRACTS_STUB;
}

if (readContractsStub() !== 'contracts-stub') {
  throw new Error('contracts stub mismatch');
}
