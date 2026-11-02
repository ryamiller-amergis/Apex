import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WEB_ENV_KEYS } from './webEnvSchema';

const webRoot = fileURLToPath(new URL('../..', import.meta.url));
const templateRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const viteBin = fileURLToPath(
  new URL('../../node_modules/vite/bin/vite.js', import.meta.url)
);

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

function runVite(
  env: NodeJS.ProcessEnv
): Promise<{ status: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [viteBin, 'build'], {
      cwd: webRoot,
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
      reject(new Error(`vite build timed out\n${output}`));
    }, 60000);
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

function readDist(dir: string): string {
  let text = '';
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      text += readDist(full);
      continue;
    }
    if (statSync(full).size > 2_000_000) {
      continue;
    }
    text += readFileSync(full);
  }
  return text;
}

function readExampleKeys(): string[] {
  const text = readFileSync(path.join(templateRoot, '.env.example'), 'utf8');
  const keys: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    const eq = trimmed.indexOf('=');
    keys.push(trimmed.slice(0, eq).trim());
  }
  return keys;
}

describe('web build environment', () => {
  it('VT-09 TBI-004 DoD-2 stops the build when a VITE_ variable is invalid', async () => {
    const sentinel = 'SENTINEL_VALUE_123';
    const result = await runVite({
      ...baseEnv(),
      VITE_API_BASE_URL: `https://${sentinel}.example/`,
    });
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('VITE_API_BASE_URL');
    expect(result.output).not.toContain(sentinel);
  }, 70000);

  it('VT-09 keeps a server secret out of the web bundle', async () => {
    const sentinel = 'SENTINEL_VALUE_123';
    const dist = path.join(webRoot, 'dist');
    rmSync(dist, { recursive: true, force: true });
    const result = await runVite({
      ...baseEnv(),
      VITE_APP_NAME: 'project-name',
      VITE_API_BASE_URL: '',
      DATABASE_URL: `postgresql://app_user:${sentinel}@localhost:5432/project_db`,
    });
    expect(result.status).toBe(0);
    expect(readDist(dist)).not.toContain(sentinel);
    rmSync(dist, { recursive: true, force: true });
  }, 70000);
});

describe('example file web parity', () => {
  it('VT-11 TBI-004 DoD-1 lists each VITE_ variable once', () => {
    const viteKeys = readExampleKeys().filter((key) => key.startsWith('VITE_'));
    expect(new Set(viteKeys).size).toBe(viteKeys.length);
    expect(viteKeys.sort()).toEqual([...WEB_ENV_KEYS].sort());
  });
});
