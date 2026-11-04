import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runContainerBuild } from '../container-build.mjs';
import {
  clientDistDir,
  imageTag,
  listenPort,
  runtimeUserId,
  templateRoot,
} from '../constants.mjs';
import { dockerAvailable } from '../docker.mjs';
import { runCommand } from '../run-command.mjs';

const available = await dockerAvailable();
const skipNote =
  'Docker is not available. Container build and image probes are skipped. Lower-tier Dockerfile and runtime tests cover each criterion.';

if (!available) {
  process.stderr.write(`${skipNote}\n`);
}

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
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 300);
    socket.on('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function docker(args) {
  return runCommand('docker', args, { cwd: templateRoot });
}

async function ensureImage() {
  const built = await runContainerBuild();
  expect(built.exitCode).toBe(0);
  expect(built.lines.join('\n')).toContain(`image ${imageTag}`);
  expect(built.lines.join('\n')).toContain('image size bytes:');
}

describe('production container', () => {
  it.skipIf(!available)(
    'VT-14 PBI-027 AC-0 TBI-032 DoD-0 builds from a frozen install',
    async () => {
      await ensureImage();
      const history = await docker(['history', '--no-trunc', imageTag]);
      expect(history.stdout).toContain('--frozen-lockfile');
    }
  );

  it.skipIf(!available)(
    'VT-15 VT-16 PBI-027 AC-0 TBI-032 DoD-2 serves health, the client, and problem details',
    async () => {
      await ensureImage();
      const { GenericContainer, Network, Wait } =
        await import('testcontainers');
      const network = await new Network().start();
      const password = 'local-dev-only-password';
      const postgres = await new GenericContainer('postgres:16')
        .withNetwork(network)
        .withNetworkAliases('postgres')
        .withEnvironment({
          POSTGRES_USER: 'app_user',
          POSTGRES_PASSWORD: password,
          POSTGRES_DB: 'project_db',
        })
        .withExposedPorts(5432)
        .withWaitStrategy(
          Wait.forLogMessage(
            /database system is ready to accept connections/,
            2
          )
        )
        .start();
      const hostUrl = `postgresql://app_user:${password}@${postgres.getHost()}:${postgres.getMappedPort(5432)}/project_db`;
      const migrated = await runCommand(
        process.execPath,
        [path.join(templateRoot, 'apps', 'api', 'dist', 'cli', 'migrate.js')],
        {
          cwd: path.join(templateRoot, 'apps', 'api'),
          env: {
            ...process.env,
            NODE_ENV: 'production',
            DATABASE_URL: hostUrl,
          },
        }
      );
      expect(migrated.status).toBe(0);
      const api = await new GenericContainer(imageTag)
        .withNetwork(network)
        .withEnvironment({
          NODE_ENV: 'development',
          AUTH_MODE: 'development',
          DATABASE_URL: `postgresql://app_user:${password}@postgres:5432/project_db`,
          PORT: String(listenPort),
          OTEL_SDK_DISABLED: 'true',
        })
        .withExposedPorts(listenPort)
        .withWaitStrategy(
          Wait.forHttp('/health/live', listenPort).forStatusCode(200)
        )
        .start();
      try {
        const base = `http://${api.getHost()}:${api.getMappedPort(listenPort)}`;
        expect((await fetch(`${base}/health/live`)).status).toBe(200);
        expect((await fetch(`${base}/health/ready`)).status).toBe(200);
        const shell = await fetch(`${base}/`);
        const profile = await fetch(`${base}/profile`);
        expect(shell.headers.get('content-type')).toContain('text/html');
        expect(await profile.text()).toContain('<html');
        const unknown = await fetch(`${base}/api/unknown`);
        expect(unknown.status).toBe(404);
        expect(unknown.headers.get('content-type')).toContain(
          'application/problem+json'
        );
        const problem = await unknown.json();
        expect(problem.requestId).toEqual(expect.any(String));
        const me = await fetch(`${base}/api/v1/me`);
        expect(me.headers.get('content-type')).toContain('json');
        expect(me.status).not.toBe(404);
        await postgres.stop();
        const ready = await fetch(`${base}/health/ready`);
        const live = await fetch(`${base}/health/live`);
        expect(ready.status).toBe(503);
        expect(ready.headers.get('content-type')).toContain(
          'application/problem+json'
        );
        expect(live.status).toBe(200);
      } finally {
        await api.stop();
        await postgres.stop().catch(() => undefined);
        await network.stop();
      }
    }
  );

  it.skipIf(!available)(
    'VT-17 PBI-027 AC-1 aborts without required values and hides the sentinel',
    async () => {
      await ensureImage();
      const sentinel = `SENTINEL_${'f'.repeat(20)}`;
      const port = await freePort();
      const child = spawn(
        'docker',
        [
          'run',
          '--rm',
          '-p',
          `${port}:${listenPort}`,
          '-e',
          'NODE_ENV=',
          '-e',
          'AUTH_MODE=',
          '-e',
          `DATABASE_URL=postgresql://app_user:${sentinel}@127.0.0.1:9/project_db`,
          imageTag,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk) => {
        output += chunk.toString('utf8');
      });
      let opened = false;
      const timer = setInterval(async () => {
        if (await probe(port)) {
          opened = true;
        }
      }, 100);
      const status = await new Promise((resolve) => {
        child.on('close', resolve);
      });
      clearInterval(timer);
      expect(status).not.toBe(0);
      expect(output).toContain('AUTH_MODE');
      expect(output).not.toContain(sentinel);
      expect(output).not.toContain('server.listening');
      expect(opened).toBe(false);
    }
  );

  it.skipIf(!available)(
    'VT-18 PBI-027 AC-2 TBI-032 DoD-1 runs as 10001 without build tools',
    async () => {
      await ensureImage();
      const id = await docker([
        'run',
        '--rm',
        '--entrypoint',
        'id',
        imageTag,
        '-u',
      ]);
      expect(id.stdout.trim()).toBe(runtimeUserId);
      const tools = await docker([
        'run',
        '--rm',
        '--entrypoint',
        'sh',
        imageTag,
        '-c',
        "for tool in npm npx pnpm corepack yarn gcc make; do command -v \"$tool\" && exit 1; done; node -e \"const fs=require('fs'); for (const name of ['vitest','typescript','drizzle-kit']) { if (fs.existsSync('node_modules/'+name)) process.exit(1); }\"",
      ]);
      expect(tools.status).toBe(0);
    }
  );

  it.skipIf(!available)(
    'VT-19 PBI-027 AC-3 development mode in production does not serve',
    async () => {
      await ensureImage();
      const port = await freePort();
      const child = spawn(
        'docker',
        [
          'run',
          '--rm',
          '-p',
          `${port}:${listenPort}`,
          '-e',
          'NODE_ENV=production',
          '-e',
          'AUTH_MODE=development',
          '-e',
          'DATABASE_URL=postgresql://app_user:local-dev-only-password@127.0.0.1:9/project_db',
          imageTag,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk) => {
        output += chunk.toString('utf8');
      });
      let opened = false;
      const started = Date.now();
      const timer = setInterval(async () => {
        if (await probe(port)) {
          opened = true;
        }
      }, 100);
      const status = await new Promise((resolve) => {
        child.on('close', resolve);
      });
      clearInterval(timer);
      expect(status).not.toBe(0);
      expect(output).toMatch(
        /development is not allowed when NODE_ENV is production/
      );
      expect(opened).toBe(false);
      expect(Date.now() - started).toBeLessThan(10000);
    }
  );

  it.skipIf(!available)(
    'VT-21 TBI-032 the image env has no baked secrets or env files',
    async () => {
      await ensureImage();
      const inspected = await docker([
        'image',
        'inspect',
        imageTag,
        '--format',
        '{{json .Config.Env}}',
      ]);
      const entries = JSON.parse(inspected.stdout);
      const keys = entries.map((entry) => entry.split('=')[0]);
      const allowed = new Set([
        'PATH',
        'NODE_VERSION',
        'YARN_VERSION',
        'NODE_ENV',
        'CLIENT_DIST_DIR',
      ]);
      expect(keys.filter((key) => !allowed.has(key))).toEqual([]);
      expect(entries).toContain('NODE_ENV=production');
      expect(entries).toContain(`CLIENT_DIST_DIR=${clientDistDir}`);
      const files = await docker([
        'run',
        '--rm',
        '--entrypoint',
        'node',
        imageTag,
        '-e',
        "const fs=require('fs');const path=require('path');const seen=new Set();function walk(dir){let found=[];let names;try{names=fs.readdirSync(dir);}catch{return found;}for (const name of names){if(name==='proc'||name==='sys'||name==='dev')continue;const full=path.join(dir,name);let st;try{st=fs.lstatSync(full);}catch{continue;}if(st.isSymbolicLink())continue;if(st.isDirectory()){if(seen.has(full))continue;seen.add(full);found=found.concat(walk(full));}else if(name.startsWith('.env'))found.push(full);}return found;}const found=walk('/');if(found.length){console.log(found.join('\\n'));process.exit(1);}",
      ]);
      expect(files.status).toBe(0);
    }
  );

  it.skipIf(!available)(
    'VT-22 PBI-027 AC-2 answers liveness with a read-only root and no capabilities',
    async () => {
      await ensureImage();
      const port = await freePort();
      const name = `supply-chain-live-${port}`;
      const child = spawn(
        'docker',
        [
          'run',
          '--rm',
          '--name',
          name,
          '--read-only',
          '--cap-drop',
          'ALL',
          '--tmpfs',
          '/tmp',
          '-p',
          `${port}:${listenPort}`,
          '-e',
          'NODE_ENV=development',
          '-e',
          'AUTH_MODE=development',
          '-e',
          'DATABASE_URL=postgresql://app_user:local-dev-only-password@127.0.0.1:1/project_db',
          '-e',
          'OTEL_SDK_DISABLED=true',
          imageTag,
        ],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      );
      try {
        let live;
        for (let attempt = 0; attempt < 50; attempt += 1) {
          try {
            live = await fetch(`http://127.0.0.1:${port}/health/live`);
            if (live.ok) {
              break;
            }
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 200));
          }
        }
        expect(live?.ok).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 10000));
        expect(child.exitCode).toBeNull();
        const again = await fetch(`http://127.0.0.1:${port}/health/live`);
        expect(again.status).toBe(200);
      } finally {
        await docker(['rm', '-f', name]);
      }
    }
  );
});
