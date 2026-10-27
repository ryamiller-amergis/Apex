import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { API_ENV_KEYS } from './env.ts';

const apiRoot = fileURLToPath(new URL('../..', import.meta.url));
const templateRoot = new URL('../../../../', import.meta.url);

function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'Path',
    'SystemRoot',
    'PATHEXT',
    'COMSPEC',
    'TEMP',
    'TMP',
    'USERPROFILE',
  ]) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

function runApi(
  env: NodeJS.ProcessEnv
): Promise<{ status: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/index.ts'], {
      cwd: apiRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`API process timed out\n${output}`));
    }, 15000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, output });
    });
  });
}

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

  it('VT-07 exits 0 when the environment is valid and the entry is still a stub', async () => {
    const result = await runApi({
      ...baseEnv(),
      NODE_ENV: 'test',
      DATABASE_URL:
        'postgresql://app_user:local-dev-only-password@localhost:5432/project_db',
      AUTH_MODE: 'development',
    });
    expect(result.status).toBe(0);
    expect(result.output).not.toContain('Invalid environment configuration');
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
