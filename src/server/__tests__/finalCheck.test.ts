/**
 * S6 — Final check orchestration tests (TBI-023 DoD-3, PBI-024 AC-0..3, PBI-025 AC-0..3 / VT-13, VT-15, VT-18..VT-25, VT-27, VT-28).
 */
import {
  applyFinalCheckCompletion,
  onAllTasksMerged,
  type FinalCheckDeps,
  type FinalCheckState,
} from '../services/build/finalCheck';

function createFinalCheckHarness(initial?: Partial<FinalCheckState>): {
  state: FinalCheckState;
  deps: FinalCheckDeps;
  events: Array<{
    eventType: string;
    message: string;
    detail?: Record<string, unknown>;
  }>;
  dispatchedRuns: string[];
  evidenceBlobs: string[];
  mergedTaskIds: string[];
} {
  const state: FinalCheckState = {
    runId: 'run-1',
    revisionId: 'rev-1',
    runStatus: 'building',
    suspendReason: null,
    suspensionMessage: null,
    integrationBranch: 'apex/build/run-1',
    integrationHeadCommit: 'a'.repeat(40),
    validatedCommit: null,
    repairAttempts: 0,
    supportContacts: [
      { userId: 'u1', displayName: 'Dana', email: 'dana@example.com' },
    ],
    tasks: [
      {
        id: 't1',
        taskKey: 'impl-a',
        role: 'implementer',
        status: 'merged',
        runMode: 'own_agent',
        attempt: 1,
      },
      {
        id: 't2',
        taskKey: 'impl-b',
        role: 'implementer',
        status: 'merged',
        runMode: 'own_agent',
        attempt: 1,
      },
    ],
    ...initial,
  };

  const events: Array<{
    eventType: string;
    message: string;
    detail?: Record<string, unknown>;
  }> = [];
  const dispatchedRuns: string[] = [];
  const evidenceBlobs: string[] = [];
  const mergedTaskIds: string[] = [];

  const deps: FinalCheckDeps = {
    withRevisionLock: async (_revId, fn) => fn(),
    loadRevisionState: async () => state,
    loadStateByCheckTaskId: async (checkTaskId) => {
      const hasTask = state.tasks.some((t) => t.id === checkTaskId);
      return hasTask ? state : null;
    },
    getIntegrationBranchHead: async () => state.integrationHeadCommit,
    insertFinalCheckTask: async (_revId, task) => {
      const existing = state.tasks.find((t) => t.taskKey === 'final-check');
      if (existing) return { inserted: false, taskId: existing.id };
      const id = 'task-final-check';
      state.tasks.push({
        id,
        taskKey: 'final-check',
        role: 'check',
        status: task.status,
        runMode: task.runMode,
        attempt: task.attempt,
        dependsOn: task.dependsOn,
      });
      return { inserted: true, taskId: id };
    },
    setRunStatus: async (_runId, nextStatus) => {
      state.runStatus = nextStatus;
    },
    markValidated: async (_revId, commit) => {
      if (state.validatedCommit && state.validatedCommit !== commit) {
        throw new Error('Conflicting validatedCommit');
      }
      state.validatedCommit = commit;
      if (state.runStatus === 'building' || state.runStatus === 'checking') {
        state.runStatus = 'deploying';
      }
    },
    compareAndSetCheckTask: async (
      checkTaskId,
      expectedAttempt,
      nextStatus,
      nextAttempt
    ) => {
      const task = state.tasks.find((t) => t.id === checkTaskId);
      if (
        !task ||
        task.status !== 'running' ||
        task.attempt !== expectedAttempt
      ) {
        return false;
      }
      task.status = nextStatus;
      if (nextAttempt !== undefined) task.attempt = nextAttempt;
      return true;
    },
    requestRepairAttempt: async () => {
      if (state.repairAttempts < 2) {
        state.repairAttempts += 1;
        return { granted: true, used: state.repairAttempts };
      }
      return { granted: false, used: 2 };
    },
    mergeCheckBranch: async (checkTaskId) => {
      mergedTaskIds.push(checkTaskId);
      const nextCommit = 'c'.repeat(40);
      state.integrationHeadCommit = nextCommit;
      return {
        outcome: 'merged',
        mergeCommit: nextCommit,
        prUrl: 'https://dev.azure.com/pr/99',
      };
    },
    suspendRun: async (_runId, reason, message) => {
      state.runStatus = 'suspended';
      state.suspendReason = reason;
      state.suspensionMessage = message;
    },
    appendEvent: async (ev) => {
      events.push(ev);
    },
    writeEvidenceBlob: async (_revId, content) => {
      evidenceBlobs.push(content);
    },
    dispatchNext: async (runId) => {
      dispatchedRuns.push(runId);
    },
  };

  return { state, deps, events, dispatchedRuns, evidenceBlobs, mergedTaskIds };
}

function makeReportText(overrides: Record<string, unknown> = {}): string {
  const payload = {
    schemaVersion: 1,
    validatedCommit: 'a'.repeat(40),
    repairedInSession: false,
    checks: [
      { kind: 'unit_full', outcome: 'passed', summary: 'All passed' },
      { kind: 'unit_related', outcome: 'passed', summary: 'Related passed' },
      { kind: 'type_check', outcome: 'passed', summary: 'tsc ok' },
      { kind: 'lint', outcome: 'passed', summary: 'lint ok' },
    ],
    standards: { status: 'reviewed', findings: [] },
    summary: 'Everything looks clean.',
    ...overrides,
  };
  return `Done.\n\`\`\`apex-final-check-report\n${JSON.stringify(payload)}\n\`\`\``;
}

describe('finalCheck orchestration (PBI-024, PBI-025, TBI-023 / VT-13, VT-15, VT-18..VT-25, VT-27, VT-28)', () => {
  it('VT-13 PBI-024 AC-2 / TBI-023 DoD-3 skips final-check when only one own_agent task ran, setting validated_commit and moving to deploying', async () => {
    const { state, deps, events } = createFinalCheckHarness({
      tasks: [
        {
          id: 't1',
          taskKey: 'impl-a',
          role: 'implementer',
          status: 'merged',
          runMode: 'own_agent',
          attempt: 1,
        },
        {
          id: 't2',
          taskKey: 'impl-b',
          role: 'implementer',
          status: 'merged',
          runMode: 'chain',
          attempt: 1,
        },
        {
          id: 't3',
          taskKey: 'qa-1',
          role: 'qa',
          status: 'omitted',
          runMode: 'own_agent',
          attempt: 1,
        },
      ],
    });

    await onAllTasksMerged('rev-1', deps);

    expect(state.tasks.some((t) => t.taskKey === 'final-check')).toBe(false);
    expect(state.validatedCommit).toBe('a'.repeat(40));
    expect(state.runStatus).toBe('deploying');
    expect(
      events.some(
        (e) =>
          e.eventType === 'run.validated' &&
          e.detail?.skipped_single_agent === true
      )
    ).toBe(true);
  });

  it('validates the merge result passed by the merge workflow even when the branch read is stale', async () => {
    const mergedCommit = 'b'.repeat(40);
    const { state, deps, events } = createFinalCheckHarness({
      integrationHeadCommit: 'a'.repeat(40),
      tasks: [
        {
          id: 't1',
          taskKey: 'impl-a',
          role: 'implementer',
          status: 'merged',
          runMode: 'own_agent',
          attempt: 1,
        },
      ],
    });

    await onAllTasksMerged('rev-1', deps, mergedCommit);

    expect(state.validatedCommit).toBe(mergedCommit);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: 'run.validated',
          detail: expect.objectContaining({ commit: mergedCommit }),
        }),
      ])
    );
  });

  it('does not validate or enqueue a revision twice', async () => {
    const { deps, events } = createFinalCheckHarness({
      validatedCommit: 'b'.repeat(40),
      runStatus: 'deploying',
      tasks: [
        {
          id: 't1',
          taskKey: 'impl-a',
          role: 'implementer',
          status: 'merged',
          runMode: 'own_agent',
          attempt: 1,
        },
      ],
    });
    deps.markValidated = jest.fn(deps.markValidated);

    await onAllTasksMerged('rev-1', deps, 'b'.repeat(40));

    expect(deps.markValidated).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('VT-15 PBI-024 AC-0 / TBI-023 DoD-0 inserts one final-check row, sets run to checking, and is idempotent on repeat', async () => {
    const { state, deps, events, dispatchedRuns } = createFinalCheckHarness();

    await onAllTasksMerged('rev-1', deps);
    await onAllTasksMerged('rev-1', deps);

    const checkTasks = state.tasks.filter((t) => t.taskKey === 'final-check');
    expect(checkTasks).toHaveLength(1);
    expect(checkTasks[0].role).toBe('check');
    expect(checkTasks[0].dependsOn).toEqual(['impl-a', 'impl-b']);
    expect(state.runStatus).toBe('checking');
    expect(events.filter((e) => e.eventType === 'check.started')).toHaveLength(
      1
    );
    expect(dispatchedRuns).toEqual(['run-1']);
  });

  it('VT-18 PBI-024 AC-0 marks validated_commit, moves run to deploying, and marks check task merged when all checks pass without repair', async () => {
    const { state, deps, events } = createFinalCheckHarness({
      runStatus: 'checking',
      tasks: [
        {
          id: 't1',
          taskKey: 'impl-a',
          role: 'implementer',
          status: 'merged',
          runMode: 'own_agent',
          attempt: 1,
        },
        {
          id: 't2',
          taskKey: 'impl-b',
          role: 'implementer',
          status: 'merged',
          runMode: 'own_agent',
          attempt: 1,
        },
        {
          id: 'chk-1',
          taskKey: 'final-check',
          role: 'check',
          status: 'running',
          runMode: 'own_agent',
          attempt: 1,
        },
      ],
    });

    await applyFinalCheckCompletion(
      'chk-1',
      { settled: true, status: 'finished', resultText: makeReportText() },
      deps
    );

    expect(state.validatedCommit).toBe('a'.repeat(40));
    expect(state.runStatus).toBe('deploying');
    expect(state.tasks.find((t) => t.id === 'chk-1')?.status).toBe('merged');
    expect(state.repairAttempts).toBe(0);
    expect(events.map((e) => e.eventType)).toEqual(
      expect.arrayContaining(['check.passed', 'run.validated'])
    );
  });

  it('VT-19 PBI-024 AC-1 merges check branch, spends 1 repair attempt, sets validated_commit to new head, and moves to deploying when repairedInSession passes', async () => {
    const { state, deps, events, mergedTaskIds } = createFinalCheckHarness({
      runStatus: 'checking',
      repairAttempts: 0,
      tasks: [
        {
          id: 'chk-1',
          taskKey: 'final-check',
          role: 'check',
          status: 'running',
          runMode: 'own_agent',
          attempt: 1,
        },
      ],
    });

    await applyFinalCheckCompletion(
      'chk-1',
      {
        settled: true,
        status: 'finished',
        resultText: makeReportText({ repairedInSession: true }),
      },
      deps
    );

    expect(mergedTaskIds).toEqual(['chk-1']);
    expect(state.repairAttempts).toBe(1);
    expect(state.validatedCommit).toBe('c'.repeat(40));
    expect(state.runStatus).toBe('deploying');
    expect(events.map((e) => e.eventType)).toEqual(
      expect.arrayContaining(['repair.granted', 'check.passed'])
    );
  });

  it('VT-20 PBI-024 AC-1 spends 1 attempt, sets check task to ready with attempt 2, and relaunches when check fails after in-session repair with budget remaining', async () => {
    const { state, deps, dispatchedRuns } = createFinalCheckHarness({
      runStatus: 'checking',
      repairAttempts: 0,
      tasks: [
        {
          id: 'chk-1',
          taskKey: 'final-check',
          role: 'check',
          status: 'running',
          runMode: 'own_agent',
          attempt: 1,
        },
      ],
    });

    const failedReport = makeReportText({
      repairedInSession: true,
      checks: [
        {
          kind: 'unit_full',
          outcome: 'failed',
          failedTests: ['suite A'],
          summary: '1 failed',
        },
        { kind: 'unit_related', outcome: 'passed', summary: 'ok' },
      ],
    });

    await applyFinalCheckCompletion(
      'chk-1',
      { settled: true, status: 'finished', resultText: failedReport },
      deps
    );

    expect(state.repairAttempts).toBe(1);
    const chk = state.tasks.find((t) => t.id === 'chk-1')!;
    expect(chk.status).toBe('ready');
    expect(chk.attempt).toBe(2);
    expect(state.runStatus).toBe('checking');
    expect(state.validatedCommit).toBeNull();
    expect(dispatchedRuns).toEqual(['run-1']);
  });

  it('VT-21 PBI-024 AC-3 / TBI-023 DoD-2 suspends with cap_reached when repair attempts are exhausted', async () => {
    // Case A: failed, repairedInSession: true, repair_attempts = 1 -> spends 2nd attempt and suspends cap_reached
    const harnessA = createFinalCheckHarness({
      runStatus: 'checking',
      repairAttempts: 1,
      tasks: [
        {
          id: 'chk-1',
          taskKey: 'final-check',
          role: 'check',
          status: 'running',
          runMode: 'own_agent',
          attempt: 1,
        },
      ],
    });
    const failedRepaired = makeReportText({
      repairedInSession: true,
      checks: [
        { kind: 'unit_full', outcome: 'failed', summary: 'Still failing' },
        { kind: 'unit_related', outcome: 'passed', summary: 'ok' },
      ],
    });
    await applyFinalCheckCompletion(
      'chk-1',
      { settled: true, status: 'finished', resultText: failedRepaired },
      harnessA.deps
    );
    expect(harnessA.state.repairAttempts).toBe(2);
    expect(harnessA.state.runStatus).toBe('suspended');
    expect(harnessA.state.suspendReason).toBe('cap_reached');
    expect(harnessA.state.validatedCommit).toBeNull();
    expect(harnessA.state.suspensionMessage).toContain(
      'Your feature was built, but Apex could not get every check to pass after 2 repair attempts.'
    );
    expect(harnessA.state.suspensionMessage).toContain('Dana');

    // Case B: failed, repairedInSession: false, repair_attempts = 2 -> stays 2, suspends cap_reached
    const harnessB = createFinalCheckHarness({
      runStatus: 'checking',
      repairAttempts: 2,
      tasks: [
        {
          id: 'chk-1',
          taskKey: 'final-check',
          role: 'check',
          status: 'running',
          runMode: 'own_agent',
          attempt: 2,
        },
      ],
    });
    const failedUnrepaired = makeReportText({
      repairedInSession: false,
      checks: [
        { kind: 'unit_full', outcome: 'failed', summary: 'Still failing' },
        { kind: 'unit_related', outcome: 'passed', summary: 'ok' },
      ],
    });
    await applyFinalCheckCompletion(
      'chk-1',
      { settled: true, status: 'finished', resultText: failedUnrepaired },
      harnessB.deps
    );
    expect(harnessB.state.repairAttempts).toBe(2);
    expect(harnessB.state.runStatus).toBe('suspended');
    expect(harnessB.state.suspendReason).toBe('cap_reached');
    expect(harnessB.state.validatedCommit).toBeNull();
  });

  it('VT-22 PBI-024 AC-3 suspends with check_failed and spends 0 attempts when report failed with repairedInSession: false and attempts remain', async () => {
    const { state, deps, dispatchedRuns } = createFinalCheckHarness({
      runStatus: 'checking',
      repairAttempts: 0,
      tasks: [
        {
          id: 'chk-1',
          taskKey: 'final-check',
          role: 'check',
          status: 'running',
          runMode: 'own_agent',
          attempt: 1,
        },
      ],
    });
    const failedUnrepaired = makeReportText({
      repairedInSession: false,
      checks: [
        { kind: 'unit_full', outcome: 'failed', summary: 'Cannot fix' },
        { kind: 'unit_related', outcome: 'passed', summary: 'ok' },
      ],
    });

    await applyFinalCheckCompletion(
      'chk-1',
      { settled: true, status: 'finished', resultText: failedUnrepaired },
      deps
    );

    expect(state.repairAttempts).toBe(0);
    expect(state.runStatus).toBe('suspended');
    expect(state.suspendReason).toBe('check_failed');
    expect(state.suspensionMessage).toContain(
      'Your feature was built, but its final check did not pass and Apex could not repair it.'
    );
    expect(dispatchedRuns).toHaveLength(0);
  });

  it('VT-23 PBI-024 AC-3 / TBI-023 DoD-0 treats errored agent run or mismatched validatedCommit as failed check with no fix', async () => {
    // Case A: agent run errored
    const harnessA = createFinalCheckHarness({
      runStatus: 'checking',
      tasks: [
        {
          id: 'chk-1',
          taskKey: 'final-check',
          role: 'check',
          status: 'running',
          runMode: 'own_agent',
          attempt: 1,
        },
      ],
    });
    await applyFinalCheckCompletion(
      'chk-1',
      { settled: true, status: 'failed', resultText: null },
      harnessA.deps
    );
    expect(harnessA.state.runStatus).toBe('suspended');
    expect(harnessA.state.validatedCommit).toBeNull();
    expect(harnessA.events.map((e) => e.eventType)).toContain('check.failed');

    // Case B: valid passing report whose validatedCommit differs from integration head
    const harnessB = createFinalCheckHarness({
      runStatus: 'checking',
      tasks: [
        {
          id: 'chk-1',
          taskKey: 'final-check',
          role: 'check',
          status: 'running',
          runMode: 'own_agent',
          attempt: 1,
        },
      ],
    });
    await applyFinalCheckCompletion(
      'chk-1',
      {
        settled: true,
        status: 'finished',
        resultText: makeReportText({ validatedCommit: 'f'.repeat(40) }),
      },
      harnessB.deps
    );
    expect(harnessB.state.runStatus).toBe('suspended');
    expect(harnessB.state.validatedCommit).toBeNull();
    expect(harnessB.events.map((e) => e.eventType)).toContain(
      'check.report_invalid'
    );
  });

  it('VT-24 PBI-025 AC-0, AC-2, AC-3 records standards.finding events and does not block on open findings', async () => {
    const { state, deps, events } = createFinalCheckHarness({
      runStatus: 'checking',
      tasks: [
        {
          id: 'chk-1',
          taskKey: 'final-check',
          role: 'check',
          status: 'running',
          runMode: 'own_agent',
          attempt: 1,
        },
      ],
    });

    const reportWithFindings = makeReportText({
      standards: {
        status: 'reviewed',
        findings: [
          {
            rule: 'duplicate_helper',
            file: 'src/a.ts',
            line: 10,
            resolution: 'fixed',
            detail: 'Reused formatDate',
          },
          {
            rule: 'hard_coded_colour',
            file: 'src/b.css',
            line: 4,
            resolution: 'fixed',
            detail: 'Used --accent-color',
          },
          {
            rule: 'off_library_component',
            file: 'src/c.tsx',
            line: 20,
            resolution: 'exception',
            detail: 'Custom SVG',
            exceptionReason: 'No icon in library',
          },
          {
            rule: 'missing_accessibility',
            file: 'src/d.tsx',
            line: 33,
            resolution: 'open',
            detail: 'Missing aria-label',
          },
        ],
      },
    });

    await applyFinalCheckCompletion(
      'chk-1',
      { settled: true, status: 'finished', resultText: reportWithFindings },
      deps
    );

    const findingEvents = events.filter(
      (e) => e.eventType === 'standards.finding'
    );
    expect(findingEvents).toHaveLength(4);
    expect(state.runStatus).toBe('deploying');
    expect(state.validatedCommit).toBe('a'.repeat(40));
  });

  it('VT-25 PBI-025 AC-1 suspends with configuration and names the unreadable file when standards.status is unreadable_input', async () => {
    const { state, deps, events } = createFinalCheckHarness({
      runStatus: 'checking',
      tasks: [
        {
          id: 'chk-1',
          taskKey: 'final-check',
          role: 'check',
          status: 'running',
          runMode: 'own_agent',
          attempt: 1,
        },
      ],
    });

    const unreadableReport = makeReportText({
      standards: { status: 'unreadable_input', path: 'docs/design-system.md' },
    });

    await applyFinalCheckCompletion(
      'chk-1',
      { settled: true, status: 'finished', resultText: unreadableReport },
      deps
    );

    expect(state.runStatus).toBe('suspended');
    expect(state.suspendReason).toBe('configuration');
    expect(state.suspensionMessage).toContain('docs/design-system.md');
    expect(state.suspensionMessage).toContain('Dana');
    expect(state.repairAttempts).toBe(0);
    expect(state.validatedCommit).toBeNull();
    expect(events.map((e) => e.eventType)).toContain(
      'standards.unreadable_input'
    );
  });

  it('VT-27 PBI-024 NFR-sec / PBI-025 NFR-sec redacts bearer tokens and connection strings from events and evidence', async () => {
    const { state, deps, events, evidenceBlobs } = createFinalCheckHarness({
      runStatus: 'checking',
      tasks: [
        {
          id: 'chk-1',
          taskKey: 'final-check',
          role: 'check',
          status: 'running',
          runMode: 'own_agent',
          attempt: 1,
        },
      ],
    });

    const reportWithSecrets = makeReportText({
      checks: [
        {
          kind: 'unit_full',
          outcome: 'failed',
          failedTests: ['test with Bearer superSecretBearer12345'],
          summary:
            'Failed connecting to postgres://admin:secretPass@db.internal:5432/app',
        },
        { kind: 'unit_related', outcome: 'passed', summary: 'ok' },
      ],
      summary: 'Summary with Bearer superSecretBearer12345',
    });

    await applyFinalCheckCompletion(
      'chk-1',
      { settled: true, status: 'finished', resultText: reportWithSecrets },
      deps
    );

    const allEventsText = JSON.stringify(events);
    expect(allEventsText).not.toContain('superSecretBearer12345');
    expect(allEventsText).not.toContain('secretPass');
    expect(evidenceBlobs[0]).not.toContain('superSecretBearer12345');
    expect(evidenceBlobs[0]).not.toContain('secretPass');
    expect(state.suspensionMessage).not.toContain('superSecretBearer12345');
  });

  it('VT-28 TBI-023 NFR / PBI-024 AC-0..1 is idempotent when applyFinalCheckCompletion is called twice', async () => {
    const { state, deps, events } = createFinalCheckHarness({
      runStatus: 'checking',
      tasks: [
        {
          id: 'chk-1',
          taskKey: 'final-check',
          role: 'check',
          status: 'running',
          runMode: 'own_agent',
          attempt: 1,
        },
      ],
    });

    const obs = {
      settled: true,
      status: 'finished' as const,
      resultText: makeReportText({ repairedInSession: true }),
    };

    await applyFinalCheckCompletion('chk-1', obs, deps);
    const eventsCountAfterFirst = events.length;
    await applyFinalCheckCompletion('chk-1', obs, deps);

    expect(state.repairAttempts).toBe(1);
    expect(events).toHaveLength(eventsCountAfterFirst);
  });
});
