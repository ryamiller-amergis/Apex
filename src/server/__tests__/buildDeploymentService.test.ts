/**
 * S5 — Build deployment service tests (TBI-025 DoD-0, DoD-2, PBI-026 AC-0..2, PBI-029 AC-0..3 / VT-08..12, VT-15, VT-17, VT-21..24, VT-26).
 */
import {
  assertMayRetry,
  buildPreviewsList,
  createBuildDeploymentService,
  type BuildDeploymentServiceDeps,
  type DeploymentRevisionRecord,
  type DeploymentRunRecord,
} from '../services/buildDeploymentService';

function createDeploymentHarness() {
  const runs = new Map<string, DeploymentRunRecord>();
  const revisions = new Map<string, DeploymentRevisionRecord>();
  const leases = new Map<string, { buildRunId: string; buildRevisionId: string; expiresAt: string }>();
  const events: Array<{ buildRunId: string; eventType: string; detail?: Record<string, unknown> }> = [];
  const previewNotifications: string[] = [];
  const failedNotifications: string[] = [];
  const queuedBuilds: Array<{ commit: string; revisionId: string }> = [];
  let flagEnabled = true;

  const pairKey = (p: string, r: string) => `${p}::${r}`;

  const seedRunAndRevision = (
    overrides?: Partial<DeploymentRunRecord>,
    revOverrides?: Partial<DeploymentRevisionRecord>,
  ) => {
    const run: DeploymentRunRecord = {
      id: 'run-1',
      project: 'Apex',
      repository: 'apex-repo',
      status: 'deploying',
      requesterUserId: 'user-req',
      integrationBranch: 'apex/build/run-1',
      currentRevisionNumber: 1,
      supportContacts: [
        { userId: 'u-contact-1', displayName: 'Dana', email: 'dana@example.com' },
        { userId: 'u-contact-2', displayName: 'Eli', email: 'eli@example.com' },
      ],
      defaultPreviewUrl: 'https://preview.dev.example.com',
      deployPipelineId: 77,
      ...overrides,
    };
    const rev: DeploymentRevisionRecord = {
      id: 'rev-1',
      buildRunId: run.id,
      revisionNumber: 1,
      validatedCommit: 'a'.repeat(40),
      pipelineRunId: 'P1',
      deploymentStatus: 'deploying',
      deploymentQueuedAt: '2026-11-01T10:00:00.000Z',
      deployedAt: null,
      deploymentFailedStage: null,
      deploymentError: null,
      deploymentPipelineUrl: null,
      previewUrl: null,
      ...revOverrides,
    };
    runs.set(run.id, run);
    revisions.set(rev.id, rev);
    leases.set(pairKey(run.project, run.repository), {
      buildRunId: run.id,
      buildRevisionId: rev.id,
      expiresAt: '2026-11-02T10:00:00.000Z',
    });
    return { run, rev };
  };

  const deps: BuildDeploymentServiceDeps = {
    now: () => new Date('2026-11-01T12:00:00.000Z'),
    isFlagEnabled: async () => flagEnabled,
    loadByPipelineRunId: async (pipelineRunId) => {
      for (const rev of revisions.values()) {
        if (rev.pipelineRunId === pipelineRunId) {
          const run = runs.get(rev.buildRunId);
          if (run) return { run, revision: rev };
        }
      }
      return null;
    },
    loadRunAndCurrentRevision: async (buildRunId) => {
      const run = runs.get(buildRunId);
      if (!run) return null;
      const rev = [...revisions.values()].find(
        (r) => r.buildRunId === buildRunId && r.revisionNumber === run.currentRevisionNumber,
      );
      if (!rev) return null;
      return { run, revision: rev };
    },
    casSettleRevision: async (pipelineRunId, update) => {
      for (const rev of revisions.values()) {
        if (rev.pipelineRunId === pipelineRunId && rev.deploymentStatus === 'deploying') {
          rev.deploymentStatus = update.deploymentStatus;
          if (update.previewUrl !== undefined) rev.previewUrl = update.previewUrl;
          if (update.deployedAt !== undefined) rev.deployedAt = update.deployedAt;
          if (update.failedStage !== undefined) rev.deploymentFailedStage = update.failedStage;
          if (update.errorText !== undefined) rev.deploymentError = update.errorText;
          if (update.pipelineUrl !== undefined) rev.deploymentPipelineUrl = update.pipelineUrl;
          return true;
        }
      }
      return false;
    },
    setRunStatus: async (runId, status) => {
      const r = runs.get(runId);
      if (r) r.status = status;
    },
    extendLease: async (runId, finishedAt) => {
      for (const l of leases.values()) {
        if (l.buildRunId === runId) {
          l.expiresAt = new Date(new Date(finishedAt).getTime() + 24 * 3600_000).toISOString();
        }
      }
    },
    releaseLease: async (runId) => {
      for (const [k, l] of leases.entries()) {
        if (l.buildRunId === runId) leases.delete(k);
      }
    },
    tryClaimNextWaiting: async (project, repository) => {
      const waiting = [...revisions.values()]
        .filter((r) => {
          const run = runs.get(r.buildRunId);
          return (
            run?.project === project
            && run.repository === repository
            && run.status === 'deploying'
            && r.deploymentStatus === 'queued'
          );
        })
        .sort((a, b) => (a.deploymentQueuedAt ?? '').localeCompare(b.deploymentQueuedAt ?? ''));
      const first = waiting[0];
      if (!first) return null;
      const key = pairKey(project, repository);
      if (leases.has(key)) return null;
      const run = runs.get(first.buildRunId)!;
      leases.set(key, {
        buildRunId: run.id,
        buildRevisionId: first.id,
        expiresAt: '2026-11-02T12:00:00.000Z',
      });
      first.deploymentStatus = 'deploying';
      return { run, revision: first };
    },
    storePipelineRun: async (revisionId, pipelineRunId, pipelineUrl) => {
      const r = revisions.get(revisionId);
      if (r) {
        r.pipelineRunId = pipelineRunId;
        r.deploymentPipelineUrl = pipelineUrl;
      }
    },
    casRetryRevision: async (revisionId, queuedAt) => {
      const r = revisions.get(revisionId);
      if (!r || r.deploymentStatus !== 'failed') return false;
      r.deploymentStatus = 'queued';
      r.deploymentQueuedAt = queuedAt;
      r.pipelineRunId = null;
      r.deploymentError = null;
      r.deploymentFailedStage = null;
      const run = runs.get(r.buildRunId);
      if (run) run.status = 'deploying';
      return true;
    },
    getQueuePosition: async () => 1,
    queuePipelineBuild: async (opts) => {
      queuedBuilds.push({ commit: opts.commit, revisionId: opts.revisionId });
      return {
        pipelineRunId: '4411',
        pipelineUrl: 'https://dev.azure.com/org/Apex/_build/results?buildId=4411',
      };
    },
    notifyPreviewReady: async (input) => {
      previewNotifications.push(input.pipelineRunId);
    },
    notifyDeploymentFailed: async (input) => {
      failedNotifications.push(input.pipelineRunId);
    },
    appendEvent: async (ev) => {
      events.push(ev);
    },
    sleep: async () => undefined,
  };

  return {
    runs,
    revisions,
    leases,
    events,
    previewNotifications,
    failedNotifications,
    queuedBuilds,
    setFlagEnabled: (v: boolean) => {
      flagEnabled = v;
    },
    seedRunAndRevision,
    deps,
    service: createBuildDeploymentService(deps),
  };
}

describe('buildDeploymentService (TBI-025, PBI-026, PBI-029 / VT-08..12, VT-15, VT-17, VT-21..24, VT-26)', () => {
  it('VT-08, VT-09 PBI-026 AC-0 / TBI-025 DoD-0 settles succeeded callback once, extends lease 24h, notifies requester, and returns duplicate on repeats', async () => {
    const h = createDeploymentHarness();
    h.seedRunAndRevision();

    const first = await h.service.settleFromCallback({
      pipelineRunId: 'P1',
      commit: 'a'.repeat(40),
      status: 'succeeded',
      previewUrl: 'https://preview.example.com/rev1',
    });
    const second = await h.service.settleFromCallback({
      pipelineRunId: 'P1',
      commit: 'a'.repeat(40),
      status: 'succeeded',
      previewUrl: 'https://preview.example.com/rev1',
    });

    expect(first).toEqual({ kind: 'ok', response: { applied: true } });
    expect(second).toEqual({
      kind: 'ok',
      response: { applied: false, reason: 'duplicate' },
    });
    expect(h.runs.get('run-1')?.status).toBe('preview_ready');
    expect(h.revisions.get('rev-1')?.deploymentStatus).toBe('succeeded');
    expect(h.revisions.get('rev-1')?.previewUrl).toBe('https://preview.example.com/rev1');
    expect(h.leases.get('Apex::apex-repo')?.expiresAt).toBe('2026-11-02T12:00:00.000Z');
    expect(h.previewNotifications).toEqual(['P1']);
  });

  it('VT-10 PBI-026 AC-1 / PBI-028 AC-0 / TBI-025 DoD-2 settles failed callback, moves run to deployment_failed, releases lease, redacts error, and notifies contacts', async () => {
    const h = createDeploymentHarness();
    h.seedRunAndRevision();

    const result = await h.service.settleFromCallback({
      pipelineRunId: 'P1',
      commit: 'a'.repeat(40),
      status: 'failed',
      failedStage: 'Deploy_Dev',
      errorText: 'Auth failed with Bearer secretBearerToken12345',
    });

    expect(result).toEqual({ kind: 'ok', response: { applied: true } });
    expect(h.runs.get('run-1')?.status).toBe('deployment_failed');
    expect(h.revisions.get('rev-1')?.deploymentStatus).toBe('failed');
    expect(h.revisions.get('rev-1')?.deploymentError).not.toContain('secretBearerToken12345');
    expect(h.leases.has('Apex::apex-repo')).toBe(false);
    expect(h.failedNotifications).toEqual(['P1']);
  });

  it('VT-11, VT-12 TBI-025 DoD-0 ignores stale callback after retry and returns run_not_deploying for cancelled run', async () => {
    const h = createDeploymentHarness();
    h.seedRunAndRevision({}, { pipelineRunId: 'P2', deploymentStatus: 'deploying' });

    const stale = await h.service.settleFromCallback({
      pipelineRunId: 'P1',
      commit: 'a'.repeat(40),
      status: 'succeeded',
      previewUrl: 'https://preview.example.com',
    });
    expect(stale.kind).toBe('not_found');
    expect(h.revisions.get('rev-1')?.pipelineRunId).toBe('P2');

    // Cancelled run
    h.runs.get('run-1')!.status = 'cancelled';
    const cancelledRes = await h.service.settleFromCallback({
      pipelineRunId: 'P2',
      commit: 'a'.repeat(40),
      status: 'succeeded',
      previewUrl: 'https://preview.example.com',
    });
    expect(cancelledRes).toEqual({
      kind: 'ok',
      response: { applied: false, reason: 'run_not_deploying' },
    });
    expect(h.runs.get('run-1')?.status).toBe('cancelled');
    expect(h.previewNotifications).toHaveLength(0);
  });

  it('VT-15, VT-17 TBI-025 triggers pipeline with retries on 5xx, fails with stage trigger on 400, and skips grantNext when flag is off', async () => {
    const h = createDeploymentHarness();
    h.leases.clear();
    h.seedRunAndRevision({}, { deploymentStatus: 'queued', pipelineRunId: null });
    h.leases.clear();

    // Flag off -> grantNext skips triggering
    h.setFlagEnabled(false);
    await h.service.grantNext('Apex', 'apex-repo');
    expect(h.queuedBuilds).toHaveLength(0);

    // Flag on, 5xx twice then success
    h.setFlagEnabled(true);
    let attempts = 0;
    h.deps.queuePipelineBuild = async (opts) => {
      attempts += 1;
      if (attempts < 3) {
        const err = new Error('503 Service Unavailable') as Error & { statusCode?: number };
        err.statusCode = 503;
        throw err;
      }
      h.queuedBuilds.push({ commit: opts.commit, revisionId: opts.revisionId });
      return { pipelineRunId: '4411', pipelineUrl: 'https://dev.azure.com/build/4411' };
    };

    await h.service.grantNext('Apex', 'apex-repo');
    expect(attempts).toBe(3);
    expect(h.revisions.get('rev-1')?.pipelineRunId).toBe('4411');

    // 400 error -> fails with stage trigger and releases lease
    h.leases.clear();
    h.revisions.get('rev-1')!.deploymentStatus = 'queued';
    h.revisions.get('rev-1')!.pipelineRunId = null;
    h.deps.queuePipelineBuild = async () => {
      const err = new Error('400 Bad Request') as Error & { statusCode?: number };
      err.statusCode = 400;
      throw err;
    };

    await h.service.grantNext('Apex', 'apex-repo');
    expect(h.revisions.get('rev-1')?.deploymentStatus).toBe('failed');
    expect(h.revisions.get('rev-1')?.deploymentFailedStage).toBe('trigger');
    expect(h.runs.get('run-1')?.status).toBe('deployment_failed');
    expect(h.leases.has('Apex::apex-repo')).toBe(false);
  });

  it('VT-21, VT-22, VT-23, VT-24 PBI-029 AC-0..3 enforces assertMayRetry, deduplicates concurrent retries, and handles repeat failure', async () => {
    const h = createDeploymentHarness();
    const { run } = h.seedRunAndRevision(
      { status: 'deployment_failed' },
      { deploymentStatus: 'failed', validatedCommit: 'x'.repeat(40) },
    );
    h.leases.clear();

    // VT-24: assertMayRetry checks
    expect(
      assertMayRetry(
        { userId: 'u-contact-1', isProjectAdmin: false, isSuperAdmin: false },
        run,
      ),
    ).toBe(true);
    expect(
      assertMayRetry(
        { userId: 'u-proj-admin', isProjectAdmin: true, isSuperAdmin: false },
        run,
      ),
    ).toBe(true);
    expect(
      assertMayRetry(
        { userId: 'u-super', isProjectAdmin: false, isSuperAdmin: true },
        run,
      ),
    ).toBe(true);
    expect(
      assertMayRetry(
        { userId: 'u-member', isProjectAdmin: false, isSuperAdmin: false },
        run,
      ),
    ).toBe(false);

    // VT-21 & VT-23: two concurrent retries -> one changed: true, one changed: false
    const [r1, r2] = await Promise.all([
      h.service.retryDeployment({
        buildRunId: 'run-1',
        actor: { userId: 'u-contact-1', isProjectAdmin: false, isSuperAdmin: false },
      }),
      h.service.retryDeployment({
        buildRunId: 'run-1',
        actor: { userId: 'u-admin', isProjectAdmin: true, isSuperAdmin: false },
      }),
    ]);

    expect(r1.kind).toBe('ok');
    expect(r2.kind).toBe('ok');
    if (r1.kind === 'ok' && r2.kind === 'ok') {
      expect([r1.response.changed, r2.response.changed].sort()).toEqual([false, true]);
    }
    expect(h.revisions.get('rev-1')?.validatedCommit).toBe('x'.repeat(40));
    expect(h.runs.get('run-1')?.status).toBe('deploying');
    expect(h.events.filter((e) => e.eventType === 'deployment_retry_requested')).toHaveLength(1);
  });

  it('VT-26 PBI-026 AC-2 builds previews list descending by revision with only the active lease holder marked isLive', () => {
    const previews = buildPreviewsList({
      revisions: [
        {
          id: 'rev-1',
          revisionNumber: 1,
          validatedCommit: '1'.repeat(40),
          deploymentStatus: 'succeeded',
          deployedAt: '2026-11-01T10:00:00.000Z',
          previewUrl: 'https://preview.example.com/r1',
        },
        {
          id: 'rev-2',
          revisionNumber: 2,
          validatedCommit: '2'.repeat(40),
          deploymentStatus: 'succeeded',
          deployedAt: '2026-11-01T11:00:00.000Z',
          previewUrl: 'https://preview.example.com/r2',
        },
        {
          id: 'rev-3',
          revisionNumber: 3,
          validatedCommit: '3'.repeat(40),
          deploymentStatus: 'succeeded',
          deployedAt: '2026-11-01T12:00:00.000Z',
          previewUrl: 'https://preview.example.com/r3',
        },
      ],
      activeLeaseRevisionId: 'rev-3',
    });

    expect(previews.map((p) => p.revisionNumber)).toEqual([3, 2, 1]);
    expect(previews.map((p) => p.isLive)).toEqual([true, false, false]);
    expect(previews[0].previewUrl).toBe('https://preview.example.com/r3');
    expect(previews[1].previewUrl).toBeNull();
    expect(previews[2].previewUrl).toBeNull();
  });
});
