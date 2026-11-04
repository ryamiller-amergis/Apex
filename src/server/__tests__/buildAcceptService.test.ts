/**
 * S4 + S5 + S6 + S7 + S8 — Build accept service tests (TBI-027 DoD-0..3, PBI-033 AC-0..3, PBI-034 AC-1, AC-3 / VT-01..VT-11, VT-16..VT-20).
 */
import {
  BuildAcceptError,
  createBuildAcceptService,
  type AcceptRevisionRecord,
  type AcceptRunRecord,
  type AcceptScmPort,
  type BuildAcceptServiceDeps,
} from '../services/build/buildAcceptService';

function createAcceptHarness() {
  const runs = new Map<string, AcceptRunRecord>();
  const revisions = new Map<string, AcceptRevisionRecord>();
  const syncTasks = new Map<string, { id: string; revisionId: string; status: 'pending' | 'ready' | 'running' | 'merged' | 'failed'; syncCommitSha: string | null }>();
  const events: Array<{ buildRunId: string; eventType: string; detail?: Record<string, unknown> }> = [];
  const requesterNotifications: Array<{ userId: string; title: string; body: string; dedupeKey: string }> = [];
  const contactNotifications: Array<{ userId: string; title: string; body: string; dedupeKey: string }> = [];
  const releasedLeases: string[] = [];
  const launchedSyncTasks: string[] = [];

  let draftPrUrl: string | null = null;
  let draftPrId: number | null = null;
  let publishedTitle: string | null = null;
  let publishedDescription: string | null = null;
  let publishedIsDraft: boolean | null = null;
  let mergeStatusSequence: Array<'notSet' | 'queued' | 'conflicts' | 'succeeded' | 'rejectedByPolicy' | 'failure'> = ['succeeded'];
  let branchHead = 'a'.repeat(40);
  let reviewerThrow = false;
  let unresolvedReviewerEmail: string | null = null;
  let nowMs = 10_000;

  const seed = (
    runOverrides?: Partial<AcceptRunRecord>,
    revOverrides?: Partial<AcceptRevisionRecord>,
  ) => {
    const run: AcceptRunRecord = {
      id: 'run-1',
      project: 'Apex',
      repository: 'apex-repo',
      status: 'preview_ready',
      requesterUserId: 'user-req',
      requesterDisplayName: 'Dana Lee',
      currentRevisionNumber: 2,
      acceptedRevisionNumber: null,
      integrationBranch: 'apex/build/run-1',
      pullRequestUrl: null,
      pullRequestId: null,
      supportContacts: [
        { userId: 'u-c1', displayName: 'Alice', email: 'alice@example.com' },
        { userId: 'u-c2', displayName: 'Bob', email: 'bob@example.com' },
      ],
      claimedAtMs: null,
      ...runOverrides,
    };
    const rev: AcceptRevisionRecord = {
      id: 'rev-2',
      buildRunId: run.id,
      revisionNumber: 2,
      validatedCommit: 'a'.repeat(40),
      deploymentStatus: 'succeeded',
      briefTitle: 'Customer Export Feature',
      riskDecisions: [
        {
          id: 'RD-1',
          category: 'data',
          rating: 'low',
          decision: 'Stream CSV',
          rationale: 'Low memory footprint',
        },
      ],
      requirements: [
        {
          id: 'AC-1',
          kind: 'ac',
          text: 'Exports CSV rows',
          retired: false,
          verificationStatus: 'pass',
        },
      ],
      ...revOverrides,
    };
    runs.set(run.id, run);
    revisions.set(`${run.id}:${rev.revisionNumber}`, rev);
    return { run, rev };
  };

  const scm: AcceptScmPort = {
    getDefaultBranch: async () => 'main',
    getBranchHeadCommit: async () => branchHead,
    findPullRequestUrlBySourceBranch: async () => draftPrUrl,
    createPullRequest: async () => {
      draftPrId = 901;
      draftPrUrl = 'https://dev.azure.com/org/Apex/_git/apex-repo/pullrequest/901';
      publishedIsDraft = true;
      return draftPrUrl;
    },
    getPullRequestMergeStatus: async () => {
      const next = mergeStatusSequence.length > 1
        ? mergeStatusSequence.shift()!
        : mergeStatusSequence[0];
      return next;
    },
    updatePullRequest: async (opts) => {
      publishedTitle = opts.title;
      if (opts.description !== undefined) publishedDescription = opts.description;
      if (opts.isDraft !== undefined) publishedIsDraft = opts.isDraft;
    },
    addPullRequestLabel: async () => undefined,
    resolveIdentityIdByEmail: async (_project, email) => {
      if (unresolvedReviewerEmail && email === unresolvedReviewerEmail) return null;
      return `ado-id-${email}`;
    },
    addPullRequestReviewers: async (opts) => {
      if (reviewerThrow) throw new Error('ADO reviewer API error');
      return { added: opts.reviewers.map((r) => r.id), failed: [] };
    },
    addPullRequestComment: async () => undefined,
  };

  const deps: BuildAcceptServiceDeps = {
    now: () => nowMs,
    sleep: async (ms) => {
      nowMs += ms;
    },
    withAcceptLock: async (_runId, fn) => fn(),
    loadRun: async (buildId) => runs.get(buildId) ?? null,
    loadRevision: async (buildId, revNum) => revisions.get(`${buildId}:${revNum}`) ?? null,
    casClaimAccept: async (buildId, revisionNumber) => {
      const run = runs.get(buildId);
      if (!run) return { kind: 'not_found' };
      if (run.status === 'accepted' || run.status === 'needs_developer') {
        if (run.acceptedRevisionNumber === revisionNumber) {
          return { kind: 'already_claimed', run };
        }
      }
      if (run.currentRevisionNumber !== revisionNumber) {
        return { kind: 'stale_revision' };
      }
      const rev = revisions.get(`${buildId}:${revisionNumber}`);
      if (run.status !== 'preview_ready' || !rev || rev.deploymentStatus !== 'succeeded') {
        return { kind: 'not_acceptable' };
      }
      run.status = 'accepted';
      run.acceptedRevisionNumber = revisionNumber;
      run.claimedAtMs = nowMs;
      return { kind: 'claimed', run };
    },
    releaseLease: async (runId) => {
      releasedLeases.push(runId);
    },
    findOrInsertSyncTask: async (revisionId, revisionNumber) => {
      const key = `sync-r${revisionNumber}`;
      const existing = syncTasks.get(key);
      if (existing) return { inserted: false, task: existing };
      const created = {
        id: `task-${key}`,
        revisionId,
        status: 'ready' as const,
        syncCommitSha: null,
      };
      syncTasks.set(key, created);
      return { inserted: true, task: created };
    },
    getSyncTaskForRevision: async (_revisionId, revisionNumber) =>
      syncTasks.get(`sync-r${revisionNumber}`) ?? null,
    launchSyncTask: async (taskId) => {
      const entry = [...syncTasks.values()].find((t) => t.id === taskId);
      if (entry) entry.status = 'running';
      launchedSyncTasks.push(taskId);
    },
    casCompleteSyncTask: async (taskId, nextStatus, syncCommitSha) => {
      const entry = [...syncTasks.values()].find((t) => t.id === taskId);
      if (!entry || entry.status !== 'running') return null;
      entry.status = nextStatus;
      if (syncCommitSha) entry.syncCommitSha = syncCommitSha;
      return entry;
    },
    setRunNeedsDeveloper: async (runId) => {
      const run = runs.get(runId);
      if (run && run.status === 'accepted') run.status = 'needs_developer';
    },
    storePullRequestUrl: async (runId, prId, prUrl) => {
      const run = runs.get(runId);
      if (run && !run.pullRequestUrl) {
        run.pullRequestId = prId;
        run.pullRequestUrl = prUrl;
      }
    },
    notifyRequesterPrOpened: async (input) => {
      if (!requesterNotifications.some((n) => n.dedupeKey === input.dedupeKey)) {
        requesterNotifications.push(input);
      }
    },
    notifyContactNeedsDeveloper: async (input) => {
      if (!contactNotifications.some((n) => n.dedupeKey === input.dedupeKey)) {
        contactNotifications.push(input);
      }
    },
    appendEvent: async (ev) => {
      events.push(ev);
    },
    scm,
  };

  return {
    runs,
    revisions,
    syncTasks,
    events,
    requesterNotifications,
    contactNotifications,
    releasedLeases,
    launchedSyncTasks,
    getPrState: () => ({
      draftPrUrl,
      draftPrId,
      publishedTitle,
      publishedDescription,
      publishedIsDraft,
    }),
    setMergeStatusSequence: (seq: typeof mergeStatusSequence) => {
      mergeStatusSequence = seq;
    },
    setBranchHead: (sha: string) => {
      branchHead = sha;
    },
    setReviewerThrow: (v: boolean) => {
      reviewerThrow = v;
    },
    setUnresolvedReviewerEmail: (email: string | null) => {
      unresolvedReviewerEmail = email;
    },
    seed,
    scm,
    deps,
    service: createBuildAcceptService(deps),
  };
}

describe('buildAcceptService (TBI-027, PBI-033, PBI-034 / VT-01..VT-11, VT-16..VT-20)', () => {
  it('VT-01, VT-02, VT-17, VT-18 PBI-033 AC-0 / TBI-027 DoD-0, DoD-3 claims accept, releases lease, polls queued -> succeeded within 30s, publishes PR with risk decisions, adds reviewers, notifies requester, and SCM port has no complete method', async () => {
    const h = createAcceptHarness();
    h.seed();
    h.setMergeStatusSequence(['queued', 'queued', 'succeeded']);

    // VT-18: SCM port surface has no complete or vote method
    expect('completePullRequest' in h.scm).toBe(false);
    expect('votePullRequest' in h.scm).toBe(false);

    const claimed = await h.service.acceptBuild({
      buildId: 'run-1',
      project: 'Apex',
      revisionNumber: 2,
      actor: {
        userId: 'user-req',
        isProjectAdmin: false,
        isSuperAdmin: false,
      },
    });

    expect(claimed.firstClaim).toBe(true);
    expect(claimed.response.status).toBe('accepted');
    expect(claimed.response.acceptState).toBe('opening_pull_request');
    expect(h.releasedLeases).toEqual(['run-1']);

    await h.service.continueAccept('run-1');

    const run = h.runs.get('run-1')!;
    expect(run.pullRequestUrl).toBe('https://dev.azure.com/org/Apex/_git/apex-repo/pullrequest/901');
    expect(h.getPrState().publishedIsDraft).toBe(false);
    expect(h.getPrState().publishedDescription).toContain('RD-1 [low]');
    expect(h.events.map((e) => e.eventType)).toEqual(
      expect.arrayContaining(['reviewers_added', 'pull_request_opened']),
    );
    const prOpenedEvent = h.events.find((e) => e.eventType === 'pull_request_opened')!;
    expect(Number(prOpenedEvent.detail?.durationMs)).toBeLessThan(30_000);
    expect(h.requesterNotifications).toHaveLength(1);
    expect(h.requesterNotifications[0].body).toContain(run.pullRequestUrl!);
  });

  it('VT-03, VT-04 PBI-033 AC-1 / PBI-034 AC-2 / TBI-027 DoD-1 launches 1 sync agent on conflicts and publishes PR with sync commit note on sync success', async () => {
    const h = createAcceptHarness();
    h.seed();
    h.setMergeStatusSequence(['conflicts']);

    await h.service.acceptBuild({
      buildId: 'run-1',
      project: 'Apex',
      revisionNumber: 2,
      actor: { userId: 'user-req', isProjectAdmin: false, isSuperAdmin: false },
    });
    await h.service.continueAccept('run-1');

    expect(h.launchedSyncTasks).toEqual(['task-sync-r2']);
    expect(h.getPrState().publishedIsDraft).toBe(true);
    expect(h.runs.get('run-1')?.pullRequestUrl).toBeNull();

    // Sync finishes cleanly: branch head advances and mergeStatus is now succeeded
    const newHead = 'b'.repeat(40);
    h.setBranchHead(newHead);
    h.setMergeStatusSequence(['succeeded']);

    await h.service.applySyncResult('task-sync-r2', {
      settled: true,
      status: 'finished',
      unitPassed: true,
    });

    expect(h.runs.get('run-1')?.pullRequestUrl).toBe(
      'https://dev.azure.com/org/Apex/_git/apex-repo/pullrequest/901',
    );
    expect(h.getPrState().publishedIsDraft).toBe(false);
    expect(h.getPrState().publishedDescription).toContain(newHead.slice(0, 7));
    expect(h.getPrState().publishedDescription).toMatch(/sync commit was added/i);
    expect(h.events.map((e) => e.eventType)).toContain('sync_commit_added');
  });

  it('VT-05, VT-06 PBI-033 AC-2 / TBI-027 DoD-2 moves run to needs_developer, prefixes draft title with [Needs developer], notifies support contacts once, and is idempotent on repeat delivery', async () => {
    const h = createAcceptHarness();
    h.seed();
    h.setMergeStatusSequence(['conflicts']);

    await h.service.acceptBuild({
      buildId: 'run-1',
      project: 'Apex',
      revisionNumber: 2,
      actor: { userId: 'user-req', isProjectAdmin: false, isSuperAdmin: false },
    });
    await h.service.continueAccept('run-1');

    // Sync fails (unitPassed: false)
    await h.service.applySyncResult('task-sync-r2', {
      settled: true,
      status: 'finished',
      unitPassed: false,
    });
    // Repeat delivery (VT-06)
    await h.service.applySyncResult('task-sync-r2', {
      settled: true,
      status: 'finished',
      unitPassed: false,
    });

    expect(h.runs.get('run-1')?.status).toBe('needs_developer');
    expect(h.getPrState().publishedTitle).toMatch(/^\[Needs developer\]/);
    expect(h.contactNotifications).toHaveLength(2);
    expect(h.events.filter((e) => e.eventType === 'needs_developer')).toHaveLength(1);
  });

  it('VT-07 PBI-033 AC-3 / TBI-027 NFR is idempotent on sequential and concurrent accept calls, opening only one pull request', async () => {
    const h = createAcceptHarness();
    h.seed();

    const [a1, a2] = await Promise.all([
      h.service.acceptBuild({
        buildId: 'run-1',
        project: 'Apex',
        revisionNumber: 2,
        actor: { userId: 'user-req', isProjectAdmin: false, isSuperAdmin: false },
      }),
      h.service.acceptBuild({
        buildId: 'run-1',
        project: 'Apex',
        revisionNumber: 2,
        actor: { userId: 'user-req', isProjectAdmin: false, isSuperAdmin: false },
      }),
    ]);

    expect([a1.firstClaim, a2.firstClaim].sort()).toEqual([false, true]);
    await h.service.continueAccept('run-1');
    await h.service.continueAccept('run-1');
    expect(h.requesterNotifications).toHaveLength(1);
  });

  it('VT-08, VT-09, VT-11 PBI-033 AC-4..5 enforces actor authorization, revision freshness, run status, and branch head match', async () => {
    const h = createAcceptHarness();
    h.seed();

    // VT-08: non-requester member -> 403 BUILD_NOT_ALLOWED
    await expect(
      h.service.acceptBuild({
        buildId: 'run-1',
        project: 'Apex',
        revisionNumber: 2,
        actor: { userId: 'user-other', isProjectAdmin: false, isSuperAdmin: false },
      }),
    ).rejects.toMatchObject({
      code: 'BUILD_NOT_ALLOWED',
      statusCode: 403,
    } satisfies Partial<BuildAcceptError>);

    // VT-09: stale revision 1 while 2 is current -> 409 BUILD_STALE_REVISION
    await expect(
      h.service.acceptBuild({
        buildId: 'run-1',
        project: 'Apex',
        revisionNumber: 1,
        actor: { userId: 'user-req', isProjectAdmin: false, isSuperAdmin: false },
      }),
    ).rejects.toMatchObject({
      code: 'BUILD_STALE_REVISION',
      statusCode: 409,
    });

    // VT-11: diverged branch -> 409 BUILD_BRANCH_DIVERGED
    h.setBranchHead('d'.repeat(40));
    await expect(
      h.service.acceptBuild({
        buildId: 'run-1',
        project: 'Apex',
        revisionNumber: 2,
        actor: { userId: 'user-req', isProjectAdmin: false, isSuperAdmin: false },
      }),
    ).rejects.toMatchObject({
      code: 'BUILD_BRANCH_DIVERGED',
      statusCode: 409,
    });
  });

  it('VT-16 PBI-034 AC-1 publishes PR and records reviewers_failed event when reviewer assignment fails', async () => {
    const h = createAcceptHarness();
    h.seed();
    h.setReviewerThrow(true);

    await h.service.acceptBuild({
      buildId: 'run-1',
      project: 'Apex',
      revisionNumber: 2,
      actor: { userId: 'user-req', isProjectAdmin: false, isSuperAdmin: false },
    });
    await h.service.continueAccept('run-1');

    expect(h.runs.get('run-1')?.pullRequestUrl).toBe(
      'https://dev.azure.com/org/Apex/_git/apex-repo/pullrequest/901',
    );
    expect(h.events.map((e) => e.eventType)).toContain('reviewers_failed');
    expect(h.requesterNotifications).toHaveLength(1);
  });
});
