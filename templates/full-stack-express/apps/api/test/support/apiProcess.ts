import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

export const apiRoot = fileURLToPath(new URL('../..', import.meta.url));

const LISTENING = '"event":"server.listening"';
const PASS_THROUGH = [
  'PATH',
  'Path',
  'SystemRoot',
  'PATHEXT',
  'COMSPEC',
  'TEMP',
  'TMP',
  'USERPROFILE',
];

/** Only the variables a child needs to start Node, so tests set the rest. */
export function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of PASS_THROUGH) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export interface ApiRunResult {
  /** Exit code; null when the platform ended the process without one. */
  status: number | null;
  output: string;
  /** True when the API logged server.listening before it exited. */
  listened: boolean;
}

/**
 * Runs src/index.ts with exactly `env`. When the API starts listening the
 * helper sends SIGTERM, so a healthy start ends through graceful shutdown. A
 * free PORT is chosen when `env` sets none.
 */
export async function runApi(env: NodeJS.ProcessEnv): Promise<ApiRunResult> {
  const childEnv = { ...env };
  childEnv.PORT ??= String(await freePort());
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/index.ts'], {
      cwd: apiRoot,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let output = '';
    let listened = false;
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (!listened && output.includes(LISTENING)) {
        listened = true;
        child.kill('SIGTERM');
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`API process timed out\n${output}`));
    }, 15000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, output, listened });
    });
  });
}

/**
 * Windows has no SIGTERM: kill() ends the process at once, with no exit code.
 * Elsewhere a graceful shutdown exits 0.
 */
export const gracefulExitCode = process.platform === 'win32' ? null : 0;
