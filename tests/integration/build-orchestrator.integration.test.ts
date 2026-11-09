/**
 * FEAT-004 admission, list query, and the parked build step on a scratch database.
 * Covers VT-07, VT-12, VT-21, and VT-34.
 *
 * Drizzle binds its pool at module load, so DATABASE_URL is pointed at the scratch database before
 * the services are required. Nothing above may import anything that reaches `db/drizzle`.
 */
import pg from 'pg';
import type { FrozenBuildRunConfig } from '../../src/shared/types/buildPreflight';
import { createScratchDatabase, ScratchDatabase } from './support/scratch-db';

jest.mock('../../src/server/services/playbookAdvanceService', () => ({
  advanceRun: jest.fn(async () => undefined),
  beginRun: jest.fn(async () => undefined),
  advanceStalledRuns: jest.fn(async () => undefined),
}));

type StartBuildModule = typeof import('../../src/server/services/buildOrchestrator/startBuild');
type QueryModule = typeof import('../../src/server/services/buildQueryService');
type PlanningModule = typeof import('../../src/server/services/buildOrchestrator/planning');
type ProjectionModule = typeof import('../../src/server/services/playbookRunProjectionService');
type AdvanceModule = typeof import('../../src/server/services/playbookAdvanceService');

const MIGRATE_TIMEOUT = 600_000;
const USER_OID = 'feat004-orchestrator-user';
const DAY_MS = 24 * 60 * 60 * 1000;

let scratch: ScratchDatabase;
let client: pg.Client;
let pool: { end: () => Promise<void> };
let startBuild: StartBuildModule;
let buildQuery: QueryModule;
let planning: PlanningModule;
let projection: ProjectionModule;
let advance: AdvanceModule;
let settingsId: string;

const CONFIG = {
  roles: Object.fromEntries(
    ['intake', 'planner', 'implementer', 'qa', 'check'].map((role) => [
      role,
      { skillPath: `.cursor/skills/${role}/SKILL.md`, skillSha256: 'a'.repeat(64), model: 'composer', modelSource: 'profile' },
    ]),
  ),
  caps: { costUsd: 25, elapsedMinutesPerRevision: 240, maxRevisions: 5, maxParallelism: 2, repairAttempts: 2 },
  supportContacts: [{ userId: USER_OID, displayName: 'Dev' }],
  standards: {
    designSystem: { path: 'docs/design.md', sha256: 'b'.repeat(64) },
    codingRules: [{ path: '.cursor/rules/code.mdc', sha256: 'c'.repeat(64) }],
    codeMap: { path: '.cursor/CODEMAP.md', sha256: 'd'.repeat(64) },
  },
  qualityManifest: {
    path: 'quality.json',
    sha256: 'e'.repeat(64),
    commands: { typeCheck: 'tsc', lint: 'eslint', relatedTests: 'jest', unitSuite: 'jest' },
  },
} as unknown as FrozenBuildRunConfig;

async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const { rows } = await client.query<T>(text, values);
  return rows;
}

function admit(project: string, clientRequestId: string) {
  return startBuild.admitBuild({
    command: {
      requesterUserId: USER_OID,
      project,
      repository: 'apex',
      prompt: 'Add a reports page',
      clientRequestId,
    },
    settingsId,
    config: CONFIG,
    now: new Date(),
  });
}

beforeAll(async () => {
  scratch = await createScratchDatabase('buildorch');

  process.env.DATABASE_URL = scratch.connectionString;
  /* eslint-disable @typescript-eslint/no-require-imports --
     Required rather than imported so the pool is built after DATABASE_URL points at the scratch
     database. A static import is hoisted and would bind to whatever URL was set at file load. */
  startBuild = require('../../src/server/services/buildOrchestrator/startBuild');
  buildQuery = require('../../src/server/services/buildQueryService');
  planning = require('../../src/server/services/buildOrchestrator/planning');
  projection = require('../../src/server/services/playbookRunProjectionService');
  advance = require('../../src/server/services/playbookAdvanceService');
  pool = require('../../src/server/db').default;
  /* eslint-enable @typescript-eslint/no-require-imports */

  client = new pg.Client({ connectionString: scratch.connectionString });
  await client.connect();
  await query(
    `INSERT INTO app_users (oid, display_name) VALUES ($1, 'FEAT-004 Orchestrator') ON CONFLICT (oid) DO NOTHING`,
    [USER_OID],
  );
  const [settings] = await query<{ id: string }>(
    `INSERT INTO project_skill_settings (project, skill_repo, skill_branch, friendly_name, is_default)
     VALUES ('Apex', 'apex', 'main', 'Apex', true) RETURNING id`,
  );
  settingsId = settings.id;
}, MIGRATE_TIMEOUT);

afterAll(async () => {
  if (client) await client.end();
  if (pool) await pool.end();
  if (scratch) await scratch.drop();
});

beforeEach(async () => {
  await query(`DELETE FROM build_runs`);
});

describe('VT-07 one build per client request under concurrency', () => {
  it('two simultaneous starts with the same client request id create one row', async () => {
    const [first, second] = await Promise.all([admit('Apex', 'same-id'), admit('Apex', 'same-id')]);
    expect(first.build.id).toBe(second.build.id);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    const rows = await query(`SELECT id FROM build_runs WHERE client_request_id = 'same-id'`);
    expect(rows).toHaveLength(1);
  });
});

describe('VT-12 concurrent starts respect both caps', () => {
  it('4 projects x 4 starts admit 10, queue 6, and never more than 3 per project', async () => {
    const projects = ['P1', 'P2', 'P3', 'P4'];
    await Promise.all(
      projects.flatMap((project) =>
        [1, 2, 3, 4].map((n) => admit(project, `${project}-${n}`)),
      ),
    );
    const byStatus = await query<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM build_runs GROUP BY status`,
    );
    const counts = Object.fromEntries(byStatus.map((row) => [row.status, row.n]));
    expect(counts).toEqual({ intake: 10, queued: 6 });

    const perProject = await query<{ project: string; n: number }>(
      `SELECT project, count(*)::int AS n FROM build_runs WHERE status = 'intake' GROUP BY project`,
    );
    expect(Math.max(...perProject.map((row) => row.n))).toBeLessThanOrEqual(3);

    const queued = await query<{ playbook_run_id: string | null; queued_at: string | null }>(
      `SELECT playbook_run_id, queued_at FROM build_runs WHERE status = 'queued'`,
    );
    expect(queued.every((row) => row.playbook_run_id === null && row.queued_at !== null)).toBe(true);
  });
});

describe('VT-21 the list stays fast at 500 builds', () => {
  it('pages 500 project builds with p95 under 500 ms and ignores other projects', async () => {
    const insert = (project: string, count: number) => query(
      `INSERT INTO build_runs (
         project, repository, requested_by_user_id, client_request_id, prompt, status, queued_at,
         skill_snapshot, support_contacts, quality_manifest_snapshot,
         cost_cap_usd, elapsed_cap_seconds, parallelism_cap
       )
       SELECT $1, 'apex', $2, $1 || '-' || g, 'Build the widget', 'queued', now() - (g || ' seconds')::interval,
         '{"intake":{}}'::jsonb, '[{"userId":"u","displayName":"Dev","email":""}]'::jsonb,
         '{"typeCheck":"tsc","lint":"eslint","relatedTests":"jest","unitSuite":"jest"}'::jsonb,
         25, 14400, 2
       FROM generate_series(1, $3::int) AS g`,
      [project, USER_OID, count],
    );
    await insert('Apex', 500);
    await insert('Other', 50);

    const samples: number[] = [];
    let total = 0;
    let firstPage: Awaited<ReturnType<QueryModule['listBuilds']>> | null = null;
    for (let i = 0; i < 20; i += 1) {
      const started = performance.now();
      const page = await buildQuery.listBuilds({
        project: 'Apex',
        requesterUserId: USER_OID,
        scope: 'project',
        state: 'all',
        limit: 50,
        offset: (i % 10) * 50,
      });
      samples.push(performance.now() - started);
      total = page.total;
      firstPage ??= page;
    }
    samples.sort((left, right) => left - right);
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1];

    expect(total).toBe(500);
    expect(firstPage?.builds).toHaveLength(50);
    expect(firstPage?.builds.every((build) => !('prompt' in build))).toBe(true);
    expect(firstPage?.builds[0].queuePosition).toBeGreaterThan(0);
    expect(p95).toBeLessThan(500);
  });
});

describe('VT-34 a parked build step survives a restart and resumes', () => {
  it('reports the build wait with its deadline, then completes the step when the build ends', async () => {
    const [definition] = await query<{ id: string }>(
      `INSERT INTO playbook_definitions (project, name, created_by) VALUES ('Apex', $1, $2) RETURNING id`,
      [`build-parked-${Date.now()}`, USER_OID],
    );
    const [version] = await query<{ id: string }>(
      `INSERT INTO playbook_definition_versions (definition_id, version_number, graph, status, published_by, published_at)
       VALUES ($1, 1, '{"nodes":[],"edges":[]}'::jsonb, 'published', $2, now()) RETURNING id`,
      [definition.id, USER_OID],
    );
    const [run] = await query<{ id: string }>(
      `INSERT INTO playbook_runs (project, definition_version_id, initiator_user_id, status)
       VALUES ('Apex', $1, $2, 'suspended') RETURNING id`,
      [version.id, USER_OID],
    );
    const expiresAt = new Date(Date.now() + 14 * DAY_MS).toISOString();
    const [build] = await query<{ id: string }>(
      `INSERT INTO build_runs (
         project, repository, requested_by_user_id, client_request_id, prompt, status, started_at,
         playbook_run_id, skill_snapshot, support_contacts, quality_manifest_snapshot,
         cost_cap_usd, elapsed_cap_seconds, parallelism_cap
       ) VALUES (
         'Apex', 'apex', $1, 'parked', 'Build the widget', 'intake', now(),
         $2, '{"intake":{}}'::jsonb, '[{"userId":"u","displayName":"Dev","email":""}]'::jsonb,
         '{"typeCheck":"tsc","lint":"eslint","relatedTests":"jest","unitSuite":"jest"}'::jsonb,
         25, 14400, 2
       ) RETURNING id`,
      [USER_OID, run.id],
    );
    const [step] = await query<{ id: string }>(
      `INSERT INTO playbook_step_runs (run_id, step_id, step_type, status, expires_at, resume_token)
       VALUES ($1, 'build', 'build', 'suspended', $2, $3) RETURNING id`,
      [run.id, expiresAt, build.id],
    );
    expect(await planning.beginPlanning(build.id, step.id)).toBe(true);

    const detail = await projection.getRun('Apex', run.id);
    expect(detail?.suspension).toMatchObject({ stepId: 'build', reason: 'build' });
    expect(new Date(detail?.suspension?.deadline ?? 0).toISOString()).toBe(expiresAt);

    await planning.reportBuildTerminal(build.id, { buildRunId: build.id, status: 'accepted' });

    const [after] = await query<{ status: string; run_status: string }>(
      `SELECT s.status, r.status AS run_status
       FROM playbook_step_runs s JOIN playbook_runs r ON r.id = s.run_id WHERE s.id = $1`,
      [step.id],
    );
    expect(after).toEqual({ status: 'completed', run_status: 'running' });
    expect(advance.advanceRun).toHaveBeenCalledWith(run.id);

    const [row] = await query<{ status: string; playbook_step_run_id: string }>(
      `SELECT status, playbook_step_run_id FROM build_runs WHERE id = $1`,
      [build.id],
    );
    expect(row).toEqual({ status: 'planning', playbook_step_run_id: step.id });
  });
});
