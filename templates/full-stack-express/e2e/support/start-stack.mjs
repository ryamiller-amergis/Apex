import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GenericContainer, Wait } from 'testcontainers';
import { assertDockerAvailable } from '../../scripts/docker-guard.mjs';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..'
);
const apiRoot = path.join(root, 'apps', 'api');
const webDist = path.join(root, 'apps', 'web', 'dist');
const PORT = '4173';
const USER = 'app_user';
const PASSWORD = 'local-dev-only-password';

function runNode(script, env) {
  return spawn(process.execPath, [script], {
    cwd: apiRoot,
    env,
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });
}

function waitForExit(child, label) {
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (status) => {
      if (status === 0) {
        resolve();
        return;
      }
      reject(new Error(`${label} exited ${status}`));
    });
  });
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

async function waitForLive() {
  const url = `http://127.0.0.1:${PORT}/health/live`;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // The API is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`API did not answer ${url}`);
}

const children = [];
let container;

async function shutdown(code) {
  for (const child of children) {
    child.kill('SIGTERM');
  }
  if (container) {
    await container.stop().catch(() => undefined);
  }
  process.exit(code);
}

process.on('SIGTERM', () => {
  void shutdown(0);
});
process.on('SIGINT', () => {
  void shutdown(0);
});

try {
  await assertDockerAvailable('e2e');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if (!(await portFree(Number(PORT)))) {
  process.stderr.write(
    `Port ${PORT} is already in use. Stop that process, then re-run \`pnpm test:e2e\`.\n`
  );
  process.exit(1);
}

container = await new GenericContainer('postgres:16')
  .withEnvironment({
    POSTGRES_USER: USER,
    POSTGRES_PASSWORD: PASSWORD,
    POSTGRES_DB: 'project_db',
  })
  .withExposedPorts(5432)
  .withWaitStrategy(
    Wait.forLogMessage(/database system is ready to accept connections/, 2)
  )
  .start();

const host = container.getHost();
const mapped = container.getMappedPort(5432);
const databaseUrl = `postgresql://${USER}:${PASSWORD}@${host}:${mapped}/project_db`;
const baseEnv = {
  ...process.env,
  NODE_ENV: 'development',
  DATABASE_URL: databaseUrl,
  AUTH_MODE: 'development',
  OTEL_SDK_DISABLED: 'true',
  LOG_LEVEL: 'info',
};

const migrate = runNode(
  path.join(apiRoot, 'src', 'cli', 'migrate.ts'),
  baseEnv
);
children.push(migrate);
await waitForExit(migrate, 'migrate');

const api = runNode(path.join(apiRoot, 'src', 'index.ts'), {
  ...baseEnv,
  PORT,
  CLIENT_DIST_DIR: webDist,
});
children.push(api);
api.on('exit', (status) => {
  if (status !== 0 && status !== null) {
    process.stderr.write(`API exited ${status}\n`);
    void shutdown(status ?? 1);
  }
});
await waitForLive();

await new Promise(() => {
  // Stay up until Playwright stops the webServer process.
});
