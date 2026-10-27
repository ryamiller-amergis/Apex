import type { DatabaseEnvProblem } from '../config/env.ts';

// The commands run outside the API's logger setup, so they write plain lines.
// No line may contain a connection URL, a password, or an identity value.

export const ExitCode = {
  success: 0,
  failure: 1,
  configuration: 2,
} as const;

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export interface Output {
  stdout(line: string): void;
  stderr(line: string): void;
}

export const processOutput: Output = {
  stdout(line) {
    process.stdout.write(`${line}\n`);
  },
  stderr(line) {
    process.stderr.write(`${line}\n`);
  },
};

export interface BufferOutput extends Output {
  lines: { stdout: string[]; stderr: string[] };
}

export function createBufferOutput(): BufferOutput {
  const lines = { stdout: [] as string[], stderr: [] as string[] };
  return {
    lines,
    stdout(line) {
      lines.stdout.push(line);
    },
    stderr(line) {
      lines.stderr.push(line);
    },
  };
}

const INVALID_REASON: Record<DatabaseEnvProblem['name'], string> = {
  DATABASE_URL: 'is not a valid PostgreSQL connection URL',
  NODE_ENV: 'must be development, test, or production',
};

export function describeConfigProblems(
  problems: readonly DatabaseEnvProblem[]
): string[] {
  return problems.map(({ name, reason }) =>
    reason === 'missing'
      ? `Configuration error: ${name} is missing.`
      : `Configuration error: ${name} ${INVALID_REASON[name]}.`
  );
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function formatMigrationsApplied(tags: readonly string[]): string {
  if (tags.length === 0) {
    return 'No pending migrations.';
  }
  return `Applied ${plural(tags.length, 'migration')}: ${tags.join(', ')}`;
}

export function formatMigrationFailure(
  tag: string,
  sqlState: string,
  message: string
): string {
  return `Migration ${tag} failed: ${sqlState} ${message}`;
}

export function formatSeedResult(created: number, existing: number): string {
  return `Seeded ${plural(created, 'new row')}; ${existing} already present.`;
}

export const DATABASE_UNAVAILABLE_MESSAGE =
  'Cannot connect to the database. Check DATABASE_URL and that PostgreSQL is running.';
export const SCHEMA_NOT_MIGRATED_MESSAGE =
  'The app_users table does not exist. Run "pnpm migrate" first.';
export const SEED_PRODUCTION_MESSAGE =
  'Refusing to seed: NODE_ENV is production. Seeding never runs in production.';
