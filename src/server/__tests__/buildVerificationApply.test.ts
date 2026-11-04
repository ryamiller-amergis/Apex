/**
 * S8 — Apply-completion verification wiring tests (`VT-26`, `VT-27`, `VT-28`, `PBI-022 AC-2`).
 * Owning items: PBI-022.
 */
import type {
  BuildEvent,
  BuildQualityManifestSnapshot,
  BuildRequirement,
  BuildRiskDecision,
  BuildTaskStatus,
  BuildVerificationRow,
} from '../../shared/types/build';
import { createInMemoryEvidenceStore } from '../services/builds/buildEvidenceStore';
import {
  applyTaskVerificationCompletion,
  type BuildVerificationApplyDeps,
} from '../services/builds/buildVerificationApply';
import type { RepairAttemptPort } from '../services/builds/ports';
import type { VerificationRecorderStore } from '../services/builds/verificationEvidenceRecorder';

const RUN_ID = '00000000-0000-4000-8000-000000000011';
const REV_ID = '00000000-0000-4000-8000-000000000012';
const TASK_ID = '00000000-0000-4000-8000-000000000013';
const AGENT_RUN_ID = '00000000-0000-4000-8000-000000000014';

const DEFAULT_MANIFEST: BuildQualityManifestSnapshot = {
  typeCheck: 'npx tsc -p tsconfig.server.json --noEmit',
  lint: 'npx eslint src --ext .ts,.tsx',
  relatedTests: 'npx jest --findRelatedTests {files}',
  unitSuite: 'npx jest --selectProjects server',
};

function makeHarness() {
  const task = {
    id: TASK_ID,
    buildRevisionId: REV_ID,
    taskKey: 't-impl-1',
    role: 'implementer' as const,
    status: 'running' as BuildTaskStatus,
    attempt: 1,
    ownedFiles: [] as string[],
    covers: [] as string[],
  };

  const revision = {
    id: REV_ID,
    buildRunId: RUN_ID,
    revisionNumber: 1,
    classification: 'small' as 'small' | 'full' | null,
    requirements: [
      { id: 'AC-1', kind: 'ac', text: 'Users can submit a request', retired: false },
      { id: 'AC-2', kind: 'ac', text: 'Empty title is rejected', retired: false },
    ] as BuildRequirement[],
    riskDecisions: [] as BuildRiskDecision[],
    plan: null as unknown,
  };

  const run = {
    id: RUN_ID,
    qualityManifestSnapshot: DEFAULT_MANIFEST,
  };

  const rows = new Map<string, Omit<BuildVerificationRow, 'id' | 'createdAt' | 'updatedAt'>>();
  const events: BuildEvent[] = [];

  const recorderStore: VerificationRecorderStore = {
    async loadContext(buildTaskId: string) {
      if (buildTaskId !== task.id) return null;
      return {
        task: { ...task, ownedFiles: [...task.ownedFiles], covers: [...task.covers] },
        revision: {
          ...revision,
          requirements: [...revision.requirements],
          riskDecisions: [...revision.riskDecisions],
        },
        run: { ...run },
      };
    },
    async commitTransaction(input) {
      if (input.buildTaskId !== task.id || task.attempt !== input.attemptNumber) {
        return { stale: true };
      }
      for (const row of input.rows) {
        rows.set(`${row.buildRevisionId}:${row.requirementId}`, {
          ...row,
          carriedFromRevisionNumber: null,
        });
      }
      for (const ev of input.events) {
        if (
          ev.dedupeKey &&
          events.some((e) => e.buildRunId === ev.buildRunId && e.dedupeKey === ev.dedupeKey)
        ) {
          continue;
        }
        events.push({
          id: `ev-${events.length + 1}`,
          ordinal: events.length + 1,
          buildRunId: ev.buildRunId,
          buildRevisionId: ev.buildRevisionId ?? null,
          eventType: ev.eventType,
          severity: ev.severity ?? 'info',
          message: ev.message,
          detail: ev.detail ?? null,
          correlationKind: ev.correlation?.kind ?? null,
          correlationId: ev.correlation?.id ?? null,
          actorUserId: ev.actorUserId ?? null,
          dedupeKey: ev.dedupeKey ?? null,
          createdAt: '2026-11-03T12:00:00.000Z',
        });
      }
      return { stale: false };
    },
  };

  let repairsUsed = 0;
  const consumeSpy = jest.fn(async (_revisionId: string) => {
    if (repairsUsed >= 2) {
      return { consumed: false, remaining: 0 };
    }
    repairsUsed += 1;
    return { consumed: true, remaining: 2 - repairsUsed };
  });
  const repairAttemptPort: RepairAttemptPort = {
    consume: consumeSpy,
  };

  const escalateToFullPath = jest.fn(
    async (_input: {
      buildRunId: string;
      revisionId: string;
      taskId: string;
      reason: string;
      planPath: string;
    }) => {
      revision.classification = 'full';
    },
  );

  const evidenceStore = createInMemoryEvidenceStore('ai-run-artifacts');

  const deps: BuildVerificationApplyDeps = {
    recorderDeps: {
      store: recorderStore,
      evidenceStore,
      now: () => '2026-11-03T12:00:00.000Z',
      log: () => undefined,
    },
    repairAttemptPort,
    updateTaskStatus: async (taskId, status) => {
      if (taskId === task.id) {
        task.status = status;
      }
    },
    escalateToFullPath,
  };

  return {
    task,
    revision,
    run,
    rows,
    events,
    consumeSpy,
    escalateToFullPath,
    evidenceStore,
    deps,
  };
}

function makeEntry(requirementId: string, options?: { omitRed?: boolean; omitGreen?: boolean }) {
  const testName = `${requirementId}: meets the criterion`;
  const testFile = `src/server/__tests__/${requirementId.toLowerCase()}.test.ts`;
  return {
    requirementId,
    tier: 'unit',
    testReferences: [{ file: testFile, name: testName }],
    red: options?.omitRed
      ? null
      : {
          commit: `red-${requirementId.toLowerCase()}`,
          command: `npx jest ${testFile}`,
          exitCode: 1,
          failedTests: [testName],
          output: `FAIL ${testFile} raw failure output that must never enter relaunch envelope`,
        },
    green: options?.omitGreen
      ? null
      : {
          commit: `green-${requirementId.toLowerCase()}`,
          command: `npx jest ${testFile}`,
          exitCode: 0,
          passedTests: [testName],
          output: `PASS ${testFile} raw passing output that must never enter relaunch envelope`,
        },
    deferral: null,
  };
}

function wrapBlock(block: Record<string, unknown>): string {
  return ['Done.', '```apex-evidence', JSON.stringify(block, null, 2), '```'].join('\n');
}

describe('buildVerificationApply.applyTaskVerificationCompletion (S8)', () => {
  it('VT-26: marks the task failed, calls RepairAttemptPort.consume once, and builds a relaunch envelope with violation codes and no output text when the block is refused (VT-07 shape)', async () => {
    const h = makeHarness();

    const message = wrapBlock({
      version: 1,
      taskKey: 't-impl-1',
      attemptNumber: 1,
      entries: [makeEntry('AC-1'), makeEntry('AC-2', { omitRed: true })],
      checks: {
        typeCheck: { command: DEFAULT_MANIFEST.typeCheck, exitCode: 0 },
        lint: { command: DEFAULT_MANIFEST.lint, exitCode: 0 },
        relatedTests: {
          command: 'npx jest --findRelatedTests src/server/__tests__/ac-1.test.ts',
          exitCode: 0,
        },
      },
      standardsReview: { completed: true, findings: [] },
      escalation: null,
    });

    const result = await applyTaskVerificationCompletion(
      {
        buildTaskId: TASK_ID,
        attemptNumber: 1,
        agentRunId: AGENT_RUN_ID,
        message,
      },
      h.deps,
    );

    expect(result.outcome).toBe('refused');
    expect(result.mayReportDone).toBe(false);
    expect(h.task.status).toBe('failed');
    expect(h.consumeSpy).toHaveBeenCalledTimes(1);
    expect(h.consumeSpy).toHaveBeenCalledWith(REV_ID);

    expect(result.relaunchEnvelope).toEqual({
      taskKey: 't-impl-1',
      attemptNumber: 2,
      violations: [{ code: 'missing_red_evidence', requirementId: 'AC-2' }],
    });

    const serializedEnvelope = JSON.stringify(result.relaunchEnvelope);
    expect(serializedEnvelope).not.toContain('raw failure output');
    expect(serializedEnvelope).not.toContain('raw passing output');
  });

  it('VT-27: marks the task done and calls RepairAttemptPort.consume zero times when the agent fixes a related-test break in-session and reports final passing runs', async () => {
    const h = makeHarness();

    const message = wrapBlock({
      version: 1,
      taskKey: 't-impl-1',
      attemptNumber: 1,
      entries: [makeEntry('AC-1'), makeEntry('AC-2')],
      checks: {
        typeCheck: { command: DEFAULT_MANIFEST.typeCheck, exitCode: 0 },
        lint: { command: DEFAULT_MANIFEST.lint, exitCode: 0 },
        relatedTests: {
          command:
            'npx jest --findRelatedTests src/server/services/feature.ts src/server/__tests__/related.test.ts',
          exitCode: 0,
        },
      },
      standardsReview: {
        completed: true,
        findings: ['Fixed broken related test in-session before reporting final checks'],
      },
      escalation: null,
    });

    const result = await applyTaskVerificationCompletion(
      {
        buildTaskId: TASK_ID,
        attemptNumber: 1,
        agentRunId: AGENT_RUN_ID,
        message,
      },
      h.deps,
    );

    expect(result.outcome).toBe('done');
    expect(result.mayReportDone).toBe(true);
    expect(result.relaunchEnvelope).toBeNull();
    expect(h.task.status).toBe('merged');
    expect(h.consumeSpy).toHaveBeenCalledTimes(0);
  });

  it('VT-28: a small build with one agent run and a valid block marks all rows pass, marks the task done, and records one verification.recorded event with the agent run ID as correlation ID', async () => {
    const h = makeHarness();

    const message = wrapBlock({
      version: 1,
      taskKey: 't-impl-1',
      attemptNumber: 1,
      entries: [makeEntry('AC-1'), makeEntry('AC-2')],
      checks: {
        typeCheck: { command: DEFAULT_MANIFEST.typeCheck, exitCode: 0 },
        lint: { command: DEFAULT_MANIFEST.lint, exitCode: 0 },
        relatedTests: {
          command: 'npx jest --findRelatedTests src/server/__tests__/ac-1.test.ts',
          exitCode: 0,
        },
      },
      standardsReview: { completed: true, findings: [] },
      escalation: null,
    });

    const result = await applyTaskVerificationCompletion(
      {
        buildTaskId: TASK_ID,
        attemptNumber: 1,
        agentRunId: AGENT_RUN_ID,
        message,
      },
      h.deps,
    );

    expect(result.outcome).toBe('done');
    expect(result.mayReportDone).toBe(true);
    expect(h.task.status).toBe('merged');
    expect(h.consumeSpy).not.toHaveBeenCalled();

    const ac1Row = h.rows.get(`${REV_ID}:AC-1`);
    const ac2Row = h.rows.get(`${REV_ID}:AC-2`);
    expect(ac1Row?.status).toBe('pass');
    expect(ac2Row?.status).toBe('pass');

    const recordedEvents = h.events.filter((e) => e.eventType === 'verification.recorded');
    expect(recordedEvents).toHaveLength(1);
    expect(recordedEvents[0].correlationKind).toBe('agent_run');
    expect(recordedEvents[0].correlationId).toBe(AGENT_RUN_ID);
  });

  it('PBI-022 AC-2: an escalation block keeps the committed red rows, calls consume zero times, and switches the revision to full path', async () => {
    const h = makeHarness();

    const message = wrapBlock({
      version: 1,
      taskKey: 't-impl-1',
      attemptNumber: 1,
      entries: [makeEntry('AC-1', { omitGreen: true }), makeEntry('AC-2', { omitGreen: true })],
      checks: {
        typeCheck: null,
        lint: null,
        relatedTests: null,
      },
      standardsReview: null,
      escalation: {
        reason: 'Work spans 4 modules and requires a full multi-task plan',
        planPath: '.apex/build/run-11/plan.json',
      },
    });

    const result = await applyTaskVerificationCompletion(
      {
        buildTaskId: TASK_ID,
        attemptNumber: 1,
        agentRunId: AGENT_RUN_ID,
        message,
      },
      h.deps,
    );

    expect(result.outcome).toBe('escalate');
    expect(result.mayReportDone).toBe(false);
    expect(result.relaunchEnvelope).toBeNull();
    expect(h.consumeSpy).toHaveBeenCalledTimes(0);

    // Red evidence rows are preserved as fail rows
    const ac1Row = h.rows.get(`${REV_ID}:AC-1`);
    const ac2Row = h.rows.get(`${REV_ID}:AC-2`);
    expect(ac1Row?.status).toBe('fail');
    expect(ac1Row?.redEvidence?.commit).toBe('red-ac-1');
    expect(ac1Row?.greenEvidence).toBeNull();
    expect(ac2Row?.status).toBe('fail');
    expect(ac2Row?.redEvidence?.commit).toBe('red-ac-2');
    expect(ac2Row?.greenEvidence).toBeNull();

    // Escalation handler was called and switched revision to full
    expect(h.escalateToFullPath).toHaveBeenCalledWith({
      buildRunId: RUN_ID,
      revisionId: REV_ID,
      taskId: TASK_ID,
      reason: 'Work spans 4 modules and requires a full multi-task plan',
      planPath: '.apex/build/run-11/plan.json',
    });
    expect(h.revision.classification).toBe('full');
  });
});
