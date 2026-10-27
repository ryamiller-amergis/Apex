import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { parseEnv } from '../config/env.ts';
import { createLocalFlagEvaluator } from './index.ts';

const apiRoot = fileURLToPath(new URL('../..', import.meta.url));

const valid = {
  NODE_ENV: 'test',
  DATABASE_URL:
    'postgresql://app_user:local-dev-only-password@localhost:5432/project_db',
  AUTH_MODE: 'development',
};

function runApi(
  extra: Record<string, string>
): Promise<{ status: number | null; output: string }> {
  const env: NodeJS.ProcessEnv = { ...valid, ...extra };
  for (const key of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP']) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
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

describe('FEATURE_FLAGS configuration', () => {
  it.each([
    ['absent', undefined, undefined],
    ['empty', '', undefined],
    ['an empty object', '{}', '{}'],
    ['malformed', '{not json', '{not json'],
  ])(
    'VT-09 TBI-019 DoD-1 PBI-016 AC-1 passes environment validation when %s',
    (_label, value, expected) => {
      const env = parseEnv({ ...valid, FEATURE_FLAGS: value });
      expect(env.FEATURE_FLAGS).toBe(expected);
    }
  );

  it('VT-09 TBI-019 DoD-1 the local adapter reads its values from typed configuration', () => {
    const env = parseEnv({
      ...valid,
      FEATURE_FLAGS: '{"checkout-v2":true,"beta-banner":false}',
    });
    const flags = createLocalFlagEvaluator({
      source: env.FEATURE_FLAGS,
      logger: { warn: vi.fn() },
    });
    expect(flags.isEnabled('checkout-v2', false)).toBe(true);
    expect(flags.isEnabled('beta-banner', true)).toBe(false);
  });

  it('VT-09 PBI-016 AC-1 the API starts with a malformed value and logs one redacted warning', async () => {
    const raw = '{"alice@example.test":true';
    const result = await runApi({ FEATURE_FLAGS: raw });
    expect(result.status).toBe(0);
    expect(result.output).not.toContain('Invalid environment configuration');
    expect(result.output.match(/feature_flags\.config_invalid/g)).toHaveLength(
      1
    );
    expect(result.output).toContain('FEATURE_FLAGS');
    expect(result.output).not.toContain('alice');
    expect(result.output).not.toContain(raw);
  }, 20000);

  it('VT-09 PBI-016 AC-2 the API starts silently with a valid value', async () => {
    const result = await runApi({ FEATURE_FLAGS: '{"checkout-v2":true}' });
    expect(result.status).toBe(0);
    expect(result.output).not.toContain('feature_flags.config_invalid');
  }, 20000);
});
