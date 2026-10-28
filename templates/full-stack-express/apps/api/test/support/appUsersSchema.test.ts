import { describe, expect, it } from 'vitest';
import {
  columnMatches,
  committedMigrationSql,
  drizzleAppUsersExpectation,
  type InformationColumn,
} from './appUsersSchema.ts';

describe('app_users schema contract (VT-19 lower tier)', () => {
  it('VT-19 TBI-024 DoD-0 the Drizzle table and the committed SQL name the same columns, primary key, and unique subject', () => {
    const expected = drizzleAppUsersExpectation();
    const sql = committedMigrationSql();
    expect(expected.primaryKey).toEqual(['id']);
    expect(expected.uniqueSubject).toEqual(['external_subject']);
    expect(sql).toContain('app_users_external_subject_unique');
    expect(sql).toContain('PRIMARY KEY');
    for (const column of expected.columns) {
      expect(sql).toContain(`"${column.name}"`);
    }
    const names = expected.columns.map((column) => column.name).sort();
    expect(names).toEqual([
      'created_at',
      'display_name',
      'email',
      'external_subject',
      'id',
      'status',
      'updated_at',
    ]);
  });

  it('VT-19 columnMatches accepts a varchar column and rejects a nullability change', () => {
    const expected = drizzleAppUsersExpectation().columns.find(
      (column) => column.name === 'display_name'
    );
    if (!expected) {
      throw new Error('display_name missing from the Drizzle table');
    }
    const row: InformationColumn = {
      column_name: 'display_name',
      data_type: 'character varying',
      is_nullable: 'NO',
      character_maximum_length: 100,
    };
    expect(columnMatches(expected, row)).toBe(true);
    expect(columnMatches(expected, { ...row, is_nullable: 'YES' })).toBe(false);
  });
});
