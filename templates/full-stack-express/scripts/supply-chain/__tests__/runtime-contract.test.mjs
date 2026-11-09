import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { templateRoot } from '../constants.mjs';
import { runCommand } from '../run-command.mjs';

const apiRoot = path.join(templateRoot, 'apps', 'api');
const entry = path.join(apiRoot, 'dist', 'index.js');
const instrument = path.join(apiRoot, 'dist', 'instrument.js');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function probe(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
  });
}

function startApi(env) {
  return runCommand(
    process.execPath,
    ['--import', pathToFileURL(instrument).href, entry],
    {
      cwd: apiRoot,
      env,
    }
  );
}

describe('running API the image starts', () => {
  it('PBI-027 AC-0 AC-1 VT-16 serves live, the client shell, and a problem 404', async () => {
    const port = await freePort();
    const clientDir = await mkdtemp(path.join(tmpdir(), 'client-dist-'));
    const marker = 'web-client-shell';
    await writeFile(
      path.join(clientDir, 'index.html'),
      `<!doctype html><title>${marker}</title>\n`,
      'utf8'
    );
    const env = {
      ...process.env,
      NODE_ENV: 'development',
      AUTH_MODE: 'development',
      DATABASE_URL:
        'postgresql://app_user:local-dev-only-password@127.0.0.1:1/project_db',
      PORT: String(port),
      CLIENT_DIST_DIR: clientDir,
      OTEL_SDK_DISABLED: 'true',
      READINESS_TIMEOUT_MS: '500',
    };
    const { spawn } = await import('node:child_process');
    const child = spawn(
      process.execPath,
      ['--import', pathToFileURL(instrument).href, entry],
      {
        cwd: apiRoot,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString('utf8');
    });
    try {
      let live;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        if (child.exitCode !== null) {
          throw new Error(`API exited ${child.exitCode}: ${output}`);
        }
        try {
          live = await fetch(`http://127.0.0.1:${port}/health/live`);
          if (live.ok) {
            break;
          }
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      expect(live?.ok).toBe(true);
      const ready = await fetch(`http://127.0.0.1:${port}/health/ready`);
      expect(ready.status).toBe(503);
      expect(ready.headers.get('content-type')).toContain(
        'application/problem+json'
      );
      const root = await fetch(`http://127.0.0.1:${port}/`);
      const profile = await fetch(`http://127.0.0.1:${port}/profile`);
      expect(await root.text()).toContain(marker);
      expect(await profile.text()).toContain(marker);
      const unknown = await fetch(`http://127.0.0.1:${port}/api/unknown`);
      expect(unknown.status).toBe(404);
      expect(unknown.headers.get('content-type')).toContain(
        'application/problem+json'
      );
      const problem = await unknown.json();
      expect(problem.requestId).toEqual(expect.any(String));
      expect(problem.requestId).not.toBe('');
      const liveAgain = await fetch(`http://127.0.0.1:${port}/health/live`);
      expect(liveAgain.status).toBe(200);
    } finally {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 5000);
        child.on('close', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      await rm(clientDir, { recursive: true, force: true });
    }
  });

  it('PBI-027 AC-1 VT-17 names a missing variable and hides the sentinel', async () => {
    const sentinel = `SENTINEL_${'d'.repeat(20)}`;
    const port = await freePort();
    const env = {
      ...process.env,
      NODE_ENV: '',
      AUTH_MODE: '',
      DATABASE_URL: `postgresql://app_user:${sentinel}@127.0.0.1:9/project_db`,
      PORT: String(port),
      OTEL_SDK_DISABLED: 'true',
    };
    delete env.AUTH_MODE;
    const result = await startApi(env);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toContain('AUTH_MODE');
    expect(output).toContain('required but not set');
    expect(output).not.toContain(sentinel);
    expect(output).not.toContain('server.listening');
    expect(await probe(port)).toBe(false);
  });

  it('PBI-027 AC-3 VT-19 development mode in production aborts before listen', async () => {
    const sentinel = `SENTINEL_${'e'.repeat(20)}`;
    const port = await freePort();
    const env = {
      ...process.env,
      NODE_ENV: 'production',
      AUTH_MODE: 'development',
      DATABASE_URL: `postgresql://app_user:${sentinel}@127.0.0.1:9/project_db`,
      PORT: String(port),
      OTEL_SDK_DISABLED: 'true',
    };
    const result = await startApi(env);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(result.status).not.toBe(0);
    expect(output).toMatch(
      /development is not allowed when NODE_ENV is production/
    );
    expect(output).not.toContain(sentinel);
    expect(output).not.toContain('server.listening');
    expect(await probe(port)).toBe(false);
  });
});
