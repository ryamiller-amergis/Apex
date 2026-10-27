import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MigrationFailedError,
  MigrationsFolderError,
  readMigrations,
} from './runMigrations.ts';

const committed = fileURLToPath(new URL('../../../drizzle', import.meta.url));

describe('readMigrations', () => {
  it('PBI-003 AC-2 reads the committed migrations in journal order with their tags', () => {
    const migrations = readMigrations(committed);
    expect(migrations.map((migration) => migration.tag)).toEqual([
      '0000_init_app_users',
    ]);
    const [first] = migrations;
    expect(first?.statements.join('\n')).toContain('CREATE TABLE "app_users"');
    expect(first?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(first?.folderMillis).toEqual(expect.any(Number));
  });

  it('throws MigrationsFolderError for a folder with no journal', () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'no-journal-'));
    try {
      expect(() => readMigrations(empty)).toThrow(MigrationsFolderError);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('MigrationFailedError', () => {
  it('carries the tag, SQLSTATE, and driver message', () => {
    const error = new MigrationFailedError(
      '0001_bad',
      '42704',
      'type "nope" does not exist'
    );
    expect(error.tag).toBe('0001_bad');
    expect(error.sqlState).toBe('42704');
    expect(error.reason).toBe('type "nope" does not exist');
    expect(error.message).toBe('Migration 0001_bad failed.');
  });
});
