/**
 * VT-BRIEF-1: Playbook linkage on interviews, plus the brief, revision, and specialist tables.
 * The migration and the Drizzle tables are checked against the same names.
 */
import fs from 'fs';
import path from 'path';
import { getTableConfig } from 'drizzle-orm/pg-core';
import type { PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../db/schema';

const MIGRATION = '20261007124500_playbook-interview-brief.sql';

const SECTION_KEYS = [
  'problemAndOutcome',
  'users',
  'scope',
  'businessRules',
  'scenarios',
  'acceptanceCriteria',
  'assumptions',
  'unresolvedItems',
];

const INTERVIEW_CHECKS = [
  'interviews_playbook_interview_mode_check',
  'interviews_playbook_linkage_check',
];

const BRIEF_CHECKS = [
  'interview_briefs_status_check',
  'interview_briefs_version_check',
  'interview_briefs_approval_check',
  'interview_briefs_sections_check',
];

const REVISION_CHECKS = [
  'interview_brief_revisions_status_check',
  'interview_brief_revisions_version_check',
  'interview_brief_revisions_sections_check',
];

const SPECIALIST_CHECKS = [
  'interview_specialist_reviews_specialist_check',
  'interview_specialist_reviews_status_check',
  'interview_specialist_reviews_result_check',
  'interview_specialist_reviews_brief_version_check',
  'interview_specialist_reviews_duration_check',
];

function readMigration(): { up: string; down: string } {
  const full = path.resolve(__dirname, '../../../migrations', MIGRATION);
  const sqlText = fs.readFileSync(full, 'utf8');
  const [up = '', down = ''] = sqlText.split(/-- Down Migration/i);
  return { up, down };
}

function renderSql(value: unknown): string {
  const chunks = (value as { queryChunks?: unknown[] } | undefined)?.queryChunks ?? [];
  return chunks
    .map((chunk) => {
      if (chunk && typeof chunk === 'object' && 'value' in chunk) {
        const parts = (chunk as { value: unknown }).value;
        return Array.isArray(parts) ? parts.join('') : '';
      }
      if (chunk && typeof chunk === 'object' && 'name' in chunk) {
        return (chunk as { name: string }).name;
      }
      return '';
    })
    .join('');
}

function drizzleTableName(table: unknown): string | undefined {
  return (table as Record<symbol, string> | undefined)?.[Symbol.for('drizzle:Name')];
}

function indexColumnNames(columns: readonly unknown[]): Array<string | undefined> {
  return columns.map((column) => (column as { name?: string }).name);
}

function tableConfig(table: PgTable) {
  return getTableConfig(table);
}

function checkSql(table: PgTable, name: string): string {
  const check = tableConfig(table).checks.find((entry) => entry.name === name);
  expect(check).toBeDefined();
  return renderSql(check?.value);
}

describe('VT-BRIEF-1 — interview brief schema and migration', () => {
  it('VT-BRIEF-1 links an interview to an optional run and step run and snapshots the profile', () => {
    const { up } = readMigration();
    const config = tableConfig(schema.interviews);
    const columnNames = config.columns.map((column) => column.name);

    expect(columnNames).toEqual(
      expect.arrayContaining([
        'playbook_run_id',
        'playbook_step_run_id',
        'playbook_interview_mode',
        'playbook_profile_key',
        'playbook_profile_snapshot',
      ]),
    );

    for (const name of ['playbook_run_id', 'playbook_step_run_id', 'playbook_interview_mode', 'playbook_profile_key', 'playbook_profile_snapshot']) {
      expect(config.columns.find((column) => column.name === name)?.notNull).toBe(false);
    }

    const snapshot = config.columns.find((column) => column.name === 'playbook_profile_snapshot');
    expect(snapshot?.columnType).toBe('PgJsonb');

    const foreignKeys = config.foreignKeys.map((fk) => {
      const ref = fk.reference();
      return {
        columns: ref.columns.map((column) => column.name),
        foreignTable: drizzleTableName(ref.foreignColumns[0].table),
        foreignColumns: ref.foreignColumns.map((column) => column.name),
        onDelete: fk.onDelete,
      };
    });
    expect(foreignKeys).toEqual(
      expect.arrayContaining([
        {
          columns: ['playbook_run_id'],
          foreignTable: 'playbook_runs',
          foreignColumns: ['id'],
          onDelete: 'restrict',
        },
        {
          columns: ['playbook_step_run_id'],
          foreignTable: 'playbook_step_runs',
          foreignColumns: ['id'],
          onDelete: 'restrict',
        },
      ]),
    );

    expect(up).toMatch(/playbook_run_id\s+UUID\s+REFERENCES playbook_runs\(id\)\s+ON DELETE RESTRICT/i);
    expect(up).toMatch(/playbook_step_run_id\s+UUID\s+REFERENCES playbook_step_runs\(id\)\s+ON DELETE RESTRICT/i);
    expect(up).toMatch(/playbook_interview_mode\s+TEXT/i);
    expect(up).toMatch(/playbook_profile_key\s+TEXT/i);
    expect(up).toMatch(/playbook_profile_snapshot\s+JSONB/i);

    for (const name of INTERVIEW_CHECKS) {
      expect(up).toContain(name);
      const sqlText = checkSql(schema.interviews, name);
      expect(sqlText.length).toBeGreaterThan(0);
    }

    const modeSql = checkSql(schema.interviews, 'interviews_playbook_interview_mode_check');
    expect(modeSql).toMatch(/human_led/);
    expect(modeSql).toMatch(/multi_agent_assisted/);
    expect(up).toMatch(/human_led/);
    expect(up).toMatch(/multi_agent_assisted/);

    const linkageSql = checkSql(schema.interviews, 'interviews_playbook_linkage_check');
    for (const column of ['playbook_run_id', 'playbook_step_run_id', 'playbook_interview_mode', 'playbook_profile_key', 'playbook_profile_snapshot']) {
      expect(linkageSql).toContain(column);
      expect(up).toContain(column);
    }
    expect(linkageSql).toMatch(/jsonb_typeof/i);
    expect(up).toMatch(/jsonb_typeof\s*\(\s*playbook_profile_snapshot\s*\)\s*=\s*'object'/i);

    const stepRunIndex = config.indexes.find((entry) => entry.config.name === 'uq_interviews_playbook_step_run');
    expect(stepRunIndex?.config.unique).toBe(true);
    expect(indexColumnNames(stepRunIndex?.config.columns ?? [])).toEqual(['playbook_step_run_id']);
    expect(renderSql(stepRunIndex?.config.where)).toMatch(/playbook_step_run_id/i);
    expect(up).toMatch(
      /CREATE UNIQUE INDEX uq_interviews_playbook_step_run\s+ON interviews\s*\(playbook_step_run_id\)\s+WHERE playbook_step_run_id IS NOT NULL/i,
    );

    const runIndex = config.indexes.find((entry) => entry.config.name === 'idx_interviews_playbook_run');
    expect(runIndex?.config.unique).toBe(false);
    expect(indexColumnNames(runIndex?.config.columns ?? [])).toEqual(['playbook_run_id']);
    expect(up).toMatch(
      /CREATE INDEX idx_interviews_playbook_run\s+ON interviews\s*\(playbook_run_id\)\s+WHERE playbook_run_id IS NOT NULL/i,
    );
  });

  it('VT-BRIEF-1 creates interview_briefs and immutable interview_brief_revisions', () => {
    const { up } = readMigration();
    const briefs = tableConfig(schema.interviewBriefs);
    const revisions = tableConfig(schema.interviewBriefRevisions);

    expect(briefs.name).toBe('interview_briefs');
    expect(revisions.name).toBe('interview_brief_revisions');

    expect(briefs.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['id', 'interview_id', 'status', 'version', 'sections', 'approved_by', 'approved_at', 'created_at', 'updated_at']),
    );
    expect(revisions.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['id', 'brief_id', 'interview_id', 'version', 'status', 'sections', 'created_by', 'created_at']),
    );
    expect(revisions.columns.map((column) => column.name)).not.toContain('updated_at');

    for (const columnName of ['approved_at', 'created_at', 'updated_at']) {
      const column = briefs.columns.find((entry) => entry.name === columnName);
      expect(column?.columnType).toBe('PgTimestampString');
      expect(column && 'withTimezone' in column ? column.withTimezone : undefined).toBe(true);
    }
    const revisionCreatedAt = revisions.columns.find((column) => column.name === 'created_at');
    expect(revisionCreatedAt?.columnType).toBe('PgTimestampString');

    expect(briefs.columns.find((column) => column.name === 'sections')?.columnType).toBe('PgJsonb');
    expect(revisions.columns.find((column) => column.name === 'sections')?.columnType).toBe('PgJsonb');

    expect(briefs.uniqueConstraints.map((entry) => entry.name)).toContain('uq_interview_briefs_interview');
    expect(revisions.uniqueConstraints.map((entry) => entry.name)).toContain('uq_interview_brief_revisions_brief_version');
    expect(up).toMatch(/uq_interview_briefs_interview/i);
    expect(up).toMatch(/uq_interview_brief_revisions_brief_version/i);

    const briefFks = briefs.foreignKeys.map((fk) => {
      const ref = fk.reference();
      return {
        column: ref.columns[0].name,
        foreignTable: drizzleTableName(ref.foreignColumns[0].table),
        onDelete: fk.onDelete,
      };
    });
    expect(briefFks).toEqual(
      expect.arrayContaining([
        { column: 'interview_id', foreignTable: 'interviews', onDelete: 'cascade' },
        { column: 'approved_by', foreignTable: 'app_users', onDelete: 'restrict' },
      ]),
    );

    const revisionFks = revisions.foreignKeys.map((fk) => {
      const ref = fk.reference();
      return {
        column: ref.columns[0].name,
        foreignTable: drizzleTableName(ref.foreignColumns[0].table),
        onDelete: fk.onDelete,
      };
    });
    expect(revisionFks).toEqual(
      expect.arrayContaining([
        { column: 'brief_id', foreignTable: 'interview_briefs', onDelete: 'cascade' },
        { column: 'interview_id', foreignTable: 'interviews', onDelete: 'cascade' },
        { column: 'created_by', foreignTable: 'app_users', onDelete: 'restrict' },
      ]),
    );

    expect(up).toMatch(/interview_id\s+UUID\s+NOT NULL[\s\S]*REFERENCES interviews\(id\)\s+ON DELETE CASCADE/i);
    expect(up).toMatch(/REFERENCES interview_briefs\(id\)\s+ON DELETE CASCADE/i);
    expect(up).toMatch(/approved_by\s+TEXT[\s\S]*REFERENCES app_users\(oid\)\s+ON DELETE RESTRICT/i);
    expect(up).toMatch(/created_by\s+TEXT\s+NOT NULL[\s\S]*REFERENCES app_users\(oid\)\s+ON DELETE RESTRICT/i);

    for (const name of [...BRIEF_CHECKS, ...REVISION_CHECKS]) {
      expect(up).toContain(name);
    }
    for (const name of BRIEF_CHECKS) {
      expect(checkSql(schema.interviewBriefs, name).length).toBeGreaterThan(0);
    }
    for (const name of REVISION_CHECKS) {
      expect(checkSql(schema.interviewBriefRevisions, name).length).toBeGreaterThan(0);
    }

    const statusSql = checkSql(schema.interviewBriefs, 'interview_briefs_status_check');
    expect(statusSql).toMatch(/draft/);
    expect(statusSql).toMatch(/approved/);
    expect(up).toMatch(/status IN \('draft', 'approved'\)/i);

    const approvalSql = checkSql(schema.interviewBriefs, 'interview_briefs_approval_check');
    expect(approvalSql).toMatch(/approved_by/);
    expect(approvalSql).toMatch(/approved_at/);
    expect(up).toMatch(/status = 'approved'[\s\S]*approved_by IS NOT NULL[\s\S]*approved_at IS NOT NULL/i);
    expect(up).toMatch(/status = 'draft'[\s\S]*approved_by IS NULL[\s\S]*approved_at IS NULL/i);

    const sectionsSql = checkSql(schema.interviewBriefs, 'interview_briefs_sections_check');
    for (const key of SECTION_KEYS) {
      expect(sectionsSql).toContain(key);
      expect(up).toContain(key);
    }
    expect(sectionsSql).toMatch(/unresolvedItems/);
    expect(up).toMatch(/jsonb_typeof\s*\(\s*sections\s*->\s*'unresolvedItems'\s*\)\s*=\s*'array'/i);

    const revisionIndex = revisions.indexes.find((entry) => entry.config.name === 'idx_interview_brief_revisions_interview');
    expect(indexColumnNames(revisionIndex?.config.columns ?? [])).toEqual(['interview_id', 'version']);
    expect(up).toMatch(
      /CREATE INDEX idx_interview_brief_revisions_interview\s+ON interview_brief_revisions\s*\(interview_id,\s*version\)/i,
    );
  });

  it('VT-BRIEF-1 stores specialist reviews as structured JSON with no chain-of-thought column', () => {
    const { up, down } = readMigration();
    const reviews = tableConfig(schema.interviewSpecialistReviews);

    expect(reviews.name).toBe('interview_specialist_reviews');
    const names = reviews.columns.map((column) => column.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'id',
        'interview_id',
        'brief_version',
        'specialist',
        'status',
        'result',
        'model',
        'duration_ms',
        'created_at',
      ]),
    );
    expect(names.join(' ')).not.toMatch(/chain|thought|reasoning/i);

    const result = reviews.columns.find((column) => column.name === 'result');
    expect(result?.notNull).toBe(true);
    expect(result?.columnType).toBe('PgJsonb');

    const createdAt = reviews.columns.find((column) => column.name === 'created_at');
    expect(createdAt?.columnType).toBe('PgTimestampString');

    const reviewFks = reviews.foreignKeys.map((fk) => {
      const ref = fk.reference();
      return {
        column: ref.columns[0].name,
        foreignTable: drizzleTableName(ref.foreignColumns[0].table),
        onDelete: fk.onDelete,
      };
    });
    expect(reviewFks).toEqual([
      { column: 'interview_id', foreignTable: 'interviews', onDelete: 'cascade' },
    ]);

    for (const name of SPECIALIST_CHECKS) {
      expect(up).toContain(name);
      expect(checkSql(schema.interviewSpecialistReviews, name).length).toBeGreaterThan(0);
    }

    const resultSql = checkSql(schema.interviewSpecialistReviews, 'interview_specialist_reviews_result_check');
    expect(resultSql).toMatch(/jsonb_typeof/i);
    expect(up).toMatch(/jsonb_typeof\s*\(\s*result\s*\)\s*=\s*'object'/i);
    expect(up).toMatch(/status IN \('succeeded', 'failed'\)/i);
    expect(up).toMatch(/duration_ms\s+INTEGER\s+NOT NULL/i);
    expect(up).not.toMatch(/chain_of_thought|chainOfThought|reasoning/i);

    const versionIndex = reviews.indexes.find(
      (entry) => entry.config.name === 'idx_interview_specialist_reviews_interview_version',
    );
    expect(indexColumnNames(versionIndex?.config.columns ?? [])).toEqual(['interview_id', 'brief_version']);
    expect(up).toMatch(
      /CREATE INDEX idx_interview_specialist_reviews_interview_version\s+ON interview_specialist_reviews\s*\(interview_id,\s*brief_version\)/i,
    );
    expect(up).toMatch(
      /CREATE INDEX idx_interview_specialist_reviews_specialist\s+ON interview_specialist_reviews\s*\(specialist\)/i,
    );

    expect(down).toMatch(/DROP TABLE IF EXISTS interview_specialist_reviews/i);
    expect(down).toMatch(/DROP TABLE IF EXISTS interview_brief_revisions/i);
    expect(down).toMatch(/DROP TABLE IF EXISTS interview_briefs/i);
    expect(down).toMatch(/DROP COLUMN IF EXISTS playbook_run_id/i);
    expect(down).toMatch(/DROP COLUMN IF EXISTS playbook_step_run_id/i);
    expect(down).toMatch(/DROP COLUMN IF EXISTS playbook_interview_mode/i);
    expect(down).toMatch(/DROP COLUMN IF EXISTS playbook_profile_key/i);
    expect(down).toMatch(/DROP COLUMN IF EXISTS playbook_profile_snapshot/i);
    expect(down).not.toMatch(/DROP TABLE(?: IF EXISTS)? interviews\b/i);
  });
});
