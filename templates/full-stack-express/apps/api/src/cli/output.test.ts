import { describe, expect, it } from 'vitest';
import {
  createBufferOutput,
  describeConfigProblems,
  ExitCode,
  formatMigrationFailure,
  formatMigrationsApplied,
  formatSeedResult,
} from './output.ts';

describe('exit codes', () => {
  it('TBI-007 DoD-1 uses 0 for success, 1 for failure, 2 for configuration', () => {
    expect(ExitCode).toEqual({ success: 0, failure: 1, configuration: 2 });
  });
});

describe('configuration messages', () => {
  it('VT-13 PBI-004 AC-3 names a missing DATABASE_URL', () => {
    expect(
      describeConfigProblems([{ name: 'DATABASE_URL', reason: 'missing' }])
    ).toEqual(['Configuration error: DATABASE_URL is missing.']);
  });

  it('VT-14 PBI-004 AC-3 names a malformed DATABASE_URL with a fixed reason', () => {
    expect(
      describeConfigProblems([{ name: 'DATABASE_URL', reason: 'invalid' }])
    ).toEqual([
      'Configuration error: DATABASE_URL is not a valid PostgreSQL connection URL.',
    ]);
  });

  it('names NODE_ENV problems', () => {
    expect(
      describeConfigProblems([
        { name: 'NODE_ENV', reason: 'missing' },
        { name: 'NODE_ENV', reason: 'invalid' },
      ])
    ).toEqual([
      'Configuration error: NODE_ENV is missing.',
      'Configuration error: NODE_ENV must be development, test, or production.',
    ]);
  });
});

describe('migration messages', () => {
  it('PBI-004 AC-0 lists each applied tag', () => {
    expect(formatMigrationsApplied(['0000_init_app_users'])).toBe(
      'Applied 1 migration: 0000_init_app_users'
    );
    expect(formatMigrationsApplied(['0000_a', '0001_b'])).toBe(
      'Applied 2 migrations: 0000_a, 0001_b'
    );
  });

  it('PBI-004 AC-2 reports nothing pending', () => {
    expect(formatMigrationsApplied([])).toBe('No pending migrations.');
  });

  it('PBI-004 AC-1 names the failing migration and the SQLSTATE', () => {
    expect(
      formatMigrationFailure(
        '0001_add_phone',
        '42703',
        'column "x" does not exist'
      )
    ).toBe('Migration 0001_add_phone failed: 42703 column "x" does not exist');
  });
});

describe('seed messages', () => {
  it('PBI-005 AC-0 AC-2 reports new and existing counts', () => {
    expect(formatSeedResult(3, 0)).toBe(
      'Seeded 3 new rows; 0 already present.'
    );
    expect(formatSeedResult(0, 3)).toBe(
      'Seeded 0 new rows; 3 already present.'
    );
    expect(formatSeedResult(1, 2)).toBe('Seeded 1 new row; 2 already present.');
  });
});

describe('buffer output', () => {
  it('collects stdout and stderr lines separately', () => {
    const output = createBufferOutput();
    output.stdout('a');
    output.stderr('b');
    expect(output.lines).toEqual({ stdout: ['a'], stderr: ['b'] });
  });
});
