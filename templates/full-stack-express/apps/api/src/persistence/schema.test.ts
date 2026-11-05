import { readFileSync } from 'node:fs';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from './schema.ts';

const drizzleFolder = new URL('../../drizzle/', import.meta.url);

describe('app_users schema', () => {
  it('TBI-006 DoD-0 defines the listed columns and a unique external subject', () => {
    const config = getTableConfig(schema.appUsers);
    expect(config.name).toBe('app_users');
    const columns = Object.fromEntries(
      config.columns.map((column) => [column.name, column])
    );
    expect(Object.keys(columns).sort()).toEqual([
      'created_at',
      'display_name',
      'email',
      'external_subject',
      'id',
      'status',
      'updated_at',
    ]);
    expect(columns.id?.primary).toBe(true);
    expect(columns.id?.getSQLType()).toBe('uuid');
    expect(columns.external_subject?.getSQLType()).toBe('varchar(255)');
    expect(columns.external_subject?.notNull).toBe(true);
    expect(columns.display_name?.getSQLType()).toBe('varchar(100)');
    expect(columns.display_name?.notNull).toBe(true);
    expect(columns.email?.getSQLType()).toBe('varchar(254)');
    expect(columns.email?.notNull).toBe(false);
    expect(columns.status?.notNull).toBe(true);
    expect(columns.status?.default).toBe('active');
    expect(columns.created_at?.getSQLType()).toBe('timestamp with time zone');
    expect(columns.updated_at?.getSQLType()).toBe('timestamp with time zone');

    expect(config.uniqueConstraints.map((unique) => unique.name)).toEqual([
      'app_users_external_subject_unique',
    ]);
    expect(
      config.uniqueConstraints[0]?.columns.map((column) => column.name)
    ).toEqual(['external_subject']);
    expect(config.checks.map((check) => check.name)).toEqual([
      'app_users_status_check',
    ]);
  });

  it('TBI-006 DoD-3 defines no other table', () => {
    expect(Object.keys(schema)).toEqual(['appUsers']);
  });
});

describe('committed migrations', () => {
  it('TBI-007 DoD-0 the initial migration creates app_users and is listed in the journal', () => {
    const journal = JSON.parse(
      readFileSync(new URL('meta/_journal.json', drizzleFolder), 'utf8')
    ) as { entries: { tag: string }[] };
    expect(journal.entries[0]?.tag).toBe('0000_init_app_users');
    const sql = readFileSync(
      new URL('0000_init_app_users.sql', drizzleFolder),
      'utf8'
    );
    expect(sql).toContain('CREATE TABLE "app_users"');
    expect(sql).toContain('"app_users_external_subject_unique"');
    expect(sql).toContain('"app_users_status_check"');
    expect(sql).not.toMatch(/\bDROP\b/i);
  });
});
