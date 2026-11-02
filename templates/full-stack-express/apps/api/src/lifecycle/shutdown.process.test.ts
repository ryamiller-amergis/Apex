import { spawn, type ChildProcess } from 'node:child_process';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { connect, type Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const apiRoot = fileURLToPath(new URL('../..', import.meta.url));
const MARKER = 'process.marker.9z1@example.test';

interface Fixture {
  child: ChildProcess;
  port: number;
  stdout: () => string;
  lines: () => Record<string, unknown>[];
  exited: Promise<{ code: number | null; at: number }>;
}

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }
});

function baseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP']) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

function parseLines(text: string): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) {
      continue;
    }
    try {
      lines.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // Console span output is not JSON.
    }
  }
  return lines;
}

async function startFixture(
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<Fixture> {
  const child = spawn(
    process.execPath,
    ['--import', './src/instrument.ts', 'src/lifecycle/shutdown.fixture.ts'],
    {
      cwd: apiRoot,
      env: {
        ...baseEnv(),
        NODE_ENV: 'test',
        DATABASE_URL:
          'postgresql://app_user:local-dev-only-password@localhost:5432/project_db',
        AUTH_MODE: 'development',
        LOG_LEVEL: 'info',
        SHUTDOWN_TIMEOUT_MS: '1500',
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  children.push(child);
  let out = '';
  let err = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    out += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    err += chunk.toString();
  });
  const exited = new Promise<{ code: number | null; at: number }>((resolve) => {
    child.on('exit', (code) => resolve({ code, at: Date.now() }));
  });
  const deadline = Date.now() + 10000;
  for (;;) {
    const listening = parseLines(out).find(
      (line) => line.msg === 'fixture.listening'
    );
    if (listening) {
      return {
        child,
        port: listening.port as number,
        stdout: () => out,
        lines: () => parseLines(out),
        exited,
      };
    }
    if (Date.now() > deadline || child.exitCode !== null) {
      throw new Error(`fixture did not start\n${out}\n${err}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function get(
  port: number,
  path: string,
  headers: Record<string, string> = {}
): Promise<IncomingMessage & { body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, headers, agent: false },
      (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString();
        });
        res.on('end', () => resolve(Object.assign(res, { body })));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tryConnect(port: number): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.on('connect', () => {
      socket.destroy();
      resolve('connected');
    });
    socket.on('error', (error: NodeJS.ErrnoException) => {
      resolve(error.code ?? 'error');
    });
  });
}

function readRaw(socket: Socket): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    socket.on('data', (chunk: Buffer) => {
      data += chunk.toString();
    });
    socket.on('close', () => resolve(data));
  });
}

describe.skipIf(process.platform === 'win32')('process shutdown', () => {
  it('VT-22 PBI-015 AC-0 TBI-018 DoD-0 finishes an in-flight request, then exits 0', async () => {
    const fixture = await startFixture();
    const response = get(fixture.port, '/slow?ms=500');
    await delay(100);
    fixture.child.kill('SIGTERM');
    const res = await response;
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    const { code } = await fixture.exited;
    expect(code).toBe(0);
    const complete = fixture.lines().find((l) => l.msg === 'shutdown.complete');
    expect(complete).toMatchObject({ forced: false, exitCode: 0 });
  }, 15000);

  it('VT-23 PBI-015 AC-1 TBI-018 DoD-3 exits 1 within the limit and logs the abandoned request', async () => {
    const fixture = await startFixture();
    const response = get(fixture.port, `/hang?email=${MARKER}`, {
      'X-User-Email': MARKER,
    }).catch(() => undefined);
    await delay(100);
    const signalledAt = Date.now();
    fixture.child.kill('SIGTERM');
    const { code, at } = await fixture.exited;
    await response;
    expect(code).toBe(1);
    expect(at - signalledAt).toBeLessThan(2500);
    const abandoned = fixture
      .lines()
      .filter((l) => l.msg === 'shutdown.abandoned');
    expect(abandoned).toHaveLength(1);
    expect(abandoned[0]).toMatchObject({
      level: 'warn',
      abandonedCount: 1,
      abandoned: [
        {
          requestId: expect.any(String),
          method: 'GET',
          route: '/hang',
          ageMs: expect.any(Number),
        },
      ],
    });
    expect(fixture.stdout()).not.toContain(MARKER);
  }, 15000);

  it('VT-24 PBI-015 AC-2 TBI-017 DoD-2 exits 0 promptly when idle, after the database closes', async () => {
    const fixture = await startFixture();
    const ready = await get(fixture.port, '/probe');
    expect(ready.statusCode).toBe(200);
    const signalledAt = Date.now();
    fixture.child.kill('SIGTERM');
    const { code, at } = await fixture.exited;
    expect(code).toBe(0);
    expect(at - signalledAt).toBeLessThan(1000);
    const messages = fixture.lines().map((l) => l.msg);
    expect(messages).toContain('telemetry.disabled');
    expect(messages.indexOf('database.closed')).toBeGreaterThan(-1);
    expect(messages.indexOf('database.closed')).toBeLessThan(
      messages.indexOf('shutdown.complete')
    );
  }, 15000);

  it('VT-25 PBI-015 AC-3 TBI-018 DoD-1 refuses new connections and reports not ready on an open connection', async () => {
    const fixture = await startFixture();
    const slow = get(fixture.port, '/slow?ms=800');
    // A request already being received keeps its connection out of
    // closeIdleConnections, the way a probe in flight would.
    const open = connect(fixture.port, '127.0.0.1');
    await new Promise((resolve) => open.once('connect', resolve));
    const raw = readRaw(open);
    open.write('GET /probe HTTP/1.1\r\nHost: fixture\r\n');
    await delay(100);
    fixture.child.kill('SIGTERM');
    await delay(100);
    expect(await tryConnect(fixture.port)).toBe('ECONNREFUSED');
    open.write('\r\n');
    const response = await raw;
    expect(response).toMatch(/^HTTP\/1\.1 503/);
    expect(response.toLowerCase()).toContain('connection: close');
    expect(response).toContain('"status":"not_ready"');
    expect((await slow).statusCode).toBe(200);
    const { code } = await fixture.exited;
    expect(code).toBe(0);
  }, 15000);

  it('TBI-017 DoD-0 TBI-018 DoD-2 the --import entry instruments Express and flushes spans before exit', async () => {
    const fixture = await startFixture({ OTEL_TRACES_EXPORTER: 'console' });
    expect((await get(fixture.port, '/slow?ms=10')).statusCode).toBe(200);
    expect(fixture.stdout()).not.toContain('instrumentation-express');
    fixture.child.kill('SIGTERM');
    const { code } = await fixture.exited;
    expect(code).toBe(0);
    const out = fixture.stdout();
    expect(out).toContain("name: '@opentelemetry/instrumentation-express'");
    expect(out).toContain("'http.route': '/slow'");
    expect(
      fixture.lines().find((l) => l.msg === 'telemetry.started')
    ).toMatchObject({ traces: 'console', metrics: 'none' });
  }, 15000);
});
