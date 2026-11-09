// Local seed command. Inserts synthetic app_users rows; refuses to run when
// NODE_ENV is production, before any connection is opened.
import { readDatabaseEnv, type DatabaseEnvResult } from '../config/env.ts';
import {
  createPersistence,
  PersistenceError,
  PersistenceUnavailableError,
  SchemaNotMigratedError,
  type AppUserStore,
} from '../persistence/index.ts';
import { seedUsers } from '../persistence/seed/seedUsers.ts';
import {
  DATABASE_UNAVAILABLE_MESSAGE,
  describeConfigProblems,
  ExitCode,
  formatSeedResult,
  processOutput,
  SCHEMA_NOT_MIGRATED_MESSAGE,
  SEED_PRODUCTION_MESSAGE,
  type ExitCodeValue,
  type Output,
} from './output.ts';

export interface SeedCommandDeps {
  env: DatabaseEnvResult;
  output: Output;
  open(databaseUrl: string): { users: AppUserStore; close(): Promise<void> };
  seed: typeof seedUsers;
}

function describeFailure(error: unknown): string {
  if (error instanceof SchemaNotMigratedError) {
    return SCHEMA_NOT_MIGRATED_MESSAGE;
  }
  if (error instanceof PersistenceUnavailableError) {
    return DATABASE_UNAVAILABLE_MESSAGE;
  }
  if (error instanceof PersistenceError && error.sqlState) {
    return `Seed failed: SQLSTATE ${error.sqlState}.`;
  }
  return 'Seed failed.';
}

export async function seedCommand(
  deps: SeedCommandDeps
): Promise<ExitCodeValue> {
  const { output } = deps;
  if (!deps.env.ok) {
    for (const line of describeConfigProblems(deps.env.problems)) {
      output.stderr(line);
    }
    return ExitCode.configuration;
  }
  if (deps.env.env.NODE_ENV === 'production') {
    output.stderr(SEED_PRODUCTION_MESSAGE);
    return ExitCode.failure;
  }

  const persistence = deps.open(deps.env.env.DATABASE_URL);
  try {
    const result = await deps.seed(persistence.users);
    output.stdout(formatSeedResult(result.created, result.existing));
    return ExitCode.success;
  } catch (error) {
    output.stderr(describeFailure(error));
    return ExitCode.failure;
  } finally {
    await persistence.close();
  }
}

if (import.meta.main) {
  process.exitCode = await seedCommand({
    env: readDatabaseEnv(),
    output: processOutput,
    open: (databaseUrl) => createPersistence({ databaseUrl }),
    seed: seedUsers,
  });
}
