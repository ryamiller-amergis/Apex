/**
 * FEAT-001 — evaluation tables, guards and seeds on a real Postgres.
 *
 * Uses the scratch-database harness (tests/integration/support/scratch-db.ts),
 * which is what `npm run test:integration` actually runs. The tech spec named
 * src/server/__tests__/workflowEvaluationSchema.integration.test.ts; that path
 * is not included by jest.config.integration.js.
 *
 * Covers VT-02 through VT-06 and VT-08 through VT-12.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import pg from 'pg';
import {
  createScratchDatabase,
  migrateDown,
  type ScratchDatabase,
} from './support/scratch-db';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, '../..');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'migrations');
const MIGRATE_CLI = path.join(REPO_ROOT, 'node_modules/node-pg-migrate/bin/node-pg-migrate.js');
const MIGRATE_TIMEOUT = 600_000;

const USER_OID = 'workflow-eval-reviewer';
const VALID_HASH = 'a'.repeat(64);
const SCORES = JSON.stringify({
  intent_alignment: 5,
  requirements_coverage: 4,
  scope_alignment: 3,
  acceptance_criteria: 2,
  readiness: 1,
});

const EVAL_TABLES = [
  'workflow_evaluation_definitions',
  'workflow_evaluation_events',
  'workflow_evaluation_jobs',
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

async function migrateUp(connectionString: string): Promise<void> {
  await execFileAsync(
    process.execPath,
    [MIGRATE_CLI, 'up', '--no-check-order', '--migrations-dir', MIGRATIONS_DIR],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, DATABASE_URL: connectionString },
      maxBuffer: 32 * 1024 * 1024,
    },
  );
}

async function columnNames(table: string): Promise<string[]> {
  const rows = await query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY column_name`,
    [table],
  );
  return rows.map((row) => row.column_name);
}

async function definitionId(stageKey: string): Promise<string> {
  const [row] = await query<{ id: string }>(
    `SELECT id FROM workflow_evaluation_definitions
     WHERE process_key = 'orchestrated_workflow' AND stage_key = $1 AND version = 1`,
    [stageKey],
  );
  if (!row) throw new Error(`Missing seeded definition ${stageKey}`);
  return row.id;
}

async function insertEvent(fields: {
  definitionId: string;
  subjectType: 'interview_phase' | 'prd';
  subjectId: string;
  stageKey: string;
  phaseIndex: number | null;
  interviewId?: string | null;
  prdId?: string | null;
  artifactHash?: string;
  correctedText?: string | null;
  correctedBlob?: string | null;
}): Promise<string> {
  const [row] = await query<{ id: string }>(
    `INSERT INTO workflow_evaluation_events (
       project, definition_id, subject_type, subject_id, stage_key, phase_index,
       reviewer_user_id, reviewer_role_key, reviewer_role_label,
       interview_id, prd_id, artifact_hash, criteria_scores, outcome, reason_codes,
       corrected_artifact_text, corrected_artifact_blob_ref
     ) VALUES (
       'Apex', $1, $2, $3, $4, $5,
       $6, 'ba', 'BA',
       $7, $8, $9, $10::jsonb, 'accept_unchanged', '[]'::jsonb,
       $11, $12::jsonb
     ) RETURNING id`,
    [
      fields.definitionId,
      fields.subjectType,
      fields.subjectId,
      fields.stageKey,
      fields.phaseIndex,
      USER_OID,
      fields.interviewId ?? null,
      fields.prdId ?? null,
      fields.artifactHash ?? VALID_HASH,
      SCORES,
      fields.correctedText ?? null,
      fields.correctedBlob ?? null,
    ],
  );
  return row.id;
}

beforeAll(async () => {
  scratch = await createScratchDatabase('wfeval');
  client = new pg.Client({ connectionString: scratch.connectionString });
  await client.connect();
  await query(
    `INSERT INTO app_users (oid, display_name) VALUES ($1, 'Workflow Eval Reviewer')
     ON CONFLICT (oid) DO NOTHING`,
    [USER_OID],
  );
}, MIGRATE_TIMEOUT);

afterAll(async () => {
  if (client) await client.end();
  if (scratch) await scratch.drop();
});

describe('VT-08 — seeded evaluation definitions', () => {
  it('DoD-0 has four active orchestrated_workflow stages with the shared rubric parts', async () => {
    const rows = await query<{
      stage_key: string;
      criteria_count: number;
      reason_count: number;
      outcome_count: number;
      role_count: number;
      suite_ref: string;
      has_schema: boolean;
    }>(
      `SELECT stage_key,
              jsonb_array_length(rubric -> 'criteria') AS criteria_count,
              jsonb_array_length(rubric -> 'reasonCodes') AS reason_count,
              jsonb_array_length(rubric -> 'outcomes') AS outcome_count,
              jsonb_array_length(rubric -> 'allowedReviewerRoles') AS role_count,
              promptfoo_suite_ref AS suite_ref,
              judge_output_schema IS NOT NULL AS has_schema
       FROM workflow_evaluation_definitions
       WHERE process_key = 'orchestrated_workflow' AND active = true
       ORDER BY stage_key`,
    );
    expect(rows.map((row) => row.stage_key)).toEqual([
      'interview_phase_1',
      'interview_phase_2',
      'interview_phase_3',
      'prd_human_review',
    ]);
    for (const row of rows) {
      expect(Number(row.criteria_count)).toBe(5);
      expect(Number(row.reason_count)).toBe(7);
      expect(Number(row.outcome_count)).toBe(4);
      expect(Number(row.role_count)).toBe(6);
      expect(row.suite_ref.trim().length).toBeGreaterThan(0);
      expect(row.has_schema).toBe(true);
    }
  });
});

describe('VT-03 / VT-04 — event immutability and job uniqueness', () => {
  it('DoD NFR UPDATE and DELETE on an event raise 23000 and leave the row', async () => {
    const subjectId = '00000000-0000-4000-8000-000000000101';
    const eventId = await insertEvent({
      definitionId: await definitionId('interview_phase_1'),
      subjectType: 'interview_phase',
      subjectId,
      stageKey: 'interview_phase_1',
      phaseIndex: 1,
      interviewId: subjectId,
    });

    await expect(
      query(`UPDATE workflow_evaluation_events SET comment = 'changed' WHERE id = $1`, [eventId]),
    ).rejects.toMatchObject({ code: '23000' });
    await expect(
      query(`DELETE FROM workflow_evaluation_events WHERE id = $1`, [eventId]),
    ).rejects.toMatchObject({ code: '23000' });

    const [row] = await query<{ comment: string | null }>(
      `SELECT comment FROM workflow_evaluation_events WHERE id = $1`,
      [eventId],
    );
    expect(row.comment).toBeNull();
  });

  it('a second job for the same event and evaluator raises 23505', async () => {
    const subjectId = '00000000-0000-4000-8000-000000000102';
    const eventId = await insertEvent({
      definitionId: await definitionId('interview_phase_1'),
      subjectType: 'interview_phase',
      subjectId,
      stageKey: 'interview_phase_1',
      phaseIndex: 1,
      interviewId: subjectId,
    });

    await query(
      `INSERT INTO workflow_evaluation_jobs (event_id, evaluator_key) VALUES ($1, 'promptfoo')`,
      [eventId],
    );
    await expect(
      query(
        `INSERT INTO workflow_evaluation_jobs (event_id, evaluator_key) VALUES ($1, 'promptfoo')`,
        [eventId],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    await query(
      `INSERT INTO workflow_evaluation_jobs (event_id, evaluator_key) VALUES ($1, 'llm_judge')`,
      [eventId],
    );

    const rows = await query<{ evaluator_key: string }>(
      `SELECT evaluator_key FROM workflow_evaluation_jobs WHERE event_id = $1 ORDER BY evaluator_key`,
      [eventId],
    );
    expect(rows.map((row) => row.evaluator_key)).toEqual(['llm_judge', 'promptfoo']);
  });
});

describe('VT-05 — subject, hash and correction checks', () => {
  const interviewDefinition = async () => definitionId('interview_phase_1');
  const prdDefinition = async () => definitionId('prd_human_review');

  it('accepts interview phases 1 and 3 and a 64-character lowercase hash', async () => {
    const phaseOne = '00000000-0000-4000-8000-000000000201';
    const phaseThree = '00000000-0000-4000-8000-000000000203';
    const definition = await interviewDefinition();
    await expect(
      insertEvent({
        definitionId: definition,
        subjectType: 'interview_phase',
        subjectId: phaseOne,
        stageKey: 'interview_phase_1',
        phaseIndex: 1,
        interviewId: phaseOne,
      }),
    ).resolves.toEqual(expect.any(String));
    await expect(
      insertEvent({
        definitionId: definition,
        subjectType: 'interview_phase',
        subjectId: phaseThree,
        stageKey: 'interview_phase_3',
        phaseIndex: 3,
        interviewId: phaseThree,
      }),
    ).resolves.toEqual(expect.any(String));
  });

  it('rejects phase 0, phase 4, a PRD with a phase, a short or uppercase hash, a mismatched prd id, and both correction fields', async () => {
    const definition = await interviewDefinition();
    const prdDef = await prdDefinition();
    const rejected: Array<() => Promise<unknown>> = [
      () => {
        const subjectId = '00000000-0000-4000-8000-000000000210';
        return insertEvent({
          definitionId: definition,
          subjectType: 'interview_phase',
          subjectId,
          stageKey: 'interview_phase_1',
          phaseIndex: 0,
          interviewId: subjectId,
        });
      },
      () => {
        const subjectId = '00000000-0000-4000-8000-000000000214';
        return insertEvent({
          definitionId: definition,
          subjectType: 'interview_phase',
          subjectId,
          stageKey: 'interview_phase_1',
          phaseIndex: 4,
          interviewId: subjectId,
        });
      },
      () => {
        const subjectId = '00000000-0000-4000-8000-000000000220';
        return insertEvent({
          definitionId: prdDef,
          subjectType: 'prd',
          subjectId,
          stageKey: 'prd_human_review',
          phaseIndex: 2,
          prdId: subjectId,
        });
      },
      () => {
        const subjectId = '00000000-0000-4000-8000-000000000221';
        return insertEvent({
          definitionId: prdDef,
          subjectType: 'prd',
          subjectId,
          stageKey: 'prd_human_review',
          phaseIndex: null,
          prdId: subjectId,
          artifactHash: 'a'.repeat(63),
        });
      },
      () => {
        const subjectId = '00000000-0000-4000-8000-000000000222';
        return insertEvent({
          definitionId: prdDef,
          subjectType: 'prd',
          subjectId,
          stageKey: 'prd_human_review',
          phaseIndex: null,
          prdId: subjectId,
          artifactHash: 'A'.repeat(64),
        });
      },
      () => {
        const subjectId = '00000000-0000-4000-8000-000000000223';
        return insertEvent({
          definitionId: prdDef,
          subjectType: 'prd',
          subjectId,
          stageKey: 'prd_human_review',
          phaseIndex: null,
          prdId: '00000000-0000-4000-8000-000000000299',
        });
      },
      () => {
        const subjectId = '00000000-0000-4000-8000-000000000224';
        return insertEvent({
          definitionId: prdDef,
          subjectType: 'prd',
          subjectId,
          stageKey: 'prd_human_review',
          phaseIndex: null,
          prdId: subjectId,
          correctedText: 'edited prd',
          correctedBlob: JSON.stringify({ container: 'artifacts', key: 'prd.md' }),
        });
      },
    ];

    for (const attempt of rejected) {
      await expect(attempt()).rejects.toMatchObject({ code: '23514' });
    }

    const subjectId = '00000000-0000-4000-8000-000000000225';
    await expect(
      insertEvent({
        definitionId: prdDef,
        subjectType: 'prd',
        subjectId,
        stageKey: 'prd_human_review',
        phaseIndex: null,
        prdId: subjectId,
      }),
    ).resolves.toEqual(expect.any(String));
  });
});

describe('VT-09 / VT-10 / VT-11 / VT-12 — definition versioning guards', () => {
  it('VT-09 rejects a second active row for the same process, stage, evaluator and benchmark', async () => {
    const [existing] = await query<{
      rubric: unknown;
      promptfoo_suite_ref: string;
      judge_output_schema: unknown;
    }>(
      `SELECT rubric, promptfoo_suite_ref, judge_output_schema
       FROM workflow_evaluation_definitions
       WHERE stage_key = 'interview_phase_3' AND version = 1`,
    );
    await expect(
      query(
        `INSERT INTO workflow_evaluation_definitions (
           process_key, stage_key, evaluator_key, benchmark_key, version,
           rubric, promptfoo_suite_ref, judge_output_schema, active
         ) VALUES (
           'orchestrated_workflow', 'interview_phase_3', 'human_review', 'baseline', 2,
           $1::jsonb, $2, $3::jsonb, true
         )`,
        [
          JSON.stringify(existing.rubric),
          existing.promptfoo_suite_ref,
          JSON.stringify(existing.judge_output_schema),
        ],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('VT-10 running the seed statements again adds no rows', async () => {
    const [before] = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM workflow_evaluation_definitions`,
    );
    const seedFile = fs
      .readdirSync(MIGRATIONS_DIR)
      .find((name) => name.endsWith('_workflow-evaluation-seeds.sql'));
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, seedFile as string), 'utf8');
    const [up = ''] = sql.split(/-- Down Migration/i);
    const insertAt = up.search(/INSERT\s+INTO\s+workflow_evaluation_definitions/i);
    expect(insertAt).toBeGreaterThanOrEqual(0);
    await client.query(up.slice(insertAt));
    const [after] = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM workflow_evaluation_definitions`,
    );
    expect(after.count).toBe(before.count);
    expect(Number(after.count)).toBe(4);
  });

  it('VT-12 rejects a rubric edit and allows an active-flag change', async () => {
    const [before] = await query<{ id: string; rubric: unknown }>(
      `SELECT id, rubric FROM workflow_evaluation_definitions
       WHERE stage_key = 'interview_phase_2' AND version = 1`,
    );
    await expect(
      query(`UPDATE workflow_evaluation_definitions SET rubric = '{}'::jsonb WHERE id = $1`, [
        before.id,
      ]),
    ).rejects.toMatchObject({ code: '23000' });
    const [unchanged] = await query<{ rubric: unknown }>(
      `SELECT rubric FROM workflow_evaluation_definitions WHERE id = $1`,
      [before.id],
    );
    expect(unchanged.rubric).toEqual(before.rubric);

    await query(
      `UPDATE workflow_evaluation_definitions SET active = false WHERE id = $1`,
      [before.id],
    );
    const [inactive] = await query<{ active: boolean }>(
      `SELECT active FROM workflow_evaluation_definitions WHERE id = $1`,
      [before.id],
    );
    expect(inactive.active).toBe(false);
    await query(
      `UPDATE workflow_evaluation_definitions SET active = true WHERE id = $1`,
      [before.id],
    );
  });

  it('VT-11 keeps version 1 for an event after a version 2 row becomes the active one', async () => {
    const subjectId = '00000000-0000-4000-8000-000000000301';
    const versionOneId = await definitionId('interview_phase_1');
    const eventId = await insertEvent({
      definitionId: versionOneId,
      subjectType: 'interview_phase',
      subjectId,
      stageKey: 'interview_phase_1',
      phaseIndex: 1,
      interviewId: subjectId,
    });

    await query(
      `UPDATE workflow_evaluation_definitions SET active = false WHERE id = $1`,
      [versionOneId],
    );
    await query(
      `INSERT INTO workflow_evaluation_definitions (
         process_key, stage_key, evaluator_key, benchmark_key, version,
         rubric, promptfoo_suite_ref, judge_output_schema, active
       )
       SELECT process_key, stage_key, evaluator_key, benchmark_key, 2,
              rubric, promptfoo_suite_ref, judge_output_schema, true
       FROM workflow_evaluation_definitions
       WHERE id = $1`,
      [versionOneId],
    );

    const active = await query<{ version: number }>(
      `SELECT version FROM workflow_evaluation_definitions
       WHERE stage_key = 'interview_phase_1' AND active = true`,
    );
    expect(active).toEqual([{ version: 2 }]);
    const kept = await query<{ id: string }>(
      `SELECT id FROM workflow_evaluation_definitions WHERE id = $1 AND version = 1`,
      [versionOneId],
    );
    expect(kept).toHaveLength(1);
    const [event] = await query<{ definition_id: string; version: number }>(
      `SELECT e.definition_id, d.version
       FROM workflow_evaluation_events e
       JOIN workflow_evaluation_definitions d ON d.id = e.definition_id
       WHERE e.id = $1`,
      [eventId],
    );
    expect(event.definition_id).toBe(versionOneId);
    expect(event.version).toBe(1);
  });
});

describe('VT-02 / VT-06 — rollback and untouched prds and interviews', () => {
  it('DoD-3 down removes the tables and functions, leaves prds and interviews unchanged, and up applies again', async () => {
    await client.end();
    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((file) => file.endsWith('.sql'))
      .sort();
    const firstEvaluation = files.findIndex((file) => file.startsWith('20261016154817'));
    const lastEvaluation = files.findIndex((file) => file.startsWith('20261016161100'));
    if (firstEvaluation < 0 || lastEvaluation < firstEvaluation) {
      throw new Error(
        'Missing the workflow evaluation migrations (20261016154817 through 20261016161100).',
      );
    }
    // Later migrations may change prds or interviews, so they are rolled back
    // before the columns the evaluation group must leave alone are recorded.
    const laterMigrations = files.length - lastEvaluation - 1;
    if (laterMigrations > 0) {
      await migrateDown(scratch.connectionString, laterMigrations);
    }
    client = new pg.Client({ connectionString: scratch.connectionString });
    await client.connect();
    const prdsBefore = await columnNames('prds');
    const interviewsBefore = await columnNames('interviews');
    await client.end();

    // Tables, rubric seeds, permissions, and the feature-flag seed.
    await migrateDown(scratch.connectionString, lastEvaluation - firstEvaluation + 1);

    client = new pg.Client({ connectionString: scratch.connectionString });
    await client.connect();

    const present = await query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [EVAL_TABLES],
    );
    expect(present).toEqual([]);
    const functions = await query<{ proname: string }>(
      `SELECT proname FROM pg_proc
       WHERE proname IN (
         'workflow_evaluation_events_immutable',
         'workflow_evaluation_definitions_active_only'
       )`,
    );
    expect(functions).toEqual([]);
    expect(await columnNames('prds')).toEqual(prdsBefore);
    expect(await columnNames('interviews')).toEqual(interviewsBefore);

    await client.end();
    await migrateUp(scratch.connectionString);
    client = new pg.Client({ connectionString: scratch.connectionString });
    await client.connect();

    const restored = await query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1)
       ORDER BY table_name`,
      [EVAL_TABLES],
    );
    expect(restored.map((row) => row.table_name)).toEqual([...EVAL_TABLES].sort());
    const [count] = await query<{ count: string }>(
      `SELECT count(*)::text AS count FROM workflow_evaluation_definitions WHERE active = true`,
    );
    expect(count.count).toBe('4');
  }, MIGRATE_TIMEOUT);
});
