/**
 * TBI-014 DoD-0, DoD-1, DoD-3; PBI-017 AC-0, AC-1, AC-2; PBI-018 AC-0, AC-3 / VT-09..VT-14.
 */
import * as fs from 'fs';
import * as path from 'path';
import { RedactionError } from '../services/buildRedactionService';
import {
  getBuildDetail,
  listBuildRunEvents,
  normalizeEventsLimit,
  REDACTION_PLACEHOLDER,
  type BuildRunProjectionDeps,
  type ProjectionEventRow,
  type ProjectionRunRow,
  type ProjectionTaskRow,
} from '../services/buildRunProjectionService';

const BUILD_ID = '00000000-0000-4000-8000-000000000001';
const connection = ['postgres://admin:', 'hunter2', '@db.internal:5432/app'].join('');
const bearer = ['Bear', 'er sk_live_', 'abcdefghijklmnop'].join('');

function revision(number: number, overrides: Partial<ProjectionRunRow['revisions'][number]> = {}) {
  return {
    id: `rev-${number}`,
    revisionNumber: number,
    requirements: [
      { id: 'AC-1', kind: 'ac' as const, text: `Connect with ${connection}`, retired: false },
      { id: 'AC-2', kind: 'ac' as const, text: 'Old rule', retired: true },
    ],
    assumptions: ['One assumption'],
    exclusions: ['One exclusion'],
    riskDecisions: [{
      id: 'RD-1',
      category: 'access' as const,
      rating: 'high' as const,
      decision: 'Use the read role',
      rationale: `Token was ${bearer}`,
    }],
    classification: 'small' as const,
    repairAttempts: 1,
    elapsedSecondsUsed: 120,
    deploymentStatus: 'not_started' as const,
    previewUrl: null,
    createdAt: '2026-10-28T10:00:00.000Z',
    ...overrides,
  };
}

function run(overrides: Partial<ProjectionRunRow> = {}): ProjectionRunRow {
  return {
    id: BUILD_ID,
    project: 'Apex',
    repository: 'apex',
    status: 'building',
    suspendReason: null,
    interviewId: 'iv-1',
    currentRevisionNumber: 2,
    revisionsUsed: 1,
    revisionCap: 5,
    supportContacts: [{ userId: 'u-9', displayName: 'Dana', email: 'dana@example.com' }],
    costCapUsd: '25.0000',
    costUsedUsd: '3.5000',
    elapsedCapSeconds: 3600,
    parallelismCap: 3,
    parallelismUsed: 1,
    endedAt: null,
    createdAt: '2026-10-28T09:59:00.000Z',
    revisions: [revision(2), revision(1, { createdAt: '2026-10-28T09:00:00.000Z' })],
    ...overrides,
  };
}

function task(key: string, overrides: Partial<ProjectionTaskRow> = {}): ProjectionTaskRow {
  return {
    taskKey: key,
    role: 'implementer',
    dependsOn: [],
    ownedFiles: [`src/${key}.ts`],
    reuse: [],
    runMode: 'own_agent',
    branchName: `apex/build/b1/${key}`,
    status: 'pending',
    attempt: 1,
    omittedReason: null,
    ...overrides,
  };
}

function deps(overrides: Partial<BuildRunProjectionDeps> = {}) {
  const calls = { run: 0, tasks: 0, verification: 0, queue: 0, events: 0 };
  const warn = jest.fn();
  const base: BuildRunProjectionDeps = {
    loadRun: async () => { calls.run += 1; return run(); },
    loadRunProject: async () => { calls.run += 1; return { id: BUILD_ID, project: 'Apex' }; },
    loadTasks: async () => { calls.tasks += 1; return [task('a', { status: 'merged' }), task('b')]; },
    loadVerificationCounts: async () => {
      calls.verification += 1;
      return [{ status: 'pass', count: 2 }, { status: 'fail', count: 1 }, { status: 'pending', count: 1 }];
    },
    queuePosition: async () => { calls.queue += 1; return 4; },
    loadEvents: async () => { calls.events += 1; return { rows: [], total: 0 }; },
    redact: (text: string) => text.replace(connection, '[REDACTED:connection-string]').replace(bearer, '[REDACTED:bearer-token]'),
    now: () => new Date('2026-10-28T10:05:00.000Z'),
    warn,
    ...overrides,
  };
  return { deps: base, calls, warn };
}

describe('getBuildDetail', () => {
  it('VT-05 TBI-014 DoD-0 returns status, revisions, tasks, verification summary and caps', async () => {
    const { deps: d } = deps();
    const result = await getBuildDetail({ project: 'Apex', buildId: BUILD_ID }, d);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const { detail } = result;
    expect(detail.build).toEqual({
      id: BUILD_ID,
      project: 'Apex',
      repository: 'apex',
      status: 'building',
      currentRevisionNumber: 2,
      intakeInterviewId: 'iv-1',
      createdAt: '2026-10-28T09:59:00.000Z',
      endedAt: null,
    });
    expect(detail.stage).toMatchObject({ kind: 'stage', key: 'building', tasks: { merged: 1, total: 2 } });
    expect(detail.revisions.map((row) => row.number)).toEqual([1, 2]);
    expect(detail.currentRevision?.number).toBe(2);
    expect(detail.currentRevision?.repairAttempts).toBe(1);
    expect(detail.currentRevision?.tasks).toHaveLength(2);
    expect(detail.verificationSummary).toEqual({ total: 4, pass: 2, fail: 1, deferred: 0, retired: 0 });
    expect(detail.caps).toEqual({
      cost: { usedUsd: '3.5000', limitUsd: '25.0000' },
      revisions: { used: 1, limit: 5 },
      elapsedSeconds: { used: 120, limit: 3600 },
      parallelism: { used: 1, limit: 3 },
    });
    expect(detail.timing).toEqual({ elapsedSeconds: 300, targetSeconds: 300, state: 'within', includesDeployment: true });
    expect(detail.supportContacts).toEqual([{ displayName: 'Dana', email: 'dana@example.com' }]);
    expect(detail.lease).toBeNull();
  });

  it('VT-07 TBI-014 DoD-3 returns wrong-project and loads nothing else', async () => {
    const { deps: d, calls } = deps({ loadRun: async () => run({ project: 'Other' }) });
    const result = await getBuildDetail({ project: 'Apex', buildId: BUILD_ID }, d);
    expect(result).toEqual({ kind: 'wrong-project' });
    expect(calls.tasks).toBe(0);
    expect(calls.verification).toBe(0);
  });

  it('returns not-found for a missing build and for a malformed id', async () => {
    const { deps: d, calls } = deps({ loadRun: async () => null });
    expect(await getBuildDetail({ project: 'Apex', buildId: BUILD_ID }, d)).toEqual({ kind: 'not-found' });
    const uuidCheck = deps();
    expect(await getBuildDetail({ project: 'Apex', buildId: 'not a uuid!' }, uuidCheck.deps))
      .toEqual({ kind: 'not-found' });
    expect(uuidCheck.calls.run).toBe(0);
    expect(calls.tasks).toBe(0);
  });

  it('VT-09 PBI-017 AC-0 redacts requirement text, rationale and omission reason', async () => {
    const { deps: d } = deps({
      loadTasks: async () => [task('a', { status: 'omitted', omittedReason: `Skipped: ${bearer}` })],
    });
    const result = await getBuildDetail({ project: 'Apex', buildId: BUILD_ID }, d);
    const text = JSON.stringify(result);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('sk_live_');
    expect(text).toContain('[REDACTED:connection-string]');
  });

  it('VT-09 shows the placeholder and logs without the text when redaction throws', async () => {
    const { deps: d, warn } = deps({
      redact: (value: string) => {
        if (value.includes('hunter2')) throw new RedactionError();
        return value;
      },
    });
    const result = await getBuildDetail({ project: 'Apex', buildId: BUILD_ID }, d);
    if (result.kind !== 'ok' || result.detail.currentRevision?.brief.status !== 'ok') throw new Error('expected ok');
    expect(result.detail.currentRevision.brief.requirements[0].text).toBe(REDACTION_PLACEHOLDER);
    expect(warn).toHaveBeenCalledWith('build.redaction.field_hidden', { buildId: BUILD_ID, errorClass: 'RedactionError' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('hunter2');
  });

  it('VT-10 leaves out prompt, snapshots, correlation ids, blob refs and the pull request link', async () => {
    const leaky = {
      ...run(),
      prompt: 'SECRET PROMPT',
      skillSnapshot: { codeMap: { path: 'x', hash: 'SNAPSHOT' } },
      qualityManifestSnapshot: { typeCheck: 'MANIFEST' },
      pullRequestUrl: 'https://dev.azure.com/pr/1',
      requestedByUserId: 'u-requester',
    } as ProjectionRunRow;
    const { deps: d } = deps({ loadRun: async () => leaky });
    const result = await getBuildDetail({ project: 'Apex', buildId: BUILD_ID }, d);
    const text = JSON.stringify(result);
    for (const value of ['SECRET PROMPT', 'SNAPSHOT', 'MANIFEST', 'dev.azure.com', 'u-requester', 'u-9']) {
      expect(text).not.toContain(value);
    }
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(Object.keys(result.detail.build).sort()).toEqual(
      ['createdAt', 'currentRevisionNumber', 'endedAt', 'id', 'intakeInterviewId', 'project', 'repository', 'status'],
    );
  });

  it('VT-11 PBI-017 AC-1 returns brief unavailable with a populated stage when mapping fails', async () => {
    const broken = run({
      revisions: [revision(2, { requirements: 'not-an-array' as unknown as [] })],
    });
    const { deps: d, warn } = deps({ loadRun: async () => broken });
    const result = await getBuildDetail({ project: 'Apex', buildId: BUILD_ID }, d);
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.detail.currentRevision?.brief).toEqual({ status: 'unavailable' });
    expect(result.detail.stage.key).toBe('building');
    expect(warn).toHaveBeenCalledWith('build.brief.unavailable', expect.objectContaining({ buildId: BUILD_ID }));
  });

  it('VT-12 PBI-017 AC-2 keeps a retired requirement with retired true', async () => {
    const { deps: d } = deps();
    const result = await getBuildDetail({ project: 'Apex', buildId: BUILD_ID }, d);
    if (result.kind !== 'ok' || result.detail.currentRevision?.brief.status !== 'ok') throw new Error('expected ok');
    expect(result.detail.currentRevision.brief.requirements).toContainEqual(
      { id: 'AC-2', kind: 'ac', text: 'Old rule', retired: true },
    );
  });

  it('returns overview null (no overview column yet)', async () => {
    const { deps: d } = deps();
    const result = await getBuildDetail({ project: 'Apex', buildId: BUILD_ID }, d);
    if (result.kind !== 'ok' || result.detail.currentRevision?.brief.status !== 'ok') throw new Error('expected ok');
    expect(result.detail.currentRevision.brief.overview).toBeNull();
  });

  it('VT-14 TBI-014 uses at most four loads for 50 tasks and 5 revisions, queue only when queued', async () => {
    const many = run({ revisions: [1, 2, 3, 4, 5].map((n) => revision(n)), currentRevisionNumber: 5, revisionsUsed: 4 });
    const fifty = Array.from({ length: 50 }, (_, index) => task(`t${index}`));
    const building = deps({ loadRun: async () => { building.calls.run += 1; return many; }, loadTasks: async () => { building.calls.tasks += 1; return fifty; } });
    await getBuildDetail({ project: 'Apex', buildId: BUILD_ID }, building.deps);
    expect(building.calls).toMatchObject({ run: 1, tasks: 1, verification: 1, queue: 0 });

    const queued = deps({ loadRun: async () => { queued.calls.run += 1; return run({ status: 'queued' }); } });
    const result = await getBuildDetail({ project: 'Apex', buildId: BUILD_ID }, queued.deps);
    const total = queued.calls.run + queued.calls.tasks + queued.calls.verification + queued.calls.queue;
    expect(total).toBeLessThanOrEqual(4);
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.detail.stage.queuePosition).toBe(4);
  });

  it('VT-14 routes/builds.ts imports neither drizzle-orm nor db/schema', () => {
    const source = fs.readFileSync(path.join(__dirname, '../routes/builds.ts'), 'utf8');
    expect(source).not.toMatch(/from ['"]drizzle-orm['"]/);
    expect(source).not.toMatch(/db\/schema/);
  });
});

describe('listBuildRunEvents', () => {
  function rows(count: number): ProjectionEventRow[] {
    return Array.from({ length: count }, (_, index) => ({
      id: `e${index}`,
      eventType: 'task.merged',
      message: `Event ${index}`,
      taskKey: index % 2 === 0 ? 'task-a' : null,
      createdAt: new Date(Date.UTC(2026, 9, 28, 10, 0, index)).toISOString(),
    }));
  }

  it('VT-13 TBI-014 DoD-1 returns ascending whitelisted rows with a total', async () => {
    const latestDesc = rows(3).reverse();
    const { deps: d } = deps({ loadEvents: async () => ({ rows: latestDesc, total: 600 }) });
    const result = await listBuildRunEvents({ project: 'Apex', buildId: BUILD_ID, limit: 10 }, d);
    if (result.kind !== 'ok') throw new Error('expected ok');
    expect(result.response.total).toBe(600);
    expect(result.response.events.map((event) => event.id)).toEqual(['e0', 'e1', 'e2']);
    for (const event of result.response.events) {
      expect(Object.keys(event).sort()).toEqual(['id', 'kind', 'message', 'occurredAt', 'taskKey']);
    }
  });

  it('VT-09 PBI-018 AC-3 redacts event messages', async () => {
    const { deps: d } = deps({
      loadEvents: async () => ({ rows: [{ ...rows(1)[0], message: `Agent said ${bearer}` }], total: 1 }),
    });
    const result = await listBuildRunEvents({ project: 'Apex', buildId: BUILD_ID, limit: 200 }, d);
    expect(JSON.stringify(result)).not.toContain('sk_live_');
    expect(JSON.stringify(result)).toContain('[REDACTED:bearer-token]');
  });

  it('VT-07 returns wrong-project without reading events', async () => {
    const { deps: d, calls } = deps({ loadRunProject: async () => ({ id: BUILD_ID, project: 'Other' }) });
    expect(await listBuildRunEvents({ project: 'Apex', buildId: BUILD_ID, limit: 200 }, d)).toEqual({ kind: 'wrong-project' });
    expect(calls.events).toBe(0);
  });

  it('VT-13 clamps the limit: 5000 to 500, junk to 200, 10 stays 10', () => {
    expect(normalizeEventsLimit('5000')).toBe(500);
    expect(normalizeEventsLimit('abc')).toBe(200);
    expect(normalizeEventsLimit(undefined)).toBe(200);
    expect(normalizeEventsLimit('0')).toBe(200);
    expect(normalizeEventsLimit('10')).toBe(10);
  });
});
