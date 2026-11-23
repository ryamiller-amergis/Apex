/**
 * Store behavior that decides what a sweep or a run does next. The Drizzle client is a recording
 * stub: every query step returns the chain, and awaiting the chain gives the queued result.
 */
type Step = { method: string; args: unknown[] };

const queued: unknown[] = [];
const recorded: Step[][] = [];

function chain(): unknown {
  const steps: Step[] = [];
  recorded.push(steps);
  const proxy: unknown = new Proxy(
    {},
    {
      get: (_target, property: string) => {
        if (property === 'then') {
          return (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve(queued.shift()).then(resolve, reject);
        }
        return (...args: unknown[]) => {
          steps.push({ method: property, args });
          return proxy;
        };
      },
    },
  );
  return proxy;
}

jest.mock('../db/drizzle', () => ({
  db: {
    select: () => chain(),
    insert: () => chain(),
    update: () => chain(),
    delete: () => chain(),
  },
}));

import { PgDialect } from 'drizzle-orm/pg-core';
import {
  completeAnalysis,
  deleteAnalysis,
  failAnalysis,
  failStaleRunningAnalyses,
  getAnalysisForPost,
  getLastPostedAnalysis,
  getTeamsWebhook,
  hasRunningAnalysis,
  insertManualAnalysis,
  InvalidTeamsWebhookError,
  listFailedTeamsPosts,
  listPendingAnalyses,
  markAnalysisRunning,
  markTeamsFailed,
  markTeamsPosted,
  markTeamsSkipped,
  recordAdmissionFailure,
  revertAnalysisToPending,
  upsertSettings,
} from '../services/incidentTriageStore';
import { decryptWebhookUrl } from '../services/incidentTriageWebhookCrypto';

const PROJECT = 'Apex';
const GROUP_A = 'a'.repeat(32);
const GROUP_B = 'b'.repeat(32);
const RUN_ID = '11111111-2222-4333-8444-555555555555';

function settingsRow(overrides: Record<string, unknown> = {}) {
  return {
    project: PROJECT,
    enabled: true,
    assignmentGroupIds: [GROUP_A],
    backfillDays: 7,
    watermark: '2026-11-20T11:00:00.000Z',
    lastSweepAt: null,
    lastSweepError: null,
    teamsWebhook: null,
    updatedBy: null,
    updatedAt: '2026-11-20T11:00:00.000Z',
    ...overrides,
  };
}

function stepArgs(steps: Step[], method: string): unknown[] | undefined {
  return steps.find((step) => step.method === method)?.args;
}

function upsertSet(): Record<string, unknown> {
  const insertSteps = recorded.find((steps) => steps.some((step) => step.method === 'onConflictDoUpdate'));
  const options = stepArgs(insertSteps ?? [], 'onConflictDoUpdate')?.[0] as { set: Record<string, unknown> };
  return options.set;
}

let previousSecret: string | undefined;

beforeEach(() => {
  queued.length = 0;
  recorded.length = 0;
  previousSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = 'unit-test-session-secret';
});

afterEach(() => {
  if (previousSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = previousSecret;
});

describe('upsertSettings', () => {
  it('changing assignment groups resets the watermark', async () => {
    queued.push([{ assignmentGroupIds: [GROUP_A] }], [settingsRow({ assignmentGroupIds: [GROUP_B], watermark: null })]);

    await upsertSettings(PROJECT, { assignmentGroupIds: [GROUP_A, GROUP_B] }, 'user-1');

    expect(upsertSet()).toMatchObject({ assignmentGroupIds: [GROUP_A, GROUP_B], watermark: null });
  });

  it('keeps the watermark when the same groups arrive in another order', async () => {
    queued.push([{ assignmentGroupIds: [GROUP_A, GROUP_B] }], [settingsRow()]);

    await upsertSettings(PROJECT, { assignmentGroupIds: [GROUP_B, GROUP_A] }, 'user-1');

    expect(upsertSet()).not.toHaveProperty('watermark');
  });

  it('keeps the watermark when only other settings change', async () => {
    queued.push([{ assignmentGroupIds: [GROUP_A] }], [settingsRow({ backfillDays: 14 })]);

    await upsertSettings(PROJECT, { backfillDays: 14, enabled: false }, 'user-1');

    expect(upsertSet()).not.toHaveProperty('watermark');
    expect(upsertSet()).toMatchObject({ backfillDays: 14, enabled: false });
  });

  it('does not need a reset for a first save', async () => {
    queued.push([], [settingsRow({ watermark: null })]);

    await upsertSettings(PROJECT, { assignmentGroupIds: [GROUP_A] }, 'user-1');

    expect(upsertSet()).not.toHaveProperty('watermark');
  });
});

describe('upsertSettings webhook', () => {
  const WEBHOOK_URL = 'https://prod-12.westus.logic.azure.com/workflows/abc/triggers/manual?sig=topsecret9';

  it('stores a valid webhook encrypted with a mask and returns the mask', async () => {
    queued.push([], [settingsRow({ teamsWebhook: { masked: 'prod-12.westus.logic.azure.com…' } })]);

    const saved = await upsertSettings(PROJECT, { teamsWebhookUrl: ` ${WEBHOOK_URL} ` }, 'user-1');

    const stored = upsertSet().teamsWebhook as Record<string, unknown>;
    expect(JSON.stringify(stored)).not.toContain('topsecret9');
    expect(JSON.stringify(stored)).not.toContain('workflows');
    expect(stored.masked).toBe('prod-12.westus.logic.azure.com…');
    expect(decryptWebhookUrl(PROJECT, stored)).toBe(WEBHOOK_URL);
    expect(saved.teamsWebhookMasked).toBe('prod-12.westus.logic.azure.com…');
    expect(JSON.stringify(saved)).not.toContain('topsecret9');
  });

  it('null clears the webhook', async () => {
    queued.push([{ assignmentGroupIds: [GROUP_A] }], [settingsRow({ teamsWebhook: null })]);

    const saved = await upsertSettings(PROJECT, { teamsWebhookUrl: null }, 'user-1');

    expect(upsertSet()).toHaveProperty('teamsWebhook', null);
    expect(saved.teamsWebhookMasked).toBeNull();
  });

  it('omitted keeps the webhook', async () => {
    queued.push([{ assignmentGroupIds: [GROUP_A] }], [settingsRow()]);

    await upsertSettings(PROJECT, { enabled: true }, 'user-1');

    expect(upsertSet()).not.toHaveProperty('teamsWebhook');
  });

  it('refuses a URL that is not a Teams Workflows URL, before any query', async () => {
    await expect(
      upsertSettings(PROJECT, { teamsWebhookUrl: 'https://example.com/hook?sig=topsecret9' }, 'user-1'),
    ).rejects.toBeInstanceOf(InvalidTeamsWebhookError);

    expect(recorded).toHaveLength(0);
  });
});

describe('Teams delivery', () => {
  it('getTeamsWebhook returns the stored envelope or null', async () => {
    queued.push([{ teamsWebhook: { iv: 'x' } }], [{ teamsWebhook: null }], []);

    await expect(getTeamsWebhook(PROJECT)).resolves.toEqual({ iv: 'x' });
    await expect(getTeamsWebhook(PROJECT)).resolves.toBeNull();
    await expect(getTeamsWebhook(PROJECT)).resolves.toBeNull();
  });

  it('getAnalysisForPost joins the incident and carries the attempt count', async () => {
    queued.push([
      {
        incident_triage_analyses: {
          runId: RUN_ID,
          incidentId: 'incident-1',
          status: 'completed',
          requestedBy: null,
          model: 'm',
          verdict: 'bug',
          area: 'Timecard',
          severity: 'high',
          result: null,
          failureDetail: null,
          teamsStatus: 'failed',
          teamsAttempts: 2,
          requestedAt: '2026-11-20T11:31:00.000Z',
          completedAt: '2026-11-20T11:40:00.000Z',
        },
        incident_triage_incidents: {
          id: 'incident-1',
          project: PROJECT,
          sysId: 'b'.repeat(32),
          number: 'INC0012345',
          openedAt: null,
          resolvedAt: null,
          sysUpdatedOn: null,
        },
      },
    ], []);

    const found = await getAnalysisForPost(RUN_ID);

    expect(found).toMatchObject({
      project: PROJECT,
      teamsAttempts: 2,
      incident: { id: 'incident-1', number: 'INC0012345' },
      analysis: { runId: RUN_ID, status: 'completed', teamsStatus: 'failed', verdict: 'bug' },
    });
    await expect(getAnalysisForPost('missing')).resolves.toBeNull();
  });

  it('getLastPostedAnalysis reads the newest posted row of the incident, not this run', async () => {
    queued.push([{ verdict: 'bug', severity: 'high' }], []);

    await expect(getLastPostedAnalysis('incident-1', RUN_ID)).resolves.toEqual({ verdict: 'bug', severity: 'high' });
    await expect(getLastPostedAnalysis('incident-1', RUN_ID)).resolves.toBeNull();

    const where = stepArgs(recorded[0], 'where')?.[0];
    const query = new PgDialect().sqlToQuery(where as never);
    expect(query.params).toEqual(expect.arrayContaining(['incident-1', 'posted', RUN_ID]));
    expect(query.sql).toContain('<>');
    expect(recorded[0].some((step) => step.method === 'orderBy')).toBe(true);
  });

  it('markTeamsPosted records the time', async () => {
    queued.push(undefined);

    await markTeamsPosted(RUN_ID);

    const set = stepArgs(recorded[0], 'set')?.[0] as Record<string, unknown>;
    expect(set).toMatchObject({ teamsStatus: 'posted' });
    expect(typeof set.teamsPostedAt).toBe('string');
  });

  it('markTeamsSkipped only sets the status', async () => {
    queued.push(undefined);

    await markTeamsSkipped(RUN_ID);

    expect(stepArgs(recorded[0], 'set')?.[0]).toEqual({ teamsStatus: 'skipped' });
  });

  it('markTeamsFailed sets failed and adds one attempt', async () => {
    queued.push(undefined);

    await markTeamsFailed(RUN_ID);

    const set = stepArgs(recorded[0], 'set')?.[0] as Record<string, unknown>;
    expect(set.teamsStatus).toBe('failed');
    const increment = new PgDialect().sqlToQuery(set.teamsAttempts as never);
    expect(increment.sql).toContain('"teams_attempts" + 1');
  });

  it('listFailedTeamsPosts picks completed failed rows under 3 attempts', async () => {
    queued.push([{ runId: 'run-a' }, { runId: 'run-b' }]);

    await expect(listFailedTeamsPosts(5, [PROJECT])).resolves.toEqual(['run-a', 'run-b']);

    const where = stepArgs(recorded[0], 'where')?.[0];
    const query = new PgDialect().sqlToQuery(where as never);
    expect(query.sql).toContain('"teams_attempts" <');
    expect(query.params).toEqual(expect.arrayContaining(['completed', 'failed', 3]));
    expect(stepArgs(recorded[0], 'limit')).toEqual([5]);
  });

  it('listFailedTeamsPosts reads only the given projects, and no project means no query', async () => {
    queued.push([{ runId: 'run-a' }]);

    await listFailedTeamsPosts(5, [PROJECT, 'Other']);
    await expect(listFailedTeamsPosts(5, [])).resolves.toEqual([]);

    expect(recorded).toHaveLength(1);
    expect(recorded[0].some((step) => step.method === 'innerJoin')).toBe(true);
    const query = new PgDialect().sqlToQuery(stepArgs(recorded[0], 'where')?.[0] as never);
    expect(query.sql).toContain('"project" in');
    expect(query.params).toEqual(expect.arrayContaining([PROJECT, 'Other']));
  });

  it('listPendingAnalyses reads only the given projects, and no project means no query', async () => {
    queued.push([{ runId: 'run-a', requestedAt: '2026-11-20T11:31:00.000Z' }]);

    await expect(listPendingAnalyses(5, [PROJECT])).resolves.toHaveLength(1);
    await expect(listPendingAnalyses(5, [])).resolves.toEqual([]);

    expect(recorded).toHaveLength(1);
    const query = new PgDialect().sqlToQuery(stepArgs(recorded[0], 'where')?.[0] as never);
    expect(query.sql).toContain('"project" in');
    expect(query.params).toEqual(expect.arrayContaining(['pending', PROJECT]));
  });
});

describe('recordAdmissionFailure', () => {
  it('adds one attempt and returns the new count, or null for a missing row', async () => {
    queued.push([{ admissionAttempts: 2 }], []);

    await expect(recordAdmissionFailure(RUN_ID)).resolves.toBe(2);
    await expect(recordAdmissionFailure(RUN_ID)).resolves.toBeNull();

    const set = stepArgs(recorded[0], 'set')?.[0] as { admissionAttempts: never };
    expect(new PgDialect().sqlToQuery(set.admissionAttempts).sql).toContain('"admission_attempts" + 1');
  });
});

describe('analysis status changes', () => {
  it('markAnalysisRunning claims a pending row and reports whether it did', async () => {
    queued.push([{ runId: RUN_ID }], []);

    await expect(
      markAnalysisRunning(RUN_ID, { model: 'm', effort: 'high', repository: 'MaxView', groundedSha: 'abc' }),
    ).resolves.toBe(true);
    await expect(
      markAnalysisRunning(RUN_ID, { model: 'm', effort: null, repository: 'MaxView', groundedSha: 'abc' }),
    ).resolves.toBe(false);

    const set = stepArgs(recorded[0], 'set')?.[0];
    expect(set).toEqual({ status: 'running', model: 'm', effort: 'high', repository: 'MaxView', groundedSha: 'abc' });
    const where = stepArgs(recorded[0], 'where')?.[0];
    expect(new PgDialect().sqlToQuery(where as never).sql).toContain('"status" = $');
  });

  it('revertAnalysisToPending only moves a running row back', async () => {
    queued.push(undefined);

    await revertAnalysisToPending(RUN_ID);

    expect(stepArgs(recorded[0], 'set')?.[0]).toEqual({
      status: 'pending',
      model: null,
      effort: null,
      repository: null,
      groundedSha: null,
    });
    const where = stepArgs(recorded[0], 'where')?.[0];
    expect(new PgDialect().sqlToQuery(where as never).params).toEqual(expect.arrayContaining([RUN_ID, 'running']));
  });

  it('deleteAnalysis deletes by run id', async () => {
    queued.push(undefined);

    await deleteAnalysis(RUN_ID);

    expect(recorded[0].some((step) => step.method === 'where')).toBe(true);
  });

  it('completeAnalysis stores the verdict columns and result and puts the Teams post back to pending', async () => {
    queued.push(undefined);
    const result = { summary: 's' } as never;

    await completeAnalysis(RUN_ID, { verdict: 'bug', area: 'Timecard', severity: 'high', result });

    const set = stepArgs(recorded[0], 'set')?.[0] as Record<string, unknown>;
    expect(set).toMatchObject({
      status: 'completed',
      verdict: 'bug',
      area: 'Timecard',
      severity: 'high',
      result,
      failureDetail: null,
      teamsStatus: 'pending',
    });
    expect(typeof set.completedAt).toBe('string');
  });

  it('a second completeAnalysis changes nothing, because only a row not yet completed is updated', async () => {
    queued.push(undefined);

    await completeAnalysis(RUN_ID, { verdict: 'bug', area: 'Timecard', severity: 'high', result: {} as never });

    const query = new PgDialect().sqlToQuery(stepArgs(recorded[0], 'where')?.[0] as never);
    expect(query.sql).toContain('"run_id" = $');
    expect(query.sql).toContain('"status" <> $');
    expect(query.params).toEqual(expect.arrayContaining([RUN_ID, 'completed']));
  });

  it('failAnalysis records the reason', async () => {
    queued.push(undefined);

    await failAnalysis(RUN_ID, 'Model Blocked');

    const set = stepArgs(recorded[0], 'set')?.[0] as Record<string, unknown>;
    expect(set).toMatchObject({ status: 'failed', failureDetail: 'Model Blocked' });
    expect(typeof set.completedAt).toBe('string');
  });

  it('a failed analysis never posts to Teams, so its status becomes skipped', async () => {
    queued.push(undefined);

    await failAnalysis(RUN_ID, 'Model Blocked');

    expect(stepArgs(recorded[0], 'set')?.[0]).toMatchObject({ teamsStatus: 'skipped' });
  });

  it('stale running rows are failed and unblock the incident', async () => {
    queued.push([{ runId: 'run-a' }, { runId: 'run-b' }]);
    const cutoff = new Date('2026-11-20T11:15:00.000Z');

    await expect(failStaleRunningAnalyses(cutoff, 'Analysis did not finish')).resolves.toBe(2);

    const set = stepArgs(recorded[0], 'set')?.[0] as Record<string, unknown>;
    expect(set).toMatchObject({
      status: 'failed',
      failureDetail: 'Analysis did not finish',
      teamsStatus: 'skipped',
    });
    expect(typeof set.completedAt).toBe('string');
    const query = new PgDialect().sqlToQuery(stepArgs(recorded[0], 'where')?.[0] as never);
    expect(query.params).toEqual(expect.arrayContaining(['running', cutoff.toISOString()]));
    expect(query.sql).toContain('"requested_at" <');
    expect(query.sql).toMatch(/not exists \(select 1 from "agent_runs"/i);
    expect(query.params).toEqual(expect.arrayContaining(['queued', 'dispatched']));
  });

  it('compares the text agent run id with the uuid run id as text, which Postgres needs', async () => {
    queued.push([]);

    await failStaleRunningAnalyses(new Date('2026-11-20T11:15:00.000Z'), 'Analysis did not finish');

    const query = new PgDialect().sqlToQuery(stepArgs(recorded[0], 'where')?.[0] as never);
    expect(query.sql.match(/"incident_triage_analyses"\."run_id"::text/g)).toHaveLength(2);
    expect(query.sql).not.toMatch(/= "incident_triage_analyses"\."run_id"(?!::text)/);
  });

  it('stale running rows whose agent run finished but is not harvested are left alone', async () => {
    queued.push([]);

    await failStaleRunningAnalyses(new Date('2026-11-20T11:15:00.000Z'), 'Analysis did not finish');

    const query = new PgDialect().sqlToQuery(stepArgs(recorded[0], 'where')?.[0] as never);
    expect(query.sql).toContain('ai_run_attempts');
    expect(query.sql).toContain('ai_run_inbox');
    expect(query.sql).toContain("'artifact-harvest:' || latest_attempt.id");
    expect(query.sql).toContain('harvested.processed_at IS NOT NULL');
    expect(query.sql.match(/not exists/gi)).toHaveLength(4);
    expect(query.params).toEqual(expect.arrayContaining(['completed', 'failed', 'cancelled']));
  });

  it('stale running rows whose agent run a newer run on the thread superseded are failed', async () => {
    queued.push([]);

    await failStaleRunningAnalyses(new Date('2026-11-20T11:15:00.000Z'), 'Analysis did not finish');

    const query = new PgDialect().sqlToQuery(stepArgs(recorded[0], 'where')?.[0] as never);
    const normalised = query.sql.replace(/\s+/g, ' ');
    expect(normalised).toContain(
      "AND NOT EXISTS ( SELECT 1 FROM agent_runs newer WHERE newer.thread_id = r.thread_id AND newer.execution_snapshot->>'workflowClass' = r.execution_snapshot->>'workflowClass' AND ( newer.created_at > r.created_at OR ( newer.created_at = r.created_at AND newer.id > r.id ) ) )",
    );
  });
});

describe('manual analyses', () => {
  it('insertManualAnalysis copies the incident hash and records the requester', async () => {
    queued.push(
      [{ id: 'incident-1', contentHash: 'hash-1', sysUpdatedOn: '2026-11-20T11:30:00.000Z' }],
      [{ runId: RUN_ID }],
    );

    await expect(insertManualAnalysis(PROJECT, 'incident-1', 'user-1')).resolves.toEqual({ runId: RUN_ID });

    const values = stepArgs(recorded[1], 'values')?.[0] as Record<string, unknown>;
    expect(values).toMatchObject({
      incidentId: 'incident-1',
      contentHash: 'hash-1',
      sysUpdatedOn: '2026-11-20T11:30:00.000Z',
      status: 'pending',
      requestedBy: 'user-1',
    });
  });

  it('insertManualAnalysis returns null for an unknown incident', async () => {
    queued.push([]);

    await expect(insertManualAnalysis(PROJECT, 'missing', 'user-1')).resolves.toBeNull();
    expect(recorded).toHaveLength(1);
  });

  it('hasRunningAnalysis is true only when a running row exists', async () => {
    queued.push([{ runId: RUN_ID }], []);

    await expect(hasRunningAnalysis('incident-1')).resolves.toBe(true);
    await expect(hasRunningAnalysis('incident-1')).resolves.toBe(false);
  });
});
