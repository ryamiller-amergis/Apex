/**
 * S6 — Verification evidence recorder unit tests (`VT-17`, `VT-18`).
 * Owning items: TBI-021, PBI-022.
 */
import type {
  BuildEvent,
  BuildQualityManifestSnapshot,
  BuildRequirement,
  BuildRiskDecision,
  BuildTaskStatus,
  BuildVerificationRow,
} from '../../shared/types/build';
import type { AppendBuildEventInput } from '../services/buildEventsService';
import {
  buildEvidenceBlobPrefix,
  createInMemoryEvidenceStore,
} from '../services/builds/buildEvidenceStore';
import {
  recordTaskEvidence,
  resolveTaskOwnedSpecs,
  type RecordTaskEvidenceDeps,
  type VerificationRecorderStore,
} from '../services/builds/verificationEvidenceRecorder';

const RUN_ID = '00000000-0000-4000-8000-000000000001';
const REV_ID = '00000000-0000-4000-8000-000000000002';
const TASK_ID = '00000000-0000-4000-8000-000000000003';
const AGENT_RUN_ID = '00000000-0000-4000-8000-000000000004';

const DEFAULT_MANIFEST: BuildQualityManifestSnapshot = {
  typeCheck: 'npx tsc -p tsconfig.server.json --noEmit',
  lint: 'npx eslint src --ext .ts,.tsx',
  relatedTests: 'npx jest --findRelatedTests {files}',
  unitSuite: 'npx jest --selectProjects server',
};

class InMemoryRecorderStore implements VerificationRecorderStore {
  task = {
    id: TASK_ID,
    buildRevisionId: REV_ID,
    taskKey: 't-impl-1',
    role: 'implementer' as const,
    status: 'running' as BuildTaskStatus,
    attempt: 1,
    ownedFiles: [] as string[],
    covers: [] as string[],
  };

  revision = {
    id: REV_ID,
    buildRunId: RUN_ID,
    revisionNumber: 1,
    classification: 'small' as 'small' | 'full' | null,
    requirements: [
      {
        id: 'AC-1',
        kind: 'ac',
        text: 'Users can submit a request',
        retired: false,
      },
      { id: 'NFR-1', kind: 'nfr', text: 'Responds under 1s', retired: false },
    ] as BuildRequirement[],
    riskDecisions: [
      {
        id: 'RD-1',
        category: 'data',
        rating: 'low',
        decision: 'Soft delete rows',
        rationale: 'Reversible',
      },
    ] as BuildRiskDecision[],
    plan: null as unknown,
  };

  run = {
    id: RUN_ID,
    qualityManifestSnapshot: DEFAULT_MANIFEST,
  };

  rows = new Map<
    string,
    Omit<BuildVerificationRow, 'id' | 'createdAt' | 'updatedAt'>
  >();
  events: BuildEvent[] = [];
  upsertCalls = 0;

  async loadContext(buildTaskId: string) {
    if (buildTaskId !== this.task.id) return null;
    return {
      task: {
        ...this.task,
        ownedFiles: [...this.task.ownedFiles],
        covers: [...this.task.covers],
      },
      revision: {
        ...this.revision,
        requirements: [...this.revision.requirements],
        riskDecisions: [...this.revision.riskDecisions],
      },
      run: { ...this.run },
    };
  }

  async commitTransaction(input: {
    buildTaskId: string;
    attemptNumber: number;
    buildRunId: string;
    buildRevisionId: string;
    rows: Array<
      Omit<
        BuildVerificationRow,
        'id' | 'createdAt' | 'updatedAt' | 'carriedFromRevisionNumber'
      >
    >;
    events: AppendBuildEventInput[];
  }): Promise<{ stale: boolean }> {
    if (
      input.buildTaskId !== this.task.id ||
      this.task.attempt !== input.attemptNumber
    ) {
      return { stale: true };
    }

    for (const row of input.rows) {
      this.upsertCalls += 1;
      const key = `${row.buildRevisionId}:${row.requirementId}`;
      this.rows.set(key, {
        ...row,
        carriedFromRevisionNumber: null,
      });
    }

    for (const ev of input.events) {
      if (
        ev.dedupeKey &&
        this.events.some(
          (existing) =>
            existing.buildRunId === ev.buildRunId &&
            existing.dedupeKey === ev.dedupeKey
        )
      ) {
        continue;
      }
      this.events.push({
        id: `ev-${this.events.length + 1}`,
        ordinal: this.events.length + 1,
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
  }
}

function buildMessageWithBlock(block: Record<string, unknown>): string {
  return [
    'Implemented the requested feature with red-green commits.',
    '```apex-evidence',
    JSON.stringify(block, null, 2),
    '```',
  ].join('\n');
}

describe('verificationEvidenceRecorder.recordTaskEvidence (S6)', () => {
  it('VT-17: redacts bearer tokens, connection strings, and known secrets from Blob bodies and every row text field while preserving ordinary text', async () => {
    const store = new InMemoryRecorderStore();
    const evidenceStore = createInMemoryEvidenceStore('ai-run-artifacts');
    const knownSecret = 'super-secret-known-value-9999';
    const bearerToken = 'Bearer eyJhbGciOiJIUzI1NiJ9_secret_token_value';
    const connString =
      'postgres://admin:topsecretpass@db.internal:5432/apexprod';
    const logLines: string[] = [];

    const deps: RecordTaskEvidenceDeps = {
      store,
      evidenceStore,
      knownSecrets: () => [knownSecret],
      now: () => '2026-11-03T12:00:00.000Z',
      log: (line) => logLines.push(line),
    };

    const testNameAc1 = `AC-1: submits request with ordinary text (${bearerToken})`;
    const testNameNfr1 = `NFR-1: latency check (${knownSecret})`;
    const testNameRd1 = `RD-1: soft delete (${connString})`;

    const block = {
      version: 1,
      taskKey: 't-impl-1',
      attemptNumber: 1,
      entries: [
        {
          requirementId: 'AC-1',
          tier: 'unit',
          testReferences: [
            { file: 'src/server/__tests__/ac1.test.ts', name: testNameAc1 },
          ],
          red: {
            commit: 'a111111',
            command: `npx jest src/server/__tests__/ac1.test.ts --env=${connString}`,
            exitCode: 1,
            failedTests: [testNameAc1],
            output: `FAIL ordinary red output with ${bearerToken} and ${connString} and ${knownSecret}`,
          },
          green: {
            commit: 'b222222',
            command: `npx jest src/server/__tests__/ac1.test.ts --token="${bearerToken}"`,
            exitCode: 0,
            passedTests: [testNameAc1],
            output: `PASS ordinary green output with ${bearerToken} and ${connString} and ${knownSecret}`,
          },
          deferral: null,
        },
        {
          requirementId: 'NFR-1',
          tier: 'e2e',
          testReferences: [
            { file: 'tests/e2e/nfr1.spec.ts', name: testNameNfr1 },
          ],
          red: null,
          green: null,
          deferral: {
            reason: `Deferred in unit sandbox; DSN was ${connString} and secret ${knownSecret} with ${bearerToken}`,
          },
        },
        {
          requirementId: 'RD-1',
          tier: 'unit',
          testReferences: [
            { file: 'src/server/__tests__/rd1.test.ts', name: testNameRd1 },
          ],
          red: {
            commit: 'c333333',
            command: `npx jest src/server/__tests__/rd1.test.ts`,
            exitCode: 1,
            failedTests: [testNameRd1],
            output: `FAIL RD-1 check with ${knownSecret}`,
          },
          green: {
            commit: 'd444444',
            command: `npx jest src/server/__tests__/rd1.test.ts`,
            exitCode: 0,
            passedTests: [testNameRd1],
            output: `PASS RD-1 check with ${bearerToken}`,
          },
          deferral: null,
        },
      ],
      checks: {
        typeCheck: { command: DEFAULT_MANIFEST.typeCheck, exitCode: 0 },
        lint: { command: DEFAULT_MANIFEST.lint, exitCode: 0 },
        relatedTests: {
          command:
            'npx jest --findRelatedTests src/server/__tests__/ac1.test.ts',
          exitCode: 0,
        },
      },
      standardsReview: { completed: true, findings: [] },
      escalation: null,
    };

    const result = await recordTaskEvidence(
      {
        buildTaskId: TASK_ID,
        attemptNumber: 1,
        message: buildMessageWithBlock(block),
        agentRunId: AGENT_RUN_ID,
      },
      deps
    );

    expect(result).toEqual({
      stale: false,
      outcome: 'done',
      mayReportDone: true,
      violations: [],
      escalation: null,
    });

    const ac1Prefix = buildEvidenceBlobPrefix(RUN_ID, 1, 'AC-1');
    const redBlob = evidenceStore.getText(ac1Prefix, 'red');
    const greenBlob = evidenceStore.getText(ac1Prefix, 'green');

    expect(redBlob).not.toBeNull();
    expect(greenBlob).not.toBeNull();
    expect(redBlob).toContain('FAIL ordinary red output with');
    expect(greenBlob).toContain('PASS ordinary green output with');

    for (const secret of [
      knownSecret,
      bearerToken,
      connString,
      'topsecretpass',
    ]) {
      expect(redBlob).not.toContain(secret);
      expect(greenBlob).not.toContain(secret);
    }

    const serializedRows = JSON.stringify([...store.rows.values()]);
    for (const secret of [
      knownSecret,
      bearerToken,
      connString,
      'topsecretpass',
    ]) {
      expect(serializedRows).not.toContain(secret);
    }

    const ac1Row = store.rows.get(`${REV_ID}:AC-1`)!;
    expect(ac1Row.testRefs[0].name).toContain(
      'AC-1: submits request with ordinary text'
    );
    expect(ac1Row.redEvidence?.command).toContain(
      'npx jest src/server/__tests__/ac1.test.ts'
    );
    expect(ac1Row.greenEvidence?.command).toContain(
      'npx jest src/server/__tests__/ac1.test.ts'
    );

    const nfr1Row = store.rows.get(`${REV_ID}:NFR-1`)!;
    expect(nfr1Row.status).toBe('deferred');
    expect(nfr1Row.deferralReason).toContain(
      'Deferred in unit sandbox; DSN was'
    );

    // Structured log never contains output text or secrets
    expect(logLines).toHaveLength(1);
    expect(logLines[0]).toContain('[build-verification]');
    expect(logLines[0]).not.toContain(knownSecret);
    expect(logLines[0]).not.toContain('ordinary red output');
  });

  it('VT-18: applying the same block twice produces one row set, the same Blob keys, and one verification.recorded event; a stale attempt returns stale: true and writes nothing', async () => {
    const store = new InMemoryRecorderStore();
    store.revision.requirements = [
      {
        id: 'AC-1',
        kind: 'ac',
        text: 'Users can submit a request',
        retired: false,
      },
    ];
    store.revision.riskDecisions = [];

    const evidenceStore = createInMemoryEvidenceStore('ai-run-artifacts');
    const putEvidenceSpy = jest.spyOn(evidenceStore, 'putEvidence');

    const deps: RecordTaskEvidenceDeps = {
      store,
      evidenceStore,
      now: () => '2026-11-03T12:00:00.000Z',
      log: () => undefined,
    };

    const testName = 'AC-1: submits request';
    const message = buildMessageWithBlock({
      version: 1,
      taskKey: 't-impl-1',
      attemptNumber: 1,
      entries: [
        {
          requirementId: 'AC-1',
          tier: 'unit',
          testReferences: [
            { file: 'src/server/__tests__/ac1.test.ts', name: testName },
          ],
          red: {
            commit: 'red-111',
            command: 'npx jest src/server/__tests__/ac1.test.ts',
            exitCode: 1,
            failedTests: [testName],
            output: 'FAIL src/server/__tests__/ac1.test.ts',
          },
          green: {
            commit: 'green-222',
            command: 'npx jest src/server/__tests__/ac1.test.ts',
            exitCode: 0,
            passedTests: [testName],
            output: 'PASS src/server/__tests__/ac1.test.ts',
          },
          deferral: null,
        },
      ],
      checks: {
        typeCheck: { command: DEFAULT_MANIFEST.typeCheck, exitCode: 0 },
        lint: { command: DEFAULT_MANIFEST.lint, exitCode: 0 },
        relatedTests: {
          command:
            'npx jest --findRelatedTests src/server/__tests__/ac1.test.ts',
          exitCode: 0,
        },
      },
      standardsReview: { completed: true, findings: [] },
      escalation: null,
    });

    const first = await recordTaskEvidence(
      {
        buildTaskId: TASK_ID,
        attemptNumber: 1,
        message,
        agentRunId: AGENT_RUN_ID,
      },
      deps
    );
    const blobKeysAfterFirst = [...evidenceStore.blobs.keys()].sort();

    const second = await recordTaskEvidence(
      {
        buildTaskId: TASK_ID,
        attemptNumber: 1,
        message,
        agentRunId: AGENT_RUN_ID,
      },
      deps
    );
    const blobKeysAfterSecond = [...evidenceStore.blobs.keys()].sort();

    expect(first).toMatchObject({
      stale: false,
      outcome: 'done',
      mayReportDone: true,
    });
    expect(second).toMatchObject({
      stale: false,
      outcome: 'done',
      mayReportDone: true,
    });

    // One row set and identical Blob keys
    expect(store.rows.size).toBe(1);
    expect(blobKeysAfterSecond).toEqual(blobKeysAfterFirst);

    // Only one verification.recorded event (and one verification.standards_review event)
    const recordedEvents = store.events.filter(
      (e) => e.eventType === 'verification.recorded'
    );
    expect(recordedEvents).toHaveLength(1);
    expect(recordedEvents[0].correlationKind).toBe('agent_run');
    expect(recordedEvents[0].correlationId).toBe(AGENT_RUN_ID);

    // Advance task attempt to 2 and call with stale attemptNumber: 1
    store.task.attempt = 2;
    putEvidenceSpy.mockClear();
    const upsertCallsBeforeStale = store.upsertCalls;
    const eventsBeforeStale = store.events.length;

    const staleResult = await recordTaskEvidence(
      {
        buildTaskId: TASK_ID,
        attemptNumber: 1,
        message,
        agentRunId: AGENT_RUN_ID,
      },
      deps
    );

    expect(staleResult).toEqual({ stale: true });
    expect(putEvidenceSpy).not.toHaveBeenCalled();
    expect(store.upsertCalls).toBe(upsertCallsBeforeStale);
    expect(store.events).toHaveLength(eventsBeforeStale);
  });

  it('reports a block that fails to parse as unreadable, and a missing block as missing entries', async () => {
    const run = async (message: string) => {
      const store = new InMemoryRecorderStore();
      store.revision.requirements = [
        { id: 'AC-1', kind: 'ac', text: 'Users can submit a request', retired: false },
      ];
      store.revision.riskDecisions = [];
      const result = await recordTaskEvidence(
        { buildTaskId: TASK_ID, attemptNumber: 1, message, agentRunId: AGENT_RUN_ID },
        {
          store,
          evidenceStore: createInMemoryEvidenceStore('ai-run-artifacts'),
          now: () => '2026-11-03T12:00:00.000Z',
          log: () => undefined,
        }
      );
      return { result, store };
    };

    const broken = await run('```apex-evidence\n{not json}\n```');
    expect(broken.result).toMatchObject({ stale: false, outcome: 'refused' });
    if (!broken.result.stale) {
      expect(broken.result.violations).toEqual([
        { code: 'unreadable_evidence_block', requirementId: null },
      ]);
    }
    expect(
      broken.store.events.find((e) => e.eventType === 'verification.refused')?.message
    ).toBe('The test report could not be read (invalid_json).');

    const absent = await run('All done.');
    if (!absent.result.stale) {
      expect(absent.result.violations).toEqual([
        { code: 'missing_evidence_entry', requirementId: 'AC-1' },
      ]);
    }
  });

  it('limits a small revision task to its explicit changed requirement IDs', async () => {
    const store = new InMemoryRecorderStore();
    store.task.covers = ['AC-1'];
    store.revision.classification = 'small';
    const context = await store.loadContext(TASK_ID);

    const ownership = resolveTaskOwnedSpecs(context!);
    expect(ownership.ownedIds).toEqual([
      { id: 'AC-1', kind: 'ac', retired: false },
    ]);
    expect(ownership.ownedFiles).toBeNull();
  });
});
