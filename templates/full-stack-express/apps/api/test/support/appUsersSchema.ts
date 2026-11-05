import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { appUsers } from '../../src/persistence/schema.ts';

export interface ColumnExpectation {
  name: string;
  notNull: boolean;
  sqlType: string;
}

export interface SchemaExpectation {
  columns: ColumnExpectation[];
  primaryKey: string[];
  uniqueSubject: string[];
}

export function drizzleAppUsersExpectation(): SchemaExpectation {
  const config = getTableConfig(appUsers);
  const tablePrimary = config.primaryKeys[0];
  const columnPrimary = config.columns
    .filter((column) => column.primary)
    .map((column) => column.name);
  const unique = config.uniqueConstraints.find(
    (constraint) => constraint.name === 'app_users_external_subject_unique'
  );
  return {
    columns: config.columns.map((column) => ({
      name: column.name,
      notNull: column.notNull,
      sqlType: column.getSQLType(),
    })),
    primaryKey: tablePrimary
      ? tablePrimary.columns.map((column) => column.name)
      : columnPrimary,
    uniqueSubject: unique ? unique.columns.map((column) => column.name) : [],
  };
}

export function committedMigrationSql(): string {
  const folder = fileURLToPath(new URL('../../drizzle', import.meta.url));
  return readFileSync(path.join(folder, '0000_init_app_users.sql'), 'utf8');
}

export interface InformationColumn {
  column_name: string;
  data_type: string;
  is_nullable: string;
  character_maximum_length: number | null;
}

export function columnMatches(
  expected: ColumnExpectation,
  actual: InformationColumn
): boolean {
  if (expected.name !== actual.column_name) {
    return false;
  }
  if (expected.notNull !== (actual.is_nullable === 'NO')) {
    return false;
  }
  const sqlType = expected.sqlType.toLowerCase();
  if (sqlType === 'uuid') {
    return actual.data_type === 'uuid';
  }
  if (sqlType === 'text') {
    return actual.data_type === 'text';
  }
  if (sqlType.startsWith('varchar')) {
    const length = Number(/\((\d+)\)/.exec(sqlType)?.[1]);
    return (
      actual.data_type === 'character varying' &&
      actual.character_maximum_length === length
    );
  }
  if (sqlType.includes('timestamp') && sqlType.includes('time zone')) {
    return actual.data_type === 'timestamp with time zone';
  }
  return actual.data_type === sqlType;
}
