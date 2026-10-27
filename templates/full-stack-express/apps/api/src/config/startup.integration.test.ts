import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  baseEnv,
  gracefulExitCode,
  runApi,
} from '../../test/support/apiProcess.ts';
import { API_ENV_KEYS } from './env.ts';

const templateRoot = new URL('../../../../', import.meta.url);

function readExampleKeys(): string[] {
  const text = readFileSync(new URL('.env.example', templateRoot), 'utf8');
  const keys: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    const eq = trimmed.indexOf('=');
    if (eq === -1) {
      throw new Error(`Unparsed environment line: ${trimmed}`);
    }
    keys.push(trimmed.slice(0, eq).trim());
  }
  return keys;
}

describe('API startup', () => {
  it('VT-07 PBI-002 AC-1 TBI-004 DoD-0 aborts when required variables are missing', async () => {
    const result = await runApi(baseEnv());
    expect(result.status).toBe(1);
    expect(result.output).toContain('NODE_ENV: required but not set');
    expect(result.output).toContain('DATABASE_URL: required but not set');
    expect(result.output).toContain('AUTH_MODE: required but not set');
    expect(result.output).not.toContain('listening');
  }, 20000);

  it('VT-07 starts listening when the environment is valid and exits 0 on SIGTERM', async () => {
    const result = await runApi({
      ...baseEnv(),
      NODE_ENV: 'test',
      DATABASE_URL:
        'postgresql://app_user:local-dev-only-password@localhost:5432/project_db',
      AUTH_MODE: 'development',
    });
    expect(result.listened).toBe(true);
    expect(result.status).toBe(gracefulExitCode);
    expect(result.output).not.toContain('Invalid environment configuration');
    expect(result.output).toContain('shutdown.complete');
  }, 20000);
});

describe('example file API parity', () => {
  it('VT-10 TBI-004 DoD-1 lists each API variable once', () => {
    const keys = readExampleKeys();
    const apiKeys = keys.filter(
      (key) => !key.startsWith('VITE_') && !key.startsWith('POSTGRES_')
    );
    expect(new Set(apiKeys).size).toBe(apiKeys.length);
    expect(apiKeys.sort()).toEqual([...API_ENV_KEYS].sort());
  });
});
