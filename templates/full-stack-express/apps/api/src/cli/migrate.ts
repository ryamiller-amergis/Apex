// Standalone migration command. Platform Engineering runs it before traffic
// switches: `pnpm migrate` in a checkout, `node dist/cli/migrate.js` in an image.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readDatabaseEnv, type DatabaseEnvResult } from '../config/env.ts';
import {
  PersistenceError,
  PersistenceUnavailableError,
} from '../persistence/index.ts';
import {
  MigrationFailedError,
  MigrationsFolderError,
  runMigrations,
} from '../persistence/migrations/runMigrations.ts';
import {
  DATABASE_UNAVAILABLE_MESSAGE,
  describeConfigProblems,
  ExitCode,
  formatMigrationFailure,
  formatMigrationsApplied,
  processOutput,
  type ExitCodeValue,
  type Output,
} from './output.ts';

const USAGE = 'Usage: migrate [--migrations <folder>]';

export interface MigrateCommandDeps {
  env: DatabaseEnvResult;
  output: Output;
  run: typeof runMigrations;
  defaultMigrationsFolder: string;
}

function parseArgs(
  argv: readonly string[],
  defaultFolder: string
): string | null {
  if (argv.length === 0) {
    return defaultFolder;
  }
  if (argv.length === 2 && argv[0] === '--migrations' && argv[1]) {
    return path.resolve(argv[1]);
  }
  return null;
}

export async function migrateCommand(
  argv: readonly string[],
  deps: MigrateCommandDeps
): Promise<ExitCodeValue> {
  const { output } = deps;
  const migrationsFolder = parseArgs(argv, deps.defaultMigrationsFolder);
  if (migrationsFolder === null) {
    output.stderr(USAGE);
    return ExitCode.configuration;
  }
  if (!deps.env.ok) {
    for (const line of describeConfigProblems(deps.env.problems)) {
      output.stderr(line);
    }
    return ExitCode.configuration;
  }

  try {
    const { applied } = await deps.run({
      databaseUrl: deps.env.env.DATABASE_URL,
      migrationsFolder,
    });
    output.stdout(formatMigrationsApplied(applied));
    return ExitCode.success;
  } catch (error) {
    if (error instanceof MigrationFailedError) {
      output.stderr(
        formatMigrationFailure(error.tag, error.sqlState, error.reason)
      );
    } else if (error instanceof PersistenceUnavailableError) {
      output.stderr(DATABASE_UNAVAILABLE_MESSAGE);
    } else if (error instanceof MigrationsFolderError) {
      output.stderr(error.message);
    } else if (error instanceof PersistenceError && error.sqlState) {
      output.stderr(`Migration run failed: SQLSTATE ${error.sqlState}.`);
    } else {
      output.stderr('Migration run failed.');
    }
    return ExitCode.failure;
  }
}

if (import.meta.main) {
  process.exitCode = await migrateCommand(process.argv.slice(2), {
    env: readDatabaseEnv(),
    output: processOutput,
    run: runMigrations,
    defaultMigrationsFolder: fileURLToPath(
      new URL('../../drizzle', import.meta.url)
    ),
  });
}
