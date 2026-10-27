import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import {
  GenericContainer,
  getContainerRuntimeClient,
  Wait,
  type StartedTestContainer,
} from 'testcontainers';
import { runMigrations } from '../../src/persistence/migrations/runMigrations.ts';

export const apiRoot = fileURLToPath(new URL('../..', import.meta.url));
export const committedMigrations = fileURLToPath(
  new URL('../../drizzle', import.meta.url)
);

const IMAGE = 'postgres:16';
const USER = 'app_user';
const PASSWORD = 'local-dev-only-password';

export const DOCKER_SKIP_NOTE =
  '(skipped: Docker is not available, so no real PostgreSQL)';

let dockerCheck: Promise<boolean> | undefined;

export function isDockerAvailable(): Promise<boolean> {
  dockerCheck ??= getContainerRuntimeClient().then(
    () => true,
    () => {
      console.warn(
        'Docker is not available. PostgreSQL integration tests in this file are skipped.'
      );
      return false;
    }
  );
  return dockerCheck;
}

export interface TestDatabase {
  url: string;
  query<Row extends pg.QueryResultRow>(
    text: string,
    values?: unknown[]
  ): Promise<Row[]>;
  drop(): Promise<void>;
}

export interface TestDatabaseServer {
  createDatabase(options?: { migrated?: boolean }): Promise<TestDatabase>;
  stop(): Promise<void>;
}

function urlFor(container: StartedTestContainer, database: string): string {
  const host = container.getHost();
  const port = container.getMappedPort(5432);
  return `postgresql://${USER}:${PASSWORD}@${host}:${port}/${database}`;
}

async function withClient<T>(
  url: string,
  use: (client: pg.Client) => Promise<T>
): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await use(client);
  } finally {
    await client.end();
  }
}

// One container per test file, one fresh database per createDatabase call.
// Each database is dropped on teardown, so no state is shared between tests.
export async function startTestDatabaseServer(): Promise<TestDatabaseServer> {
  const container = await new GenericContainer(IMAGE)
    .withEnvironment({
      POSTGRES_USER: USER,
      POSTGRES_PASSWORD: PASSWORD,
      POSTGRES_DB: 'postgres',
    })
    .withExposedPorts(5432)
    .withWaitStrategy(
      Wait.forLogMessage(/database system is ready to accept connections/, 2)
    )
    .start();
  const adminUrl = urlFor(container, 'postgres');

  return {
    async createDatabase(options = {}) {
      const name = `test_${randomUUID().replaceAll('-', '')}`;
      await withClient(adminUrl, (client) =>
        client.query(`create database "${name}"`)
      );
      const url = urlFor(container, name);
      if (options.migrated) {
        await runMigrations({
          databaseUrl: url,
          migrationsFolder: committedMigrations,
        });
      }
      return {
        url,
        query: (text, values) =>
          withClient(url, async (client) => {
            const result = await client.query(text, values);
            return result.rows;
          }),
        drop: () =>
          withClient(adminUrl, (client) =>
            client.query(`drop database if exists "${name}" with (force)`)
          ).then(() => undefined),
      };
    },
    async stop() {
      await container.stop();
    },
  };
}

export const CLOSED_PORT_URL =
  'postgresql://app_user:local-dev-only-password@127.0.0.1:1/project_db';

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

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// Runs a CLI entry under src/cli with only the variables a test sets.
export function runCli(
  script: 'migrate' | 'seed',
  env: Record<string, string | undefined>,
  args: readonly string[] = []
): Promise<CommandResult> {
  const childEnv: NodeJS.ProcessEnv = {};
  for (const key of PASS_THROUGH) {
    const value = process.env[key];
    if (value !== undefined) {
      childEnv[key] = value;
    }
  }
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      childEnv[key] = value;
    }
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [`src/cli/${script}.ts`, ...args], {
      cwd: apiRoot,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${script} timed out\n${stdout}${stderr}`));
    }, 30000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}
