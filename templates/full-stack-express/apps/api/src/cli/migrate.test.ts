import { describe, expect, it, vi } from 'vitest';
import type { DatabaseEnvResult } from '../config/env.ts';
import {
  PersistenceError,
  PersistenceUnavailableError,
} from '../persistence/index.ts';
import { MigrationFailedError } from '../persistence/migrations/runMigrations.ts';
import { migrateCommand, type MigrateCommandDeps } from './migrate.ts';
import { createBufferOutput } from './output.ts';

const DATABASE_URL =
  'postgresql://app_user:sentinel-password-123@db.internal:5432/project_db';
const validEnv: DatabaseEnvResult = {
  ok: true,
  env: { NODE_ENV: 'production', DATABASE_URL },
};

function setup(overrides: Partial<MigrateCommandDeps> = {}) {
  const output = createBufferOutput();
  const run = vi.fn<MigrateCommandDeps['run']>(async () => ({
    applied: ['0000_init_app_users'],
  }));
  const deps: MigrateCommandDeps = {
    env: validEnv,
    output,
    run,
    defaultMigrationsFolder: '/committed/drizzle',
    ...overrides,
  };
  return { deps, output, run: deps.run as typeof run };
}

function allText(output: ReturnType<typeof createBufferOutput>): string {
  return [...output.lines.stdout, ...output.lines.stderr].join('\n');
}

describe('migrateCommand', () => {
  it('PBI-004 AC-0 applies pending migrations, lists them, and exits 0', async () => {
    const { deps, output, run } = setup();
    expect(await migrateCommand([], deps)).toBe(0);
    expect(run).toHaveBeenCalledWith({
      databaseUrl: DATABASE_URL,
      migrationsFolder: '/committed/drizzle',
    });
    expect(output.lines.stdout).toEqual([
      'Applied 1 migration: 0000_init_app_users',
    ]);
    expect(output.lines.stderr).toEqual([]);
  });

  it('PBI-004 AC-2 reports nothing pending and exits 0', async () => {
    const { deps, output } = setup({ run: async () => ({ applied: [] }) });
    expect(await migrateCommand([], deps)).toBe(0);
    expect(output.lines.stdout).toEqual(['No pending migrations.']);
  });

  it('PBI-004 AC-1 TBI-007 DoD-1 names the failing migration, prints no success, and exits 1', async () => {
    const { deps, output } = setup({
      run: async () => {
        throw new MigrationFailedError(
          '0001_add_phone',
          '42703',
          'column "x" does not exist'
        );
      },
    });
    expect(await migrateCommand([], deps)).toBe(1);
    expect(output.lines.stdout).toEqual([]);
    expect(output.lines.stderr).toEqual([
      'Migration 0001_add_phone failed: 42703 column "x" does not exist',
    ]);
  });

  it('exits 1 without printing the URL when the database is unreachable', async () => {
    const { deps, output } = setup({
      run: async () => {
        throw new PersistenceUnavailableError({ sqlState: '08006' });
      },
    });
    expect(await migrateCommand([], deps)).toBe(1);
    expect(output.lines.stderr).toEqual([
      'Cannot connect to the database. Check DATABASE_URL and that PostgreSQL is running.',
    ]);
    expect(allText(output)).not.toContain('sentinel-password-123');
    expect(allText(output)).not.toContain('db.internal');
  });

  it('exits 1 and reports the SQLSTATE of another database error', async () => {
    const { deps, output } = setup({
      run: async () => {
        throw new PersistenceError({ sqlState: '42501' });
      },
    });
    expect(await migrateCommand([], deps)).toBe(1);
    expect(output.lines.stderr).toEqual([
      'Migration run failed: SQLSTATE 42501.',
    ]);
  });

  it('exits 1 with a fixed message for an unexpected error', async () => {
    const { deps, output } = setup({
      run: async () => {
        throw new Error(`boom ${DATABASE_URL}`);
      },
    });
    expect(await migrateCommand([], deps)).toBe(1);
    expect(output.lines.stderr).toEqual(['Migration run failed.']);
  });

  it('VT-13 PBI-004 AC-3 aborts with exit 2 before connecting when DATABASE_URL is missing', async () => {
    const { deps, output, run } = setup({
      env: {
        ok: false,
        problems: [{ name: 'DATABASE_URL', reason: 'missing' }],
      },
    });
    expect(await migrateCommand([], deps)).toBe(2);
    expect(run).not.toHaveBeenCalled();
    expect(output.lines.stderr).toEqual([
      'Configuration error: DATABASE_URL is missing.',
    ]);
  });

  it('uses --migrations when given', async () => {
    const { deps, run } = setup();
    expect(await migrateCommand(['--migrations', '/other'], deps)).toBe(0);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        migrationsFolder: expect.stringMatching(/other$/),
      })
    );
  });

  it('rejects an unknown argument with exit 2', async () => {
    const { deps, output, run } = setup();
    expect(await migrateCommand(['--nope'], deps)).toBe(2);
    expect(run).not.toHaveBeenCalled();
    expect(output.lines.stderr).toEqual([
      'Usage: migrate [--migrations <folder>]',
    ]);
  });
});
