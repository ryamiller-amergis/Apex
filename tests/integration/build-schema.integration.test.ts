/**
 * FEAT-001 build tables on a scratch database.
 * Covers VT-01..VT-07, VT-22, and VT-23.
 */
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '../../src/server/db/schema';
import { appendBuildEvent } from '../../src/server/services/buildEventsService';
import { redactJson, redactText } from '../../src/server/services/buildRedactionService';
import {
  BUILD_CORRELATION_KINDS,
  BUILD_DEPLOYMENT_STATUSES,
  BUILD_EVENT_SEVERITIES,
  BUILD_RUN_STATUSES,
  BUILD_SUSPEND_REASONS,
  BUILD_TASK_ROLES,
  BUILD_TASK_RUN_MODES,
  BUILD_TASK_STATUSES,
  BUILD_TEST_TIERS,
  BUILD_VERIFICATION_KINDS,
} from '../../src/shared/types/build';
import {
  createScratchDatabase,
  migrateDown,
  migrateUp,
  ScratchDatabase,
} from './support/scratch-db';

const MIGRATE_TIMEOUT = 600_000;
const TABLES_MIGRATION = '20261023143900_a1a4_build-from-prompt-tables';
const AGENT_RUNS_MIGRATION = '20261023144000_c3d8_build-from-prompt-agent-runs';
const USER_OID = 'feat001-build-user';
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const CONTACTS = JSON.stringify([{ userId: 'u', displayName: 'Dev', email: 'dev@example.com' }]);
const SNAPSHOT = JSON.stringify({ intake: { model: 'm', skillPath: 's', contentHash: 'h' } });
const MANIFEST = JSON.stringify({ typeCheck: 'tsc', lint: 'eslint', relatedTests: 'jest', unitSuite: 'jest' });

const BUILD_TABLES = [
  'build_runs',
  'build_revisions',
  'build_tasks',
  'build_verification_rows',
  'build_preview_leases',
  'build_events',
] as const;

const INDEXES = [
  'uq_build_runs_playbook_run',
  'uq_build_runs_client_request',
  'idx_build_runs_project_created',
  'idx_build_runs_slot',
  'idx_build_runs_queue',
  'idx_build_runs_cancel_cleanup',
  'idx_build_runs_retention',
  'idx_build_runs_interview',
  'uq_build_revisions_run_number',
  'uq_build_revisions_pipeline_run',
  'idx_build_revisions_waiting_deploy',
  'idx_build_revisions_deploying',
  'uq_build_tasks_revision_key',
  'idx_build_tasks_revision_status',
  'uq_build_tasks_branch_name',
  'idx_build_tasks_chain_head',
  'uq_build_verification_rows_revision_requirement',
  'idx_build_verification_rows_revision_status',
  'uq_build_preview_leases_project_repository',
  'uq_build_preview_leases_run',
  'idx_build_preview_leases_expires',
  'uq_build_events_ordinal',
  'idx_build_events_run_ordinal',
  'uq_build_events_dedupe',
  'uq_agent_runs_one_live_per_build_task',
  'idx_agent_runs_build_task',
];

let scratch: ScratchDatabase;
let client: pg.Client;

async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const { rows } = await client.query<T>(text, values);
  return rows;
}

/** How many applied migrations a rollback must undo to remove `name`; later migrations go too. */
async function migrationsFrom(c: pg.Client, name: string): Promise<number> {
  const { rows } = await c.query<{ count: string }>(
    `SELECT count(*) AS count FROM pgmigrations WHERE id >= (SELECT id FROM pgmigrations WHERE name = $1)`,
    [name],
  );
  const count = Number(rows[0].count);
  if (count < 1) throw new Error(`Migration ${name} is not applied`);
  return count;
}

async function seedPlaybookRun(): Promise<string> {
  const [definition] = await query<{ id: string }>(
    `INSERT INTO playbook_definitions (project, name, created_by)
     VALUES ('Apex', $1, $2) RETURNING id`,
    [`build-${Date.now()}-${Math.floor(Math.random() * 1000)}`, USER_OID],
  );
  const [version] = await query<{ id: string }>(
    `INSERT INTO playbook_definition_versions (definition_id, version_number, graph, status, published_by, published_at)
     VALUES ($1, 1, '{"nodes":[],"edges":[]}'::jsonb, 'published', $2, now()) RETURNING id`,
    [definition.id, USER_OID],
  );
  const [run] = await query<{ id: string }>(
    `INSERT INTO playbook_runs (project, definition_version_id, initiator_user_id)
     VALUES ('Apex', $1, $2) RETURNING id`,
    [version.id, USER_OID],
  );
  return run.id;
}

async function seedBuildRun(playbookRunId: string, repository = 'apex'): Promise<string> {
  const [row] = await query<{ id: string }>(
    `INSERT INTO build_runs (
       project, repository, requested_by_user_id, client_request_id, prompt, playbook_run_id,
       skill_snapshot, support_contacts, quality_manifest_snapshot,
       cost_cap_usd, elapsed_cap_seconds, parallelism_cap
     ) VALUES (
       'Apex', $1, $2, $3, 'Build the widget', $4,
       $5::jsonb, $6::jsonb, $7::jsonb,
       25, 14400, 2
     ) RETURNING id`,
    [repository, USER_OID, `req-${Date.now()}-${Math.floor(Math.random() * 1e6)}`, playbookRunId, SNAPSHOT, CONTACTS, MANIFEST],
  );
  return row.id;
}

async function seedRevision(buildRunId: string, revisionNumber = 1): Promise<string> {
  const [row] = await query<{ id: string }>(
    `INSERT INTO build_revisions (build_run_id, revision_number) VALUES ($1, $2) RETURNING id`,
    [buildRunId, revisionNumber],
  );
  return row.id;
}

async function seedTask(revisionId: string, taskKey: string, runMode: 'own_agent' | 'chain' = 'own_agent'): Promise<string> {
  const chainHead = runMode === 'chain' ? taskKey : null;
  const [row] = await query<{ id: string }>(
    `INSERT INTO build_tasks (build_revision_id, task_key, role, run_mode, chain_head_key)
     VALUES ($1, $2, 'implementer', $3, $4) RETURNING id`,
    [revisionId, taskKey, runMode, chainHead],
  );
  return row.id;
}

beforeAll(async () => {
  scratch = await createScratchDatabase('buildschema');
  client = new pg.Client({ connectionString: scratch.connectionString });
  await client.connect();
  await query(
    `INSERT INTO app_users (oid, display_name) VALUES ($1, 'FEAT-001 Build') ON CONFLICT (oid) DO NOTHING`,
    [USER_OID],
  );
}, MIGRATE_TIMEOUT);

afterAll(async () => {
  if (client) await client.end();
  if (scratch) await scratch.drop();
});

describe('VT-01 build tables exist with the contracted shape', () => {
  it('VT-01 / DoD-0 creates the six tables, indexes, and delete rules', async () => {
    const tables = await query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1) ORDER BY table_name`,
      [[...BUILD_TABLES]],
    );
    expect(tables.map((row) => row.table_name)).toEqual([...BUILD_TABLES].sort());

    const indexes = await query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1)`,
      [INDEXES],
    );
    expect(indexes.map((row) => row.indexname).sort()).toEqual([...INDEXES].sort());

    const rules = await query<{ constraint_name: string; delete_rule: string }>(
      `SELECT tc.constraint_name, rc.delete_rule
       FROM information_schema.table_constraints tc
       JOIN information_schema.referential_constraints rc
         ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
       WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
         AND tc.table_name = ANY($1)`,
      [[...BUILD_TABLES, 'agent_runs']],
    );
    const byName = Object.fromEntries(rules.map((row) => [row.constraint_name, row.delete_rule]));
    expect(byName.fk_build_preview_leases_run).toBe('CASCADE');
    expect(byName.fk_agent_runs_build_task).toBe('SET NULL');
    for (const [name, rule] of Object.entries(byName)) {
      if (name === 'fk_build_preview_leases_run' || name === 'fk_agent_runs_build_task') continue;
      if (!name.startsWith('fk_build_')) continue;
      expect(rule).toBe('RESTRICT');
    }

    const columns = await query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'build_tasks'`,
    );
    const chain = columns.find((column) => column.column_name === 'chain_head_key');
    expect(chain?.is_nullable).toBe('YES');
    expect(columns.map((column) => column.column_name)).toEqual(expect.arrayContaining([
      'id', 'build_revision_id', 'task_key', 'role', 'depends_on', 'owned_files', 'covers',
      'reuse', 'run_mode', 'chain_head_key', 'branch_name', 'status', 'attempt', 'omitted_reason',
    ]));
  });
});

describe('VT-02 status checks accept the vocabulary and reject an invalid value', () => {
  it('VT-02 / DoD-3 accepts every run status and rejects __invalid__', async () => {
    const playbookRunId = await seedPlaybookRun();
    const runId = await seedBuildRun(playbookRunId);
    for (const status of BUILD_RUN_STATUSES) {
      const extras = status === 'suspended'
        ? `suspend_reason = 'cost_cap', suspended_from_status = 'planning', ended_at = NULL, pull_request_url = NULL, accepted_revision_number = NULL`
        : status === 'accepted'
          ? `suspend_reason = NULL, suspended_from_status = NULL, ended_at = now(), pull_request_url = 'https://example.test/pr/1', accepted_revision_number = 1`
          : status === 'cancelled' || status === 'failed'
            ? `suspend_reason = NULL, suspended_from_status = NULL, ended_at = now(), pull_request_url = NULL, accepted_revision_number = NULL`
            : `suspend_reason = NULL, suspended_from_status = NULL, ended_at = NULL, pull_request_url = NULL, accepted_revision_number = NULL`;
      await query(`UPDATE build_runs SET status = $2, ${extras} WHERE id = $1`, [runId, status]);
    }
    await expect(query(`UPDATE build_runs SET status = '__invalid__' WHERE id = $1`, [runId]))
      .rejects.toThrow(/build_runs_status_check/);

    await query(
      `UPDATE build_runs SET status = 'suspended', suspend_reason = 'cost_cap', suspended_from_status = 'planning', ended_at = NULL WHERE id = $1`,
      [runId],
    );
    for (const reason of BUILD_SUSPEND_REASONS) {
      await query(`UPDATE build_runs SET suspend_reason = $2 WHERE id = $1`, [runId, reason]);
    }
    await expect(query(`UPDATE build_runs SET suspend_reason = '__invalid__' WHERE id = $1`, [runId]))
      .rejects.toThrow(/build_runs_suspend_reason_check/);
  });

  it('VT-02 accepts task, verification, deployment, and event values', async () => {
    const playbookRunId = await seedPlaybookRun();
    const runId = await seedBuildRun(playbookRunId);
    const revisionId = await seedRevision(runId);
    const taskId = await seedTask(revisionId, 'implement-widget');
    for (const status of BUILD_TASK_STATUSES) {
      const reason = status === 'omitted' ? 'not needed' : null;
      await query(`UPDATE build_tasks SET status = $2, omitted_reason = $3 WHERE id = $1`, [taskId, status, reason]);
    }
    await expect(query(`UPDATE build_tasks SET status = '__invalid__', omitted_reason = NULL WHERE id = $1`, [taskId]))
      .rejects.toThrow(/build_tasks_status_check/);
    for (const role of BUILD_TASK_ROLES) {
      await query(`UPDATE build_tasks SET role = $2 WHERE id = $1`, [taskId, role]);
    }
    for (const mode of BUILD_TASK_RUN_MODES) {
      const head = mode === 'chain' ? 'implement-widget' : null;
      await query(`UPDATE build_tasks SET run_mode = $2, chain_head_key = $3 WHERE id = $1`, [taskId, mode, head]);
    }

    for (const kind of BUILD_VERIFICATION_KINDS) {
      const prefix = kind === 'risk_decision' ? 'RD' : kind.toUpperCase();
      await query(
        `INSERT INTO build_verification_rows (build_revision_id, requirement_id, kind, test_tier)
         VALUES ($1, $2, $3, 'unit')`,
        [revisionId, `${prefix}-1`, kind],
      );
    }
    await expect(query(
      `INSERT INTO build_verification_rows (build_revision_id, requirement_id, kind) VALUES ($1, 'AC-2', '__invalid__')`,
      [revisionId],
    )).rejects.toThrow(/build_verification_rows_kind_check/);

    for (const tier of BUILD_TEST_TIERS) {
      await query(
        `UPDATE build_verification_rows SET test_tier = $2 WHERE build_revision_id = $1 AND requirement_id = 'AC-1'`,
        [revisionId, tier],
      );
    }

    for (const deployment of BUILD_DEPLOYMENT_STATUSES) {
      const commit = ['queued', 'deploying', 'succeeded'].includes(deployment) ? COMMIT : null;
      const preview = deployment === 'succeeded' ? 'https://preview.example.test' : null;
      await query(
        `UPDATE build_revisions
         SET deployment_status = $2, validated_commit = $3, preview_url = $4
         WHERE id = $1`,
        [revisionId, deployment, commit, preview],
      );
    }
    await expect(query(
      `UPDATE build_revisions SET deployment_status = '__invalid__' WHERE id = $1`,
      [revisionId],
    )).rejects.toThrow(/build_revisions_deployment_status_check/);

    for (const severity of BUILD_EVENT_SEVERITIES) {
      await query(
        `INSERT INTO build_events (build_run_id, event_type, severity, message) VALUES ($1, 'build.started', $2, 'hello')`,
        [runId, severity],
      );
    }
    await expect(query(
      `INSERT INTO build_events (build_run_id, event_type, severity, message) VALUES ($1, 'build.started', '__invalid__', 'hello')`,
      [runId],
    )).rejects.toThrow(/build_events_severity_check/);
    for (const kind of BUILD_CORRELATION_KINDS) {
      await query(
        `INSERT INTO build_events (build_run_id, event_type, message, correlation_kind, correlation_id)
         VALUES ($1, 'build.started', 'linked', $2, 'ext-1')`,
        [runId, kind],
      );
    }
  });
});

describe('VT-03 one preview lease per project and repository', () => {
  it('VT-03 / DoD-3 rejects a second lease for the same pair and the same run', async () => {
    const firstPlaybook = await seedPlaybookRun();
    const secondPlaybook = await seedPlaybookRun();
    const otherPlaybook = await seedPlaybookRun();
    const first = await seedBuildRun(firstPlaybook, 'repo-a');
    const second = await seedBuildRun(secondPlaybook, 'repo-a');
    const other = await seedBuildRun(otherPlaybook, 'repo-b');
    const revisionA = await seedRevision(first);
    const revisionB = await seedRevision(second);
    const revisionC = await seedRevision(other);
    await query(
      `INSERT INTO build_preview_leases (project, repository, build_run_id, build_revision_id, expires_at)
       VALUES ('Apex', 'repo-a', $1, $2, now() + interval '1 hour')`,
      [first, revisionA],
    );
    await expect(query(
      `INSERT INTO build_preview_leases (project, repository, build_run_id, build_revision_id, expires_at)
       VALUES ('Apex', 'repo-a', $1, $2, now() + interval '1 hour')`,
      [second, revisionB],
    )).rejects.toThrow(/uq_build_preview_leases_project_repository/);
    await query(
      `INSERT INTO build_preview_leases (project, repository, build_run_id, build_revision_id, expires_at)
       VALUES ('Apex', 'repo-b', $1, $2, now() + interval '1 hour')`,
      [other, revisionC],
    );
    await expect(query(
      `INSERT INTO build_preview_leases (project, repository, build_run_id, build_revision_id, expires_at)
       VALUES ('Other', 'repo-c', $1, $2, now() + interval '1 hour')`,
      [first, revisionA],
    )).rejects.toThrow(/uq_build_preview_leases_run/);

    const racePlaybookA = await seedPlaybookRun();
    const racePlaybookB = await seedPlaybookRun();
    const raceA = await seedBuildRun(racePlaybookA, 'repo-race');
    const raceB = await seedBuildRun(racePlaybookB, 'repo-race');
    const raceRevisionA = await seedRevision(raceA);
    const raceRevisionB = await seedRevision(raceB);
    const otherClient = new pg.Client({ connectionString: scratch.connectionString });
    await otherClient.connect();
    const insert = `INSERT INTO build_preview_leases (project, repository, build_run_id, build_revision_id, expires_at)
      VALUES ('Apex', 'repo-race', $1, $2, now() + interval '1 hour')`;
    const raced = await Promise.allSettled([
      client.query(insert, [raceA, raceRevisionA]),
      otherClient.query(insert, [raceB, raceRevisionB]),
    ]);
    await otherClient.end();
    expect(raced.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(raced.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });
});

describe('VT-05 coherence checks refuse broken rows', () => {
  it('VT-05 refuses suspended, terminal, accepted, cap, repair, omitted, pass, and empty contacts', async () => {
    const playbookRunId = await seedPlaybookRun();
    const runId = await seedBuildRun(playbookRunId, 'repo-coherence');
    await expect(query(
      `UPDATE build_runs SET status = 'suspended', ended_at = NULL WHERE id = $1`,
      [runId],
    )).rejects.toThrow(/build_runs_suspended_coherence_check/);
    await expect(query(
      `UPDATE build_runs SET status = 'failed', ended_at = NULL WHERE id = $1`,
      [runId],
    )).rejects.toThrow(/build_runs_terminal_ended_at_check/);
    await expect(query(
      `UPDATE build_runs SET status = 'accepted', ended_at = now(), pull_request_url = NULL WHERE id = $1`,
      [runId],
    )).rejects.toThrow(/build_runs_accepted_pr_check/);
    await expect(query(`UPDATE build_runs SET parallelism_used = 9 WHERE id = $1`, [runId]))
      .rejects.toThrow(/build_runs_parallelism_used_check/);
    const emptyPlaybook = await seedPlaybookRun();
    await expect(query(
      `INSERT INTO build_runs (
         project, repository, requested_by_user_id, client_request_id, prompt, playbook_run_id,
         skill_snapshot, support_contacts, quality_manifest_snapshot,
         cost_cap_usd, elapsed_cap_seconds, parallelism_cap
       ) VALUES ('Apex', 'repo-empty', $1, 'empty-contacts', 'Build', $2, $3::jsonb, '[]'::jsonb, $4::jsonb, 10, 3600, 1)`,
      [USER_OID, emptyPlaybook, SNAPSHOT, MANIFEST],
    )).rejects.toThrow(/build_runs_support_contacts_check/);

    const revisionId = await seedRevision(runId);
    await expect(query(`UPDATE build_revisions SET repair_attempts = 3 WHERE id = $1`, [revisionId]))
      .rejects.toThrow(/build_revisions_repair_attempts_check/);
    await expect(query(
      `UPDATE build_revisions SET deployment_status = 'succeeded', validated_commit = $2, preview_url = NULL WHERE id = $1`,
      [revisionId, COMMIT],
    )).rejects.toThrow(/build_revisions_deployment_coherence_check/);

    const taskId = await seedTask(revisionId, 'omit-me');
    await expect(query(`UPDATE build_tasks SET status = 'omitted', omitted_reason = NULL WHERE id = $1`, [taskId]))
      .rejects.toThrow(/build_tasks_omitted_reason_check/);
    await expect(query(
      `UPDATE build_tasks SET run_mode = 'chain', chain_head_key = NULL WHERE id = $1`,
      [taskId],
    )).rejects.toThrow(/build_tasks_chain_head_coherence_check/);
    await expect(query(
      `UPDATE build_tasks SET run_mode = 'own_agent', chain_head_key = 'omit-me' WHERE id = $1`,
      [taskId],
    )).rejects.toThrow(/build_tasks_chain_head_coherence_check/);

    await expect(query(
      `INSERT INTO build_verification_rows (build_revision_id, requirement_id, kind, status, red_evidence)
       VALUES ($1, 'AC-4', 'ac', 'pass', NULL)`,
      [revisionId],
    )).rejects.toThrow(/build_verification_rows_pass_evidence_check/);
  });
});

describe('VT-06 frozen columns and the write-once branch', () => {
  it('VT-06 refuses snapshot edits and a second branch write', async () => {
    const playbookRunId = await seedPlaybookRun();
    const runId = await seedBuildRun(playbookRunId, 'repo-frozen');
    await expect(query(`UPDATE build_runs SET skill_snapshot = '{"changed":true}'::jsonb WHERE id = $1`, [runId]))
      .rejects.toThrow(/frozen columns/);
    await expect(query(`UPDATE build_runs SET prompt = 'a different prompt' WHERE id = $1`, [runId]))
      .rejects.toThrow(/frozen columns/);
    await expect(query(`UPDATE build_runs SET project = 'Other' WHERE id = $1`, [runId]))
      .rejects.toThrow(/frozen columns/);
    const [row] = await query<{ id: string }>(`SELECT id::text AS id FROM build_runs WHERE id = $1`, [runId]);
    await query(`UPDATE build_runs SET integration_branch = 'apex/build/' || id::text WHERE id = $1`, [runId]);
    const stored = await query<{ integration_branch: string }>(
      `SELECT integration_branch FROM build_runs WHERE id = $1`,
      [runId],
    );
    expect(stored[0].integration_branch).toBe(`apex/build/${row.id}`);
    await expect(query(`UPDATE build_runs SET integration_branch = 'apex/build/other' WHERE id = $1`, [runId]))
      .rejects.toThrow(/write-once/);
  });
});

describe('VT-22 append-only events', () => {
  it('VT-22 / AC-3 / DoD-3 refuses update and delete unless the purge flag is set', async () => {
    const playbookRunId = await seedPlaybookRun();
    const runId = await seedBuildRun(playbookRunId, 'repo-events');
    const [event] = await query<{ id: string }>(
      `INSERT INTO build_events (build_run_id, event_type, message) VALUES ($1, 'build.started', 'hello') RETURNING id`,
      [runId],
    );
    await expect(query(`UPDATE build_events SET message = 'changed' WHERE id = $1`, [event.id]))
      .rejects.toThrow(/append-only/);
    await expect(query(`DELETE FROM build_events WHERE id = $1`, [event.id]))
      .rejects.toThrow(/append-only/);

    await client.query('BEGIN');
    await client.query(`SELECT set_config('apex.build_events_purge', 'on', true)`);
    await client.query(`DELETE FROM build_events WHERE id = $1`, [event.id]);
    await client.query('COMMIT');
    const [setting] = await query<{ value: string | null }>(
      `SELECT current_setting('apex.build_events_purge', true) AS value`,
    );
    expect(setting.value).not.toBe('on');
    const left = await query(`SELECT id FROM build_events WHERE id = $1`, [event.id]);
    expect(left).toEqual([]);
  });
});

describe('VT-23 redacted events round-trip under 50 ms', () => {
  it('VT-23 / AC-0 / DoD-1 stores no secret and writes quickly', async () => {
    const playbookRunId = await seedPlaybookRun();
    const runId = await seedBuildRun(playbookRunId, 'repo-roundtrip');
    const bearer = ['Bear', 'er sk_live_', 'abcdefghij'].join('');
    const connection = ['Serv', 'er=db.internal;Pass', 'word=sup3rsecret'].join('');
    const known = ['known-', 'secret-value'].join('');
    const pool = new pg.Pool({ connectionString: scratch.connectionString });
    const scratchDb = drizzle(pool, { schema });
    const samples: number[] = [];
    try {
      for (let i = 0; i < 20; i += 1) {
        const start = performance.now();
        await appendBuildEvent({
          buildRunId: runId,
          eventType: 'task.completed',
          message: `step ${i} ${bearer} ${connection} ${known}`,
          detail: { note: bearer },
          dedupeKey: `round-${i}`,
        }, {
          executor: scratchDb,
          redact: (input) => redactText(input, { knownSecrets: () => [known] }),
          redactJson: (value) => redactJson(value, { knownSecrets: () => [known] }),
        });
        samples.push(performance.now() - start);
      }
    } finally {
      await pool.end();
    }
    samples.sort((left, right) => left - right);
    expect(samples[10]).toBeLessThan(50);
    const dump = await query<{ blob: string }>(
      `SELECT concat_ws(' ', id::text, ordinal::text, event_type, severity, message, detail::text,
              correlation_kind, correlation_id, actor_user_id, dedupe_key) AS blob
       FROM build_events WHERE build_run_id = $1`,
      [runId],
    );
    const text = dump.map((row) => row.blob).join('\n');
    expect(text).not.toContain(bearer);
    expect(text).not.toContain(connection);
    expect(text).not.toContain(known);
    expect(text).toContain('[REDACTED:');
  });
});

describe('VT-04 and VT-07 agent run link and rollback', () => {
  it('VT-04 / DoD-2 keeps old rows and enforces the build-task link', async () => {
    const linkScratch = await createScratchDatabase('buildlink');
    const linkClient = new pg.Client({ connectionString: linkScratch.connectionString });
    await linkClient.connect();
    try {
      await migrateDown(linkScratch.connectionString, await migrationsFrom(linkClient, AGENT_RUNS_MIGRATION));
      await linkClient.query(
        `INSERT INTO app_users (oid, display_name) VALUES ($1, 'link') ON CONFLICT (oid) DO NOTHING`,
        [USER_OID],
      );
      await linkClient.query(
        `INSERT INTO agent_runs (id, thread_id, status, timeout_at, workflow_class)
         VALUES ('legacy-null', 'thread', 'queued', now() + interval '1 hour', NULL),
                ('legacy-gen', 'thread', 'queued', now() + interval '1 hour', 'generation'),
                ('legacy-impl', 'thread', 'queued', now() + interval '1 hour', 'implementation')`,
      );
      await migrateUp(linkScratch.connectionString);
      const legacy = await linkClient.query<{ id: string; workflow_class: string | null; build_task_id: string | null }>(
        `SELECT id, workflow_class, build_task_id FROM agent_runs ORDER BY id`,
      );
      expect(legacy.rows).toEqual([
        { id: 'legacy-gen', workflow_class: 'generation', build_task_id: null },
        { id: 'legacy-impl', workflow_class: 'implementation', build_task_id: null },
        { id: 'legacy-null', workflow_class: null, build_task_id: null },
      ]);

      const [definition] = (await linkClient.query<{ id: string }>(
        `INSERT INTO playbook_definitions (project, name, created_by) VALUES ('Apex', 'link', $1) RETURNING id`,
        [USER_OID],
      )).rows;
      const [version] = (await linkClient.query<{ id: string }>(
        `INSERT INTO playbook_definition_versions (definition_id, version_number, graph, status, published_by, published_at)
         VALUES ($1, 1, '{"nodes":[],"edges":[]}'::jsonb, 'published', $2, now()) RETURNING id`,
        [definition.id, USER_OID],
      )).rows;
      const [playbookRun] = (await linkClient.query<{ id: string }>(
        `INSERT INTO playbook_runs (project, definition_version_id, initiator_user_id) VALUES ('Apex', $1, $2) RETURNING id`,
        [version.id, USER_OID],
      )).rows;
      const [buildRun] = (await linkClient.query<{ id: string }>(
        `INSERT INTO build_runs (
           project, repository, requested_by_user_id, client_request_id, prompt, playbook_run_id,
           skill_snapshot, support_contacts, quality_manifest_snapshot, cost_cap_usd, elapsed_cap_seconds, parallelism_cap
         ) VALUES ('Apex', 'apex', $1, 'link-req', 'Build', $2, $3::jsonb, $4::jsonb, $5::jsonb, 10, 3600, 1) RETURNING id`,
        [USER_OID, playbookRun.id, SNAPSHOT, CONTACTS, MANIFEST],
      )).rows;
      const [revision] = (await linkClient.query<{ id: string }>(
        `INSERT INTO build_revisions (build_run_id, revision_number) VALUES ($1, 1) RETURNING id`,
        [buildRun.id],
      )).rows;
      const [task] = (await linkClient.query<{ id: string }>(
        `INSERT INTO build_tasks (build_revision_id, task_key, role, run_mode) VALUES ($1, 'implement-widget', 'implementer', 'own_agent') RETURNING id`,
        [revision.id],
      )).rows;
      await linkClient.query(
        `INSERT INTO agent_runs (id, thread_id, status, timeout_at, workflow_class, build_task_id)
         VALUES ('build-live', 'thread', 'queued', now() + interval '1 hour', 'build-task', $1)`,
        [task.id],
      );
      await expect(linkClient.query(
        `INSERT INTO agent_runs (id, thread_id, status, timeout_at, workflow_class, build_task_id)
         VALUES ('build-live-2', 'thread', 'running', now() + interval '1 hour', 'build-task', $1)`,
        [task.id],
      )).rejects.toThrow(/uq_agent_runs_one_live_per_build_task/);
      await expect(linkClient.query(
        `INSERT INTO agent_runs (id, thread_id, status, timeout_at, workflow_class, build_task_id)
         VALUES ('wrong-class', 'thread', 'queued', now() + interval '1 hour', 'implementation', $1)`,
        [task.id],
      )).rejects.toThrow(/agent_runs_build_task_class_check/);
      await expect(linkClient.query(
        `INSERT INTO agent_runs (id, thread_id, status, timeout_at, workflow_class)
         VALUES ('bogus', 'thread', 'queued', now() + interval '1 hour', 'bogus')`,
      )).rejects.toThrow(/agent_runs_workflow_class_check/);
      await linkClient.query(
        `INSERT INTO agent_runs (id, thread_id, status, workflow_class, build_task_id)
         VALUES ('build-done', 'thread', 'completed', 'build-task', $1)`,
        [task.id],
      );
    } finally {
      await linkClient.end();
      await linkScratch.drop();
    }
  }, MIGRATE_TIMEOUT);

  it('VT-07 / DoD-0 rolls both migrations back', async () => {
    const downScratch = await createScratchDatabase('builddown');
    const downClient = new pg.Client({ connectionString: downScratch.connectionString });
    await downClient.connect();
    try {
      await migrateDown(downScratch.connectionString, await migrationsFrom(downClient, TABLES_MIGRATION));
      const tables = await downClient.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name = ANY($1)`,
        [[...BUILD_TABLES]],
      );
      expect(tables.rows).toEqual([]);
      const columns = await downClient.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'agent_runs' AND column_name = 'build_task_id'`,
      );
      expect(columns.rows).toEqual([]);
      const thread = await downClient.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'agent_runs' AND column_name = 'thread_id'`,
      );
      expect(thread.rows).toHaveLength(1);
      const check = await downClient.query<{ def: string }>(
        `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'agent_runs_workflow_class_check'`,
      );
      expect(check.rows[0].def).not.toContain('build-task');
      expect(check.rows[0].def).toContain('implementation');
    } finally {
      await downClient.end();
      await downScratch.drop();
    }
  }, MIGRATE_TIMEOUT);
});
