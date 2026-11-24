import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import pg from 'pg';
import * as schema from '../../db/schema';

const MIGRATION_FILENAME = '20261119000000_ch01_chat-harness.sql';
const migrationPath = path.resolve(process.cwd(), 'migrations', MIGRATION_FILENAME);

function readMigrationSections(): { raw: string; up: string; down: string } {
  const raw = fs.readFileSync(migrationPath, 'utf8');
  const parts = raw.split(/^--\s*Down Migration\s*$/im);
  return {
    raw,
    up: parts[0] ?? '',
    down: parts[1] ?? '',
  };
}

function extractTableBlock(sqlText: string, tableName: string): string {
  const startPattern = new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${tableName}\\s*\\(`, 'i');
  const match = startPattern.exec(sqlText);
  if (!match) return '';
  const startIndex = match.index;
  const endIndex = sqlText.indexOf(');', startIndex);
  return endIndex === -1 ? sqlText.slice(startIndex) : sqlText.slice(startIndex, endIndex + 2);
}

describe('TBI-007 — Chat harness SQL migration shape (DoD-0..DoD-2, VT-41..VT-43)', () => {
  it('DoD-0 / VT-41: migration file exists with Up and Down sections and no row-rewriting DML', () => {
    expect(fs.existsSync(migrationPath)).toBe(true);
    const { raw, up, down } = readMigrationSections();

    expect(raw).toMatch(/^--\s*Up Migration\b/im);
    expect(raw).toMatch(/^--\s*Down Migration\b/im);
    expect(up.trim().length).toBeGreaterThan(0);
    expect(down.trim().length).toBeGreaterThan(0);

    // Strip SQL line comments before scanning for DML statements
    const upNoComments = up.replace(/--.*$/gm, '');
    expect(upNoComments).not.toMatch(/\bUPDATE\s+\w+/i);
    expect(upNoComments).not.toMatch(/\bDELETE\s+FROM\s+\w+/i);
  });

  it('DoD-0 / DoD-2 / VT-41 / VT-43: creates chat_thread_summaries with cascade FK, checks, and partial non-fallback index', () => {
    const { up } = readMigrationSections();
    const block = extractTableBlock(up, 'chat_thread_summaries');
    expect(block.length).toBeGreaterThan(0);

    expect(block).toMatch(/\bid\s+UUID\s+PRIMARY\s+KEY\s+DEFAULT\s+gen_random_uuid\(\)/i);
    expect(block).toMatch(
      /\bthread_id\s+UUID\s+NOT\s+NULL\s+REFERENCES\s+chat_threads\s*\(\s*id\s*\)\s+ON\s+DELETE\s+CASCADE/i,
    );
    expect(block).toMatch(/\brun_id\s+TEXT\s+NOT\s+NULL/i);
    expect(block).toMatch(/\bsummary_text\s+TEXT\s+NOT\s+NULL/i);
    expect(block).toMatch(/\bsource\s+TEXT\s+NOT\s+NULL/i);
    expect(block).toMatch(/CHECK\s*\(\s*source\s+IN\s*\(\s*'auto'\s*,\s*'user'\s*\)\s*\)/i);
    expect(block).toMatch(/\bis_fallback\s+BOOLEAN\s+NOT\s+NULL\s+DEFAULT\s+false/i);
    expect(block).toMatch(/\bcovers_through_ordinal\s+INTEGER\s+NOT\s+NULL\s+DEFAULT\s+0/i);
    expect(block).toMatch(/\bcreated_at\s+TIMESTAMPTZ\s+NOT\s+NULL\s+DEFAULT\s+NOW\(\)/i);

    // Partial index for latest non-fallback lookup
    expect(up).toMatch(
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_chat_thread_summaries_latest_full\s+ON\s+chat_thread_summaries\s*\(\s*thread_id\s*,\s*created_at\s+DESC\s*\)\s+WHERE\s+is_fallback\s*=\s*false/i,
    );
    // General thread lookup index
    expect(up).toMatch(
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_chat_thread_summaries_thread_created\s+ON\s+chat_thread_summaries\s*\(\s*thread_id\s*,\s*created_at\s+DESC\s*\)/i,
    );
  });

  it('DoD-1 / DoD-2 / VT-42 / VT-43: creates chat_thread_commands with cascade FK, unique (thread_id, command_id), checks, and indexes', () => {
    const { up } = readMigrationSections();
    const block = extractTableBlock(up, 'chat_thread_commands');
    expect(block.length).toBeGreaterThan(0);

    expect(block).toMatch(/\bid\s+UUID\s+PRIMARY\s+KEY\s+DEFAULT\s+gen_random_uuid\(\)/i);
    expect(block).toMatch(
      /\bthread_id\s+UUID\s+NOT\s+NULL\s+REFERENCES\s+chat_threads\s*\(\s*id\s*\)\s+ON\s+DELETE\s+CASCADE/i,
    );
    expect(block).toMatch(/\bcommand_id\s+UUID\s+NOT\s+NULL/i);
    expect(block).toMatch(/\brun_id\s+TEXT\b(?!\s+NOT\s+NULL)/i);
    expect(block).toMatch(/\bkind\s+TEXT\s+NOT\s+NULL/i);
    expect(block).toMatch(
      /CHECK\s*\(\s*kind\s+IN\s*\(\s*'send'\s*,\s*'steer'\s*,\s*'summarize'\s*,\s*'cancel'\s*,\s*'retry'\s*\)\s*\)/i,
    );
    expect(block).toMatch(/\bstatus\s+TEXT\s+NOT\s+NULL/i);
    expect(block).toMatch(
      /CHECK\s*\(\s*status\s+IN\s*\(\s*'accepted'\s*,\s*'applied'\s*,\s*'rejected'\s*,\s*'queued'\s*\)\s*\)/i,
    );
    expect(block).toMatch(/\breason\s+TEXT\b(?!\s+NOT\s+NULL)/i);
    expect(block).toMatch(/\bpayload\s+JSONB\b(?!\s+NOT\s+NULL)/i);
    expect(block).toMatch(/\bcreated_at\s+TIMESTAMPTZ\s+NOT\s+NULL\s+DEFAULT\s+NOW\(\)/i);
    expect(block).toMatch(/\bupdated_at\s+TIMESTAMPTZ\s+NOT\s+NULL\s+DEFAULT\s+NOW\(\)/i);
    expect(block).toMatch(
      /CONSTRAINT\s+uq_chat_thread_commands_thread_command\s+UNIQUE\s*\(\s*thread_id\s*,\s*command_id\s*\)/i,
    );

    // Steer count index
    expect(up).toMatch(
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_chat_thread_commands_steer_count\s+ON\s+chat_thread_commands\s*\(\s*thread_id\s*,\s*run_id\s*,\s*kind\s*\)/i,
    );
    // 24h payload purge partial index
    expect(up).toMatch(
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_chat_thread_commands_payload_purge\s+ON\s+chat_thread_commands\s*\(\s*created_at\s*\)\s+WHERE\s+payload\s+IS\s+NOT\s+NULL/i,
    );
    // Stale accepted receipt partial index
    expect(up).toMatch(
      /CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+idx_chat_thread_commands_stale_accepted\s+ON\s+chat_thread_commands\s*\(\s*updated_at\s*\)\s+WHERE\s+status\s*=\s*'accepted'/i,
    );
  });

  it('DoD-0 / VT-41: adds nullable harness_area and harness_version on chat_threads with no CHECK on harness_area', () => {
    const { up } = readMigrationSections();
    const upNoComments = up.replace(/--.*$/gm, '');

    expect(upNoComments).toMatch(/ALTER\s+TABLE\s+chat_threads\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+harness_area\s+TEXT\s*;/i);
    expect(upNoComments).toMatch(
      /ALTER\s+TABLE\s+chat_threads\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\s+harness_version\s+INTEGER\s*;/i,
    );
    expect(upNoComments).not.toMatch(/harness_area[^;]*NOT\s+NULL/i);
    expect(upNoComments).not.toMatch(/harness_version[^;]*NOT\s+NULL/i);
    expect(upNoComments).not.toMatch(/CHECK\s*\([^)]*harness_area/i);
  });

  it('DoD-0 / VT-41: down migration drops both columns and both tables', () => {
    const { down } = readMigrationSections();

    expect(down).toMatch(/ALTER\s+TABLE\s+chat_threads\s+DROP\s+COLUMN\s+IF\s+EXISTS\s+harness_version\s*;/i);
    expect(down).toMatch(/ALTER\s+TABLE\s+chat_threads\s+DROP\s+COLUMN\s+IF\s+EXISTS\s+harness_area\s*;/i);
    expect(down).toMatch(/DROP\s+TABLE\s+IF\s+EXISTS\s+chat_thread_commands\s*;/i);
    expect(down).toMatch(/DROP\s+TABLE\s+IF\s+EXISTS\s+chat_thread_summaries\s*;/i);
  });
});

describe('TBI-007 — Drizzle schema matches migration (DoD-3)', () => {
  it('DoD-3: chatThreads includes nullable harnessArea and harnessVersion columns', () => {
    const cols = getTableColumns(schema.chatThreads) as Record<string, { name: string; notNull: boolean }>;
    expect(cols.harnessArea).toBeDefined();
    expect(cols.harnessArea.name).toBe('harness_area');
    expect(cols.harnessArea.notNull).toBe(false);

    expect(cols.harnessVersion).toBeDefined();
    expect(cols.harnessVersion.name).toBe('harness_version');
    expect(cols.harnessVersion.notNull).toBe(false);
  });

  it('DoD-3 / DoD-2 / VT-41: exports chatThreadSummaries matching SQL columns, cascade FK, and indexes', () => {
    const summariesTable = (schema as Record<string, unknown>).chatThreadSummaries as Parameters<
      typeof getTableConfig
    >[0];
    expect(summariesTable).toBeDefined();
    expect(getTableName(summariesTable)).toBe('chat_thread_summaries');

    const cols = getTableColumns(summariesTable);
    expect(Object.values(cols).map((c) => c.name).sort()).toEqual([
      'covers_through_ordinal',
      'created_at',
      'id',
      'is_fallback',
      'run_id',
      'source',
      'summary_text',
      'thread_id',
    ]);

    const config = getTableConfig(summariesTable);
    const fkToThreads = config.foreignKeys.find(
      (fk) => getTableName(fk.reference().foreignTable) === 'chat_threads',
    );
    expect(fkToThreads).toBeDefined();
    expect(fkToThreads?.onDelete).toBe('cascade');

    const indexNames = config.indexes.map((idx) => idx.config.name).sort();
    expect(indexNames).toEqual([
      'idx_chat_thread_summaries_latest_full',
      'idx_chat_thread_summaries_thread_created',
    ]);
  });

  it('DoD-3 / DoD-1 / DoD-2 / VT-42: exports chatThreadCommands matching SQL columns, cascade FK, unique constraint, and indexes', () => {
    const commandsTable = (schema as Record<string, unknown>).chatThreadCommands as Parameters<
      typeof getTableConfig
    >[0];
    expect(commandsTable).toBeDefined();
    expect(getTableName(commandsTable)).toBe('chat_thread_commands');

    const cols = getTableColumns(commandsTable);
    expect(Object.values(cols).map((c) => c.name).sort()).toEqual([
      'command_id',
      'created_at',
      'id',
      'kind',
      'payload',
      'reason',
      'run_id',
      'status',
      'thread_id',
      'updated_at',
    ]);

    const config = getTableConfig(commandsTable);
    const fkToThreads = config.foreignKeys.find(
      (fk) => getTableName(fk.reference().foreignTable) === 'chat_threads',
    );
    expect(fkToThreads).toBeDefined();
    expect(fkToThreads?.onDelete).toBe('cascade');

    const uniqueNames = config.uniqueConstraints.map((u) => u.name);
    expect(uniqueNames).toContain('uq_chat_thread_commands_thread_command');

    const indexNames = config.indexes.map((idx) => idx.config.name).sort();
    expect(indexNames).toEqual([
      'idx_chat_thread_commands_payload_purge',
      'idx_chat_thread_commands_stale_accepted',
      'idx_chat_thread_commands_steer_count',
    ]);
  });

  it('DoD-3: exports chatThreadSummariesRelations and chatThreadCommandsRelations', () => {
    expect((schema as Record<string, unknown>).chatThreadSummariesRelations).toBeDefined();
    expect((schema as Record<string, unknown>).chatThreadCommandsRelations).toBeDefined();
    expect(schema.threadsRelations).toBeDefined();
  });
});

const liveDatabaseUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
const describePostgres = liveDatabaseUrl ? describe : describe.skip;

describePostgres('TBI-007 — Live Postgres verification (DoD-0, DoD-1, DoD-2, VT-41, VT-42, VT-43)', () => {
  const testSchema = `ch_mig_test_${crypto.randomBytes(6).toString('hex')}`;
  let client: pg.Client | null = null;
  let connected = false;

  beforeAll(async () => {
    if (!liveDatabaseUrl) return;
    const candidate = new pg.Client({
      connectionString: liveDatabaseUrl,
      connectionTimeoutMillis: 3_000,
    });
    try {
      await candidate.connect();
      client = candidate;
      connected = true;
      await client.query(`CREATE SCHEMA ${testSchema}`);
      await client.query(`SET search_path TO ${testSchema}, public`);
      // Create a production-shaped chat_threads table with an existing row
      await client.query(`
        CREATE TABLE chat_threads (
          id UUID PRIMARY KEY,
          user_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'idle',
          kickoff JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(
        `INSERT INTO chat_threads (id, user_id) VALUES ($1, $2)`,
        [crypto.randomUUID(), 'existing-user'],
      );
    } catch {
      await candidate.end().catch(() => {});
      client = null;
      connected = false;
    }
  });

  afterAll(async () => {
    if (client) {
      await client.query(`DROP SCHEMA IF EXISTS ${testSchema} CASCADE`).catch(() => {});
      await client.end().catch(() => {});
    }
  });

  it('DoD-0 / DoD-1 / DoD-2 / VT-41 / VT-42 / VT-43: applies Up, enforces unique + cascade + partial index, and rolls back cleanly with Down', async () => {
    if (!connected || !client) {
      return;
    }

    const { up, down } = readMigrationSections();

    // Apply Up migration against production-shaped data
    await client.query(up);

    // Existing row preserved with NULL harness columns
    const existing = await client.query<{ harness_area: string | null; harness_version: number | null }>(
      `SELECT harness_area, harness_version FROM chat_threads WHERE user_id = 'existing-user'`,
    );
    expect(existing.rows).toHaveLength(1);
    expect(existing.rows[0].harness_area).toBeNull();
    expect(existing.rows[0].harness_version).toBeNull();

    // Insert a thread, summary rows, and command rows
    const threadId = crypto.randomUUID();
    const commandId = crypto.randomUUID();
    await client.query(
      `INSERT INTO chat_threads (id, user_id, harness_area, harness_version) VALUES ($1, $2, $3, $4)`,
      [threadId, 'harness-user', 'brainstorm', 1],
    );

    await client.query(
      `INSERT INTO chat_thread_summaries (thread_id, run_id, summary_text, source, is_fallback, covers_through_ordinal)
       VALUES ($1, 'run-1', 'Full summary', 'auto', false, 5),
              ($1, 'run-2', 'Fallback summary', 'auto', true, 7)`,
      [threadId],
    );

    await client.query(
      `INSERT INTO chat_thread_commands (thread_id, command_id, run_id, kind, status, payload)
       VALUES ($1, $2, 'run-1', 'steer', 'accepted', '{"note":"focus"}'::jsonb)`,
      [threadId, commandId],
    );

    // DoD-1 / VT-42: duplicate (thread_id, command_id) rejected with SQLSTATE 23505
    await expect(
      client.query(
        `INSERT INTO chat_thread_commands (thread_id, command_id, run_id, kind, status)
         VALUES ($1, $2, 'run-1', 'steer', 'accepted')`,
        [threadId, commandId],
      ),
    ).rejects.toMatchObject({ code: '23505' });

    // VT-41: confirm partial index idx_chat_thread_summaries_latest_full is used by planner
    await client.query('SET enable_seqscan = off');
    try {
      const explain = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN SELECT * FROM chat_thread_summaries
         WHERE thread_id = $1 AND is_fallback = false
         ORDER BY created_at DESC LIMIT 1`,
        [threadId],
      );
      const planText = explain.rows.map((r) => r['QUERY PLAN']).join('\n');
      expect(planText).toContain('idx_chat_thread_summaries_latest_full');
    } finally {
      await client.query('RESET enable_seqscan');
    }

    // DoD-2 / VT-43: deleting the thread cascades to summaries and commands
    await client.query(`DELETE FROM chat_threads WHERE id = $1`, [threadId]);

    const remSummaries = await client.query(
      `SELECT count(*)::int AS cnt FROM chat_thread_summaries WHERE thread_id = $1`,
      [threadId],
    );
    const remCommands = await client.query(
      `SELECT count(*)::int AS cnt FROM chat_thread_commands WHERE thread_id = $1`,
      [threadId],
    );
    expect(remSummaries.rows[0].cnt).toBe(0);
    expect(remCommands.rows[0].cnt).toBe(0);

    // DoD-0 / VT-41: Down migration rolls back cleanly
    await client.query(down);

    const tablesAfterDown = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = $1 AND table_name IN ('chat_thread_summaries', 'chat_thread_commands')`,
      [testSchema],
    );
    expect(tablesAfterDown.rows).toHaveLength(0);

    const colsAfterDown = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'chat_threads'
         AND column_name IN ('harness_area', 'harness_version')`,
      [testSchema],
    );
    expect(colsAfterDown.rows).toHaveLength(0);
  });
});
