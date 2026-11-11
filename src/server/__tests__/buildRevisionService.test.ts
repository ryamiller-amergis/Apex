/**
 * S5 + S8 + S9 + S10 + S11 — Build revision service tests (TBI-026 DoD-1..3, PBI-030..032 / VT-13..VT-17, VT-28..VT-34, VT-38).
 */
import {
  BuildRevisionError,
  createBuildRevisionService,
  type BuildRevisionServiceDeps,
  type RevisionRunRecord,
  type RevisionStateRecord,
} from '../services/buildRevisionService';

function createRevisionHarness() {
  const runs = new Map<string, RevisionRunRecord>();
  const revisions = new Map<string, RevisionStateRecord>();
  const events: Array<{
    buildRunId: string;
    eventType: string;
    detail?: Record<string, unknown>;
    actorUserId?: string | null;
  }> = [];
  const tasksCreated: Array<{
    revisionId: string;
    taskKey: string;
    covers: string[];
  }> = [];
  const mergeCalls: Array<{
    sourceBranch: string;
    targetBranch: string;
    deleteSourceBranch: boolean;
  }> = [];
  const feedbackTurns: Array<{
    threadId: string;
    feedback: string;
    revisionNumber: number;
  }> = [];
  const kickoffSends: Array<{ threadId: string; prompt: string }> = [];
  const editableStarts: Array<{
    buildRunId: string;
    draftRevisionId: string;
  }> = [];
  let mergeOutcome: 'merged' | 'nothing_to_merge' | 'conflict' = 'merged';
  let repairAttempts = 0;

  const seed = (
    runOverrides?: Partial<RevisionRunRecord>,
    revOverrides?: Partial<RevisionStateRecord>
  ) => {
    const run: RevisionRunRecord = {
      id: 'run-1',
      project: 'Apex',
      repository: 'apex-repo',
      status: 'preview_ready',
      requesterUserId: 'user-req',
      requesterDisplayName: 'Dana Lee',
      currentRevisionNumber: 1,
      revisionsUsed: 0,
      revisionCap: 5,
      interviewId: 'iv-1',
      chatThreadId: 'thread-1',
      integrationBranch: 'apex/build/run-1',
      defaultBranch: 'main',
      ...runOverrides,
    };
    const rev: RevisionStateRecord = {
      id: 'rev-1',
      buildRunId: run.id,
      revisionNumber: 1,
      requestedByUserId: run.requesterUserId,
      feedback: null,
      briefVersion: 1,
      classification: 'small',
      catchUpConflict: false,
      requirements: [
        { id: 'AC-1', kind: 'ac', text: 'First criterion', retired: false },
        { id: 'AC-2', kind: 'ac', text: 'Second criterion', retired: false },
      ],
      riskDecisions: [],
      changedAndAddedIds: ['AC-2'],
      hasKickoffTurnSent: false,
      ...revOverrides,
    };
    runs.set(run.id, run);
    revisions.set(rev.id, rev);
    return { run, rev };
  };

  const deps: BuildRevisionServiceDeps = {
    loadRun: async (buildId) => runs.get(buildId) ?? null,
    loadRunByInterviewId: async (interviewId) => {
      for (const r of runs.values()) {
        if (r.interviewId === interviewId) return r;
      }
      return null;
    },
    loadCurrentRevision: async (buildRunId, revisionNumber) => {
      for (const rev of revisions.values()) {
        if (
          rev.buildRunId === buildRunId &&
          rev.revisionNumber === revisionNumber
        ) {
          return rev;
        }
      }
      return null;
    },
    casTransitionToIntake: async ({
      buildId,
      project,
      redactedFeedback,
      actorUserId,
    }) => {
      const run = runs.get(buildId);
      if (!run || run.project !== project) return { kind: 'not_found' };
      if (run.status === 'intake') {
        const openRev = [...revisions.values()].find(
          (r) =>
            r.buildRunId === buildId &&
            r.revisionNumber === run.currentRevisionNumber
        );
        if (
          openRev &&
          openRev.requestedByUserId === actorUserId &&
          openRev.feedback === redactedFeedback
        ) {
          return { kind: 'resumed', run, revision: openRev };
        }
        return { kind: 'in_progress' };
      }
      if (run.status !== 'preview_ready') {
        return { kind: 'not_revisable', status: run.status };
      }
      if (run.revisionsUsed >= run.revisionCap) {
        return { kind: 'cap_reached', limit: run.revisionCap };
      }

      run.status = 'intake';
      run.revisionsUsed += 1;
      run.currentRevisionNumber += 1;

      const prevRev = [...revisions.values()].find(
        (r) =>
          r.buildRunId === buildId &&
          r.revisionNumber === run.currentRevisionNumber - 1
      );
      const nextRev: RevisionStateRecord = {
        id: `rev-${run.currentRevisionNumber}`,
        buildRunId: buildId,
        revisionNumber: run.currentRevisionNumber,
        requestedByUserId: actorUserId,
        feedback: redactedFeedback,
        briefVersion: null,
        classification: null,
        catchUpConflict: false,
        requirements: prevRev
          ? prevRev.requirements.map((r) => ({ ...r }))
          : [],
        riskDecisions: prevRev
          ? prevRev.riskDecisions.map((r) => ({ ...r }))
          : [],
        changedAndAddedIds: [],
        hasKickoffTurnSent: false,
      };
      revisions.set(nextRev.id, nextRev);
      return { kind: 'started', run, revision: nextRev };
    },
    reopenBrief: async () => undefined,
    appendRevisionFeedback: async (
      threadId,
      feedback,
      _revisionId,
      revisionNumber
    ) => {
      feedbackTurns.push({ threadId, feedback, revisionNumber });
    },
    sendKickoffTurn: async (threadId, prompt, revisionId) => {
      kickoffSends.push({ threadId, prompt });
      const rev = revisions.get(revisionId);
      if (rev) rev.hasKickoffTurnSent = true;
    },
    casApproveRevision: async (
      buildRunId,
      revisionNumber,
      classification,
      briefVersion
    ) => {
      const run = runs.get(buildRunId);
      const rev = [...revisions.values()].find(
        (r) =>
          r.buildRunId === buildRunId && r.revisionNumber === revisionNumber
      );
      if (!run || !rev || run.status !== 'intake') return false;
      run.status = classification === 'small' ? 'building' : 'planning';
      rev.classification = classification;
      rev.briefVersion = briefVersion;
      return true;
    },
    mergeIntoIntegration: async (opts) => {
      mergeCalls.push(opts);
      return mergeOutcome;
    },
    incrementRepairAttempt: async () => {
      if (repairAttempts < 2) {
        repairAttempts += 1;
        return { granted: true, used: repairAttempts };
      }
      return { granted: false, used: 2 };
    },
    createSmallRevisionTask: async (revisionId, covers) => {
      tasksCreated.push({ revisionId, taskKey: 'r-small-1', covers });
    },
    launchRevisionAgent: async () => undefined,
    beginEditablePreview: async (input) => {
      editableStarts.push(input);
    },
    appendEvent: async (ev) => {
      events.push(ev);
    },
  };

  return {
    runs,
    revisions,
    events,
    tasksCreated,
    mergeCalls,
    feedbackTurns,
    kickoffSends,
    editableStarts,
    setMergeOutcome: (o: 'merged' | 'nothing_to_merge' | 'conflict') => {
      mergeOutcome = o;
    },
    getRepairAttempts: () => repairAttempts,
    seed,
    deps,
    service: createBuildRevisionService(deps),
  };
}

describe('buildRevisionService (TBI-026, PBI-030..032 / VT-13..17, VT-28..32)', () => {
  it('routes an accepted contained UI revision to the fast lane without reopening intake', async () => {
    const h = createRevisionHarness();
    h.seed();
    h.deps.requestFastRevision = jest.fn(async () => {
      h.revisions.set('rev-2', {
        ...h.revisions.get('rev-1')!,
        id: 'rev-2',
        revisionNumber: 2,
        feedback: 'Move the Cancel button to the right.',
      });
      return {
        buildId: 'run-1',
        revisionNumber: 2,
        status: 'building' as const,
        revisionsUsed: 1,
        revisionsLimit: 5,
        interviewId: 'iv-1',
        chatThreadId: 'thread-1',
        resumed: false,
      };
    });
    const service = createBuildRevisionService(h.deps);

    await expect(
      service.requestRevision({
        buildId: 'run-1',
        project: 'Apex',
        feedback: 'Move the Cancel button to the right.',
        actor: {
          userId: 'user-req',
          displayName: 'Dana Lee',
          isProjectAdmin: false,
          isSuperAdmin: false,
        },
      })
    ).resolves.toMatchObject({ status: 'building', revisionNumber: 2 });

    expect(h.deps.requestFastRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        redactedFeedback: 'Move the Cancel button to the right.',
      })
    );
    expect(h.feedbackTurns).toEqual([
      {
        threadId: 'thread-1',
        feedback: 'Move the Cancel button to the right.',
        revisionNumber: 2,
      },
    ]);
    expect(h.kickoffSends).toHaveLength(0);
    expect(h.editableStarts).toHaveLength(0);
  });

  it('queues a change sent while the build runs and tells the requester in chat', async () => {
    const h = createRevisionHarness();
    h.seed({ status: 'building' });
    const queued: string[] = [];
    const replies: string[] = [];
    h.deps.queueRevision = async ({ redactedFeedback }) => {
      queued.push(redactedFeedback);
    };
    h.deps.appendAssistantReply = async (_threadId, text) => {
      replies.push(text);
    };
    h.deps.requestFastRevision = jest.fn();
    const service = createBuildRevisionService(h.deps);

    await expect(
      service.requestRevision({
        buildId: 'run-1',
        project: 'Apex',
        feedback: 'Use a darker token set for the dark theme.',
        actor: {
          userId: 'user-req',
          displayName: 'Dana Lee',
          isProjectAdmin: false,
          isSuperAdmin: false,
        },
      })
    ).resolves.toMatchObject({ status: 'queued', revisionNumber: 2 });

    expect(queued).toEqual(['Use a darker token set for the dark theme.']);
    expect(h.feedbackTurns).toEqual([
      {
        threadId: 'thread-1',
        feedback: 'Use a darker token set for the dark theme.',
        revisionNumber: 2,
      },
    ]);
    expect(replies[0]).toContain('revision 2');
    expect(h.deps.requestFastRevision).not.toHaveBeenCalled();
    expect(h.runs.get('run-1')?.status).toBe('building');
  });

  it('keeps the request in chat and replies with the reason when it is refused', async () => {
    const h = createRevisionHarness();
    h.seed({ status: 'cancelled' });
    const replies: string[] = [];
    h.deps.appendAssistantReply = async (_threadId, text) => {
      replies.push(text);
    };

    await expect(
      createBuildRevisionService(h.deps).requestRevision({
        buildId: 'run-1',
        project: 'Apex',
        feedback: 'Make the header blue.',
        actor: {
          userId: 'user-req',
          displayName: 'Dana Lee',
          isProjectAdmin: false,
          isSuperAdmin: false,
        },
      })
    ).rejects.toMatchObject({ code: 'BUILD_NOT_REVISABLE' });

    expect(h.feedbackTurns.map((turn) => turn.feedback)).toEqual([
      'Make the header blue.',
    ]);
    expect(replies).toEqual([
      'Changes can only be requested when the preview is ready.',
    ]);
  });

  it('does not save the request again when a queued change starts', async () => {
    const h = createRevisionHarness();
    h.seed();

    await h.service.requestRevision({
      buildId: 'run-1',
      project: 'Apex',
      feedback: 'Change heading colour',
      chatMessageSaved: true,
      actor: {
        userId: 'user-req',
        isProjectAdmin: false,
        isSuperAdmin: true,
      },
    });

    expect(h.feedbackTurns).toHaveLength(0);
  });

  it('routes screenshot-grounded revisions to the fast lane without reopening intake', async () => {
    const h = createRevisionHarness();
    h.seed();
    h.deps.requestFastRevision = jest.fn(async () => ({
      buildId: 'run-1',
      revisionNumber: 2,
      status: 'building' as const,
      revisionsUsed: 1,
      revisionsLimit: 5,
      interviewId: 'iv-1',
      chatThreadId: 'thread-1',
      resumed: false,
    }));
    const service = createBuildRevisionService(h.deps);

    await expect(
      service.requestRevision({
        buildId: 'run-1',
        project: 'Apex',
        feedback: 'Match the spacing in the pasted screenshot.',
        hasAttachments: true,
        actor: {
          userId: 'user-req',
          displayName: 'Dana Lee',
          isProjectAdmin: false,
          isSuperAdmin: false,
        },
      })
    ).resolves.toMatchObject({ status: 'building', revisionNumber: 2 });

    expect(h.deps.requestFastRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        redactedFeedback: 'Match the spacing in the pasted screenshot.',
      })
    );
    expect(h.feedbackTurns).toHaveLength(0);
    expect(h.kickoffSends).toHaveLength(0);
  });

  it('requires an approved candidate id before applying a logo', async () => {
    const h = createRevisionHarness();
    h.seed();

    await expect(
      h.service.requestRevision({
        buildId: 'run-1',
        project: 'Apex',
        feedback:
          'Place the approved logo from /brand/logo.png in the top navigation.',
        actor: {
          userId: 'user-req',
          displayName: 'Dana Lee',
          isProjectAdmin: false,
          isSuperAdmin: false,
        },
      })
    ).rejects.toMatchObject({
      code: 'APPROVED_LOGO_REQUIRED',
      statusCode: 409,
    });
  });

  it('VT-13 PBI-030 AC-0 / TBI-026 NFR redacts feedback, transitions run to intake, increments revisionsUsed, writes revision.requested, and dispatches kickoff', async () => {
    const h = createRevisionHarness();
    h.seed();

    const result = await h.service.requestRevision({
      buildId: 'run-1',
      project: 'Apex',
      feedback: 'Please update label and remove Bearer secretToken123456',
      actor: {
        userId: 'user-req',
        displayName: 'Dana Lee',
        isProjectAdmin: false,
        isSuperAdmin: false,
      },
    });

    expect(result).toEqual({
      buildId: 'run-1',
      revisionNumber: 2,
      status: 'intake',
      revisionsUsed: 1,
      revisionsLimit: 5,
      interviewId: 'iv-1',
      chatThreadId: 'thread-1',
      resumed: false,
    });
    expect(h.editableStarts).toEqual([
      { buildRunId: 'run-1', draftRevisionId: 'rev-2' },
    ]);

    const rev2 = h.revisions.get('rev-2')!;
    expect(rev2.feedback).not.toContain('secretToken123456');
    expect(rev2.feedback).toContain('[REDACTED:bearer-token]');
    expect(h.events.some((e) => e.eventType === 'revision.requested')).toBe(
      true
    );
    expect(h.feedbackTurns).toEqual([
      {
        threadId: 'thread-1',
        feedback: 'Please update label and remove [REDACTED:bearer-token]',
        revisionNumber: 2,
      },
    ]);
    expect(h.kickoffSends).toHaveLength(1);
  });

  it('VT-14 PBI-030 AC-3 / TBI-026 DoD-1 refuses 6th revision with 409 REVISION_CAP_REACHED and leaves state unchanged', async () => {
    const h = createRevisionHarness();
    h.seed({ revisionsUsed: 5, currentRevisionNumber: 6 });

    await expect(
      h.service.requestRevision({
        buildId: 'run-1',
        project: 'Apex',
        feedback: 'One more change',
        actor: {
          userId: 'user-req',
          displayName: 'Dana Lee',
          isProjectAdmin: false,
          isSuperAdmin: false,
        },
      })
    ).rejects.toMatchObject({
      code: 'REVISION_CAP_REACHED',
      statusCode: 409,
    });

    expect(h.runs.get('run-1')?.revisionsUsed).toBe(5);
    expect(h.runs.get('run-1')?.status).toBe('preview_ready');
  });

  it('VT-15, VT-16 PBI-030 AC-1 / PBI-032 AC-2 resumes open intake revision for same actor+feedback and refuses different actor with REVISION_IN_PROGRESS', async () => {
    const h = createRevisionHarness();
    h.seed();

    const first = await h.service.requestRevision({
      buildId: 'run-1',
      project: 'Apex',
      feedback: 'Change heading colour',
      actor: {
        userId: 'user-req',
        displayName: 'Dana Lee',
        isProjectAdmin: false,
        isSuperAdmin: false,
      },
    });
    expect(first.resumed).toBe(false);

    // Same actor & feedback -> idempotent retry (resumed: true)
    const retry = await h.service.requestRevision({
      buildId: 'run-1',
      project: 'Apex',
      feedback: 'Change heading colour',
      actor: {
        userId: 'user-req',
        displayName: 'Dana Lee',
        isProjectAdmin: false,
        isSuperAdmin: false,
      },
    });
    expect(retry.resumed).toBe(true);
    expect(h.runs.get('run-1')?.revisionsUsed).toBe(1);

    // Different actor (Project Admin racing) -> 409 REVISION_IN_PROGRESS
    await expect(
      h.service.requestRevision({
        buildId: 'run-1',
        project: 'Apex',
        feedback: 'Admin concurrent change',
        actor: {
          userId: 'user-admin',
          displayName: 'Admin One',
          isProjectAdmin: true,
          isSuperAdmin: false,
        },
      })
    ).rejects.toMatchObject({
      code: 'REVISION_IN_PROGRESS',
      statusCode: 409,
    } satisfies Partial<BuildRevisionError>);
  });

  it('VT-28, VT-29, VT-30, VT-31, VT-32 PBI-031 AC-0..1 / TBI-026 DoD-2..3 handles brief approval idempotently, calls catch-up merge with deleteSourceBranch: false, and counts 1 repair attempt on conflict', async () => {
    const h = createRevisionHarness();
    h.seed({ status: 'intake', currentRevisionNumber: 2, revisionsUsed: 1 });
    h.revisions.set('rev-2', {
      id: 'rev-2',
      buildRunId: 'run-1',
      revisionNumber: 2,
      requestedByUserId: 'user-req',
      feedback: 'Update AC-2',
      briefVersion: null,
      classification: null,
      catchUpConflict: false,
      requirements: [
        { id: 'AC-1', kind: 'ac', text: 'First', retired: false },
        { id: 'AC-2', kind: 'ac', text: 'Second updated', retired: false },
      ],
      riskDecisions: [],
      changedAndAddedIds: ['AC-2'],
      hasKickoffTurnSent: true,
    });

    h.setMergeOutcome('conflict');

    const firstApprove = await h.service.handleRevisionBriefApproved({
      interviewId: 'iv-1',
      approvedBy: 'user-req',
      briefVersion: 2,
      classification: 'small',
    });
    const secondApprove = await h.service.handleRevisionBriefApproved({
      interviewId: 'iv-1',
      approvedBy: 'user-req',
      briefVersion: 2,
      classification: 'small',
    });

    expect(firstApprove).toEqual({
      revisionNumber: 2,
      status: 'building',
    });
    expect(secondApprove).toBeNull();

    // VT-31: merge called with source = defaultBranch and deleteSourceBranch = false
    expect(h.mergeCalls).toEqual([
      {
        sourceBranch: 'main',
        targetBranch: 'apex/build/run-1',
        deleteSourceBranch: false,
      },
    ]);
    // VT-30: conflict sets catchUpConflict and spends 1 repair attempt
    expect(h.revisions.get('rev-2')?.catchUpConflict).toBe(true);
    expect(h.getRepairAttempts()).toBe(1);
    // VT-32: small revision creates 1 task covering only changed IDs
    expect(h.tasksCreated).toEqual([
      {
        revisionId: 'rev-2',
        taskKey: 'r-small-1',
        covers: ['AC-2'],
      },
    ]);
  });
});
