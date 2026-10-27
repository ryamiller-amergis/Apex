import { describe, expect, it, vi } from 'vitest';
import type { DatabaseEnvResult } from '../config/env.ts';
import {
  PersistenceError,
  PersistenceUnavailableError,
  SchemaNotMigratedError,
} from '../persistence/index.ts';
import { createBufferOutput } from './output.ts';
import { seedCommand, type SeedCommandDeps } from './seed.ts';

const DATABASE_URL =
  'postgresql://app_user:local-dev-only-password@localhost:5432/project_db';

function setup(
  env: DatabaseEnvResult,
  seed: SeedCommandDeps['seed'] = async () => ({ created: 3, existing: 0 })
) {
  const output = createBufferOutput();
  const close = vi.fn(async () => {});
  const open = vi.fn(() => ({ users: {} as never, close }));
  const deps: SeedCommandDeps = { env, output, open, seed };
  return { deps, output, open, close };
}

const development: DatabaseEnvResult = {
  ok: true,
  env: { NODE_ENV: 'development', DATABASE_URL },
};

describe('seedCommand', () => {
  it('PBI-005 AC-0 reports new rows and exits 0', async () => {
    const { deps, output, close } = setup(development);
    expect(await seedCommand(deps)).toBe(0);
    expect(output.lines.stdout).toEqual([
      'Seeded 3 new rows; 0 already present.',
    ]);
    expect(close).toHaveBeenCalledOnce();
  });

  it('PBI-005 AC-2 reports existing rows on a second run and exits 0', async () => {
    const { deps, output } = setup(development, async () => ({
      created: 0,
      existing: 3,
    }));
    expect(await seedCommand(deps)).toBe(0);
    expect(output.lines.stdout).toEqual([
      'Seeded 0 new rows; 3 already present.',
    ]);
  });

  it('TBI-008 DoD-2 PBI-005 AC-3 refuses in production before opening a connection', async () => {
    const { deps, output, open } = setup({
      ok: true,
      env: { NODE_ENV: 'production', DATABASE_URL },
    });
    expect(await seedCommand(deps)).toBe(1);
    expect(open).not.toHaveBeenCalled();
    expect(output.lines.stderr).toEqual([
      'Refusing to seed: NODE_ENV is production. Seeding never runs in production.',
    ]);
    expect(output.lines.stdout).toEqual([]);
  });

  it('PBI-005 AC-1 tells the developer to migrate first', async () => {
    const { deps, output, close } = setup(development, async () => {
      throw new SchemaNotMigratedError({ sqlState: '42P01' });
    });
    expect(await seedCommand(deps)).toBe(1);
    expect(output.lines.stderr).toEqual([
      'The app_users table does not exist. Run "pnpm migrate" first.',
    ]);
    expect(close).toHaveBeenCalledOnce();
  });

  it('exits 1 when the database is unreachable', async () => {
    const { deps, output } = setup(development, async () => {
      throw new PersistenceUnavailableError();
    });
    expect(await seedCommand(deps)).toBe(1);
    expect(output.lines.stderr).toEqual([
      'Cannot connect to the database. Check DATABASE_URL and that PostgreSQL is running.',
    ]);
  });

  it('exits 1 with the SQLSTATE of another database error', async () => {
    const { deps, output } = setup(development, async () => {
      throw new PersistenceError({ sqlState: '42501' });
    });
    expect(await seedCommand(deps)).toBe(1);
    expect(output.lines.stderr).toEqual(['Seed failed: SQLSTATE 42501.']);
  });

  it('exits 2 for invalid configuration before opening a connection', async () => {
    const { deps, output, open } = setup({
      ok: false,
      problems: [{ name: 'DATABASE_URL', reason: 'missing' }],
    });
    expect(await seedCommand(deps)).toBe(2);
    expect(open).not.toHaveBeenCalled();
    expect(output.lines.stderr).toEqual([
      'Configuration error: DATABASE_URL is missing.',
    ]);
  });
});
