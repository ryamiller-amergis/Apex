import { createHash } from 'crypto';
import type { BuildLaunchSnapshot } from '../../shared/types/buildLaunchSnapshot';

interface FakeRow {
  id: string;
  status: string;
  lane: string;
  projectId: string;
  workflowClass: string | null;
  buildTaskId: string | null;
  ownerInstance: string | null;
  cloudAgentIdentity: string | null;
  dispatchMessageId: string | null;
  executionSnapshot: Record<string, unknown>;
  buildLaunchSnapshot: BuildLaunchSnapshot | null;
  detail?: string;
}

const rows = new Map<string, FakeRow>();
let focusRunId = '';
const mockEnqueue = jest.fn();
const mockCapture = jest.fn();
const mockMarkTerminal = jest.fn();
const mockLaunch = jest.fn();
const mockCancel = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      agentRuns: { findFirst: jest.fn(async () => rows.get(focusRunId)) },
    },
    transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const inserted: string[] = [];
      const tx = {
        inserted,
        update: () => ({
          set: (values: Partial<FakeRow>) => ({
            where: () => ({
              returning: async () => {
                const row = rows.get(inserted[inserted.length - 1]);
                if (!row || row.buildLaunchSnapshot) return [];
                Object.assign(row, values);
                return [{ id: row.id }];
              },
            }),
          }),
        }),
      };
      try {
        return await fn(tx);
      } catch (err) {
        for (const id of inserted) rows.delete(id);
        throw err;
      }
    }),
  },
}));
jest.mock('../services/agentRunLifecycleService', () => ({
  enqueue: (...args: unknown[]) => mockEnqueue(...args),
  captureCloudAgentIdentity: (...args: unknown[]) => mockCapture(...args),
  markTerminal: (...args: unknown[]) => mockMarkTerminal(...args),
}));
jest.mock('../services/cursorCloudAgentClient', () => ({
  launchCloudAgent: (...args: unknown[]) => mockLaunch(...args),
  cancelCursorCloudAgentRun: (...args: unknown[]) => mockCancel(...args),
}));
jest.mock('../services/telemetry', () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));
jest.mock('../services/cloudAgentQueue', () => ({
  resolveCloudAgentRunLimitMs: () => 7_200_000,
}));

import {
  launchBuildAgentRun,
  readBuildPromptBlob,
  writeBuildLaunchSnapshot,
  type BuildAgentLaunchDeps,
} from '../services/buildAgentLaunchService';
import { createSecretValueDetector } from '../services/buildExecutionSnapshot';

const HELD = 'held-secret-value-123';
const PROMPT = 'Implement task t1 with tests first.';
const TASK_ID = '33333333-3333-4333-8333-333333333333';
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

function snapshot(overrides: Partial<BuildLaunchSnapshot> = {}): BuildLaunchSnapshot {
  const hash = 'b'.repeat(64);
  return {
    schemaVersion: 1,
    buildRunId: '11111111-1111-4111-8111-111111111111',
    buildRevisionId: '22222222-2222-4222-8222-222222222222',
    buildTaskId: TASK_ID,
    taskKey: 't1',
    role: 'implementer',
    attempt: 1,
    model: 'composer-2.5',
    skill: { path: '.cursor/skills/build-implementer/SKILL.md', contentHash: hash },
    standards: {
      designSystem: { path: '.cursor/skills/design-system/SKILL.md', contentHash: hash },
      codingRules: { path: '.cursor/rules/react-coding-standards.mdc', contentHash: hash },
      codeMap: { path: '.cursor/CODEMAP.md', contentHash: hash },
    },
    prompt: { container: 'cursor-prompts', key: 'builds/run-1/t1/1/prompt.txt', contentHash: sha256(PROMPT) },
    context: [{ container: 'cursor-prompts', key: 'builds/run-1/brief.md', contentHash: hash, label: 'brief' }],
    repository: { provider: 'ado', project: 'MaxView', repo: 'MaxView', defaultBranch: 'main' },
    startingBranch: 'build/run-1',
    targetBranch: 'build/run-1/t1',
    pullRequest: { open: false },
    caps: { costUsd: 25, elapsedMs: 3_600_000, revisions: 3, parallelism: 3 },
    secretRefs: ['app-setting:CURSOR_USER_LEVEL_API_KEY'],
    ...overrides,
  };
}

function deps(prompt = PROMPT): BuildAgentLaunchDeps {
  return {
    detector: createSecretValueDetector([HELD]),
    readBlobText: jest.fn(async () => prompt),
  };
}

function queuedBuildRow(id: string, buildLaunchSnapshot: BuildLaunchSnapshot | null): FakeRow {
  const row: FakeRow = {
    id,
    status: 'queued',
    lane: 'cloud-agent',
    projectId: 'MaxView',
    workflowClass: 'build-task',
    buildTaskId: TASK_ID,
    ownerInstance: 'apex-build-agent',
    cloudAgentIdentity: null,
    dispatchMessageId: null,
    executionSnapshot: { prompt: `build-task:${TASK_ID}`, model: 'composer-2.5' },
    buildLaunchSnapshot,
  };
  rows.set(id, row);
  focusRunId = id;
  return row;
}

beforeEach(() => {
  rows.clear();
  focusRunId = '';
  jest.clearAllMocks();
  mockEnqueue.mockImplementation(async (input: {
    runId?: string;
    buildTaskId: string;
    projectId: string;
    lane: string;
    ownerInstance: string;
    workflowClass: string;
    snapshot: Record<string, unknown>;
    executor: { inserted: string[] };
  }) => {
    const live = [...rows.values()].some((row) => (
      row.buildTaskId === input.buildTaskId && ['queued', 'dispatched', 'running'].includes(row.status)
    ));
    if (live) {
      throw Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint: 'uq_agent_runs_one_live_per_build_task',
      });
    }
    const runId = input.runId ?? `run-${rows.size + 1}`;
    rows.set(runId, {
      id: runId,
      status: 'queued',
      lane: input.lane,
      projectId: input.projectId,
      workflowClass: input.workflowClass,
      buildTaskId: input.buildTaskId,
      ownerInstance: input.ownerInstance,
      cloudAgentIdentity: null,
      dispatchMessageId: null,
      executionSnapshot: input.snapshot,
      buildLaunchSnapshot: null,
    });
    input.executor.inserted.push(runId);
    focusRunId = runId;
    await Promise.resolve();
    return { runId };
  });
  mockMarkTerminal.mockImplementation(async (runId: string, input: { status: string; detail?: string }) => {
    const row = rows.get(runId);
    if (row) Object.assign(row, { status: input.status, detail: input.detail });
    return { ok: true, run: row };
  });
  mockCapture.mockImplementation(async (runId: string, input: { cloudAgentIdentity: string; cursorRunId: string }) => {
    const row = rows.get(runId)!;
    Object.assign(row, {
      cloudAgentIdentity: input.cloudAgentIdentity,
      dispatchMessageId: input.cursorRunId,
      status: 'running',
    });
    return { ok: true, run: row };
  });
  mockLaunch.mockResolvedValue({ cloudAgentId: 'bc-1', cursorRunId: 'run-cursor-1', jobName: 'cursor-sdk' });
  mockCancel.mockResolvedValue(undefined);
});

describe('writeBuildLaunchSnapshot and launchBuildAgentRun', () => {
  it('VT-10 / DoD-2: writes the snapshot before the SDK call and launches from it', async () => {
    let seenAtLaunch: FakeRow | undefined;
    mockLaunch.mockImplementation(async () => {
      seenAtLaunch = structuredClone(rows.get(focusRunId));
      return { cloudAgentId: 'bc-1', cursorRunId: 'run-cursor-1', jobName: 'cursor-sdk' };
    });

    const written = await writeBuildLaunchSnapshot({
      candidate: snapshot(),
      expectedProjectId: 'MaxView',
      deps: deps(),
    });
    expect(written).toEqual({ ok: true, runId: 'run-1' });
    expect(mockLaunch).not.toHaveBeenCalled();

    const row = rows.get('run-1')!;
    expect(row).toMatchObject({
      lane: 'cloud-agent',
      workflowClass: 'build-task',
      buildTaskId: TASK_ID,
      buildLaunchSnapshot: snapshot(),
    });
    expect(row.ownerInstance).toBeTruthy();
    expect(row.executionSnapshot.prompt).toBe(`build-task:${TASK_ID}`);
    expect(JSON.stringify(row.executionSnapshot)).not.toContain(PROMPT);

    const launched = await launchBuildAgentRun('run-1', deps());

    expect(launched).toEqual({ ok: true, runId: 'run-1', cloudAgentId: 'bc-1', cursorRunId: 'run-cursor-1' });
    expect(seenAtLaunch?.buildLaunchSnapshot).toEqual(snapshot());
    expect(seenAtLaunch?.buildTaskId).toBe(TASK_ID);
    expect(mockLaunch).toHaveBeenCalledWith(expect.objectContaining({
      project: 'MaxView',
      prompt: PROMPT,
      model: 'composer-2.5',
      skillProvider: 'ado',
      skillRepo: 'MaxView',
      build: { startingBranch: 'build/run-1', branchName: 'build/run-1/t1', openPullRequest: false },
    }));
    expect(mockLaunch.mock.calls[0][0]).not.toHaveProperty('skillBranch');
    expect(mockTrackEvent).toHaveBeenCalledWith(
      'build_agent.snapshot_written',
      expect.objectContaining({ taskKey: 't1', role: 'implementer', attempt: '1' }),
      expect.objectContaining({ durationMs: expect.any(Number) }),
    );
  });

  it('VT-11 / DoD-0: refuses a row with no snapshot, marks it failed and never calls the SDK', async () => {
    queuedBuildRow('run-a', null);

    const result = await launchBuildAgentRun('run-a', deps());

    expect(result).toEqual({ ok: false, refused: true, refusals: [{ code: 'snapshot_missing' }] });
    expect(rows.get('run-a')?.status).toBe('failed');
    expect(mockLaunch).not.toHaveBeenCalled();
  });

  it('VT-11 / DoD-0: refuses a stored snapshot with a missing field', async () => {
    const incomplete = snapshot() as unknown as Record<string, unknown>;
    delete incomplete.targetBranch;
    queuedBuildRow('run-b', incomplete as unknown as BuildLaunchSnapshot);

    const result = await launchBuildAgentRun('run-b', deps());

    expect(result).toEqual({
      ok: false,
      refused: true,
      refusals: [{ code: 'snapshot_field_missing', fieldPath: 'targetBranch' }],
    });
    expect(rows.get('run-b')?.detail).toContain('snapshot_field_missing (targetBranch)');
    expect(mockLaunch).not.toHaveBeenCalled();
  });

  it('VT-11: launches with the model from the snapshot, ignoring a tampered stub', async () => {
    const row = queuedBuildRow('run-c', snapshot({ model: 'claude-sonnet-4-6' }));
    row.executionSnapshot.model = 'tampered-model';

    await launchBuildAgentRun('run-c', deps());

    expect(mockLaunch).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-sonnet-4-6' }));
  });

  it('refuses a snapshot whose task does not match the row', async () => {
    queuedBuildRow('run-d', snapshot({ buildTaskId: '44444444-4444-4444-8444-444444444444' }));

    const result = await launchBuildAgentRun('run-d', deps());

    expect(result).toEqual({
      ok: false,
      refused: true,
      refusals: [{ code: 'snapshot_field_invalid', fieldPath: 'buildTaskId' }],
    });
    expect(mockLaunch).not.toHaveBeenCalled();
  });

  it('VT-12 / DoD-2: a retried write with a different snapshot is refused and the row is unchanged', async () => {
    const original = snapshot();
    queuedBuildRow('run-e', original);

    const different = await writeBuildLaunchSnapshot({
      candidate: snapshot({ model: 'claude-sonnet-4-6' }),
      expectedProjectId: 'MaxView',
      runId: 'run-e',
      deps: deps(),
    });
    const identical = await writeBuildLaunchSnapshot({
      candidate: snapshot(),
      expectedProjectId: 'MaxView',
      runId: 'run-e',
      deps: deps(),
    });

    expect(different).toEqual({ ok: false, conflict: true, reason: 'snapshot_already_written' });
    expect(identical).toEqual({ ok: true, runId: 'run-e' });
    expect(rows.get('run-e')?.buildLaunchSnapshot).toEqual(original);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('VT-13: two racing writes for one task give one run and one conflict; Cursor is called once', async () => {
    const [first, second] = await Promise.all([
      writeBuildLaunchSnapshot({ candidate: snapshot(), expectedProjectId: 'MaxView', deps: deps() }),
      writeBuildLaunchSnapshot({ candidate: snapshot(), expectedProjectId: 'MaxView', deps: deps() }),
    ]);

    const results = [first, second];
    expect(results).toContainEqual({ ok: true, runId: 'run-1' });
    expect(results).toContainEqual({ ok: false, conflict: true, reason: 'task_already_launching' });
    expect(rows.size).toBe(1);

    focusRunId = 'run-1';
    const launches = [await launchBuildAgentRun('run-1', deps()), await launchBuildAgentRun('run-1', deps())];

    expect(launches[1]).toEqual({ ok: false, conflict: true, reason: 'run_not_launchable' });
    expect(mockLaunch).toHaveBeenCalledTimes(1);
  });

  it('VT-14: stops an orphaned agent when its identity cannot be recorded', async () => {
    queuedBuildRow('run-f', snapshot());
    mockCapture.mockResolvedValue({
      ok: false,
      conflict: true,
      reason: 'identity_already_set',
      run: { cloudAgentIdentity: 'bc-other', dispatchMessageId: null },
    });

    const result = await launchBuildAgentRun('run-f', deps());

    expect(mockCancel).toHaveBeenCalledWith({ project: 'MaxView', cloudAgentId: 'bc-1', cursorRunId: 'run-cursor-1' });
    expect(rows.get('run-f')?.status).toBe('failed');
    expect(result).toEqual({ ok: false, conflict: true, reason: 'identity_capture_failed' });
    expect(mockTrackEvent).toHaveBeenCalledWith(
      'build_agent.launch_failed',
      expect.objectContaining({ runId: 'run-f', orphanStopped: 'true' }),
    );
  });

  it('VT-14: presents the dispatch fence when capture wrote it before failing', async () => {
    queuedBuildRow('run-g', snapshot());
    mockCapture.mockResolvedValue({
      ok: false,
      conflict: true,
      reason: 'illegal_transition',
      run: { cloudAgentIdentity: 'bc-1', dispatchMessageId: 'run-cursor-1' },
    });

    await launchBuildAgentRun('run-g', deps());

    expect(mockMarkTerminal).toHaveBeenCalledWith('run-g', expect.objectContaining({
      status: 'failed',
      dispatchMessageId: 'run-cursor-1',
    }));
    expect(mockCancel).toHaveBeenCalled();
  });

  it('marks the row failed when the client refuses the launch', async () => {
    queuedBuildRow('run-h', snapshot());
    mockLaunch.mockRejectedValue(new Error('Cloud Agent launch refused: no model was given.'));

    const result = await launchBuildAgentRun('run-h', deps());

    expect(result).toEqual({ ok: false, conflict: true, reason: 'launch_failed' });
    expect(rows.get('run-h')).toMatchObject({ status: 'failed', detail: 'Cloud Agent launch refused: no model was given.' });
    expect(mockCancel).not.toHaveBeenCalled();
  });

  it('VT-19 / DoD-1: refuses a prompt whose hash does not match', async () => {
    queuedBuildRow('run-i', snapshot());

    const result = await launchBuildAgentRun('run-i', deps('A different prompt.'));

    expect(result).toEqual({
      ok: false,
      refused: true,
      refusals: [{ code: 'prompt_hash_mismatch', fieldPath: 'prompt.contentHash' }],
    });
    expect(mockLaunch).not.toHaveBeenCalled();
    expect(rows.get('run-i')?.status).toBe('failed');
  });

  it('VT-19 / DoD-1: refuses a prompt that holds a held secret value, but not a pasted credential pattern', async () => {
    const secretPrompt = `Use ${HELD} to call the API.`;
    queuedBuildRow('run-j', snapshot({
      prompt: { container: 'cursor-prompts', key: 'builds/run-1/t1/1/prompt.txt', contentHash: sha256(secretPrompt) },
    }));

    const refused = await launchBuildAgentRun('run-j', deps(secretPrompt));

    expect(refused).toEqual({
      ok: false,
      refused: true,
      refusals: [{ code: 'prompt_contains_held_secret', fieldPath: 'prompt' }],
    });
    expect(mockLaunch).not.toHaveBeenCalled();

    const pastedPrompt = 'The brief says api_key=abc is in the sample config.';
    queuedBuildRow('run-k', snapshot({
      prompt: { container: 'cursor-prompts', key: 'builds/run-1/t1/1/prompt.txt', contentHash: sha256(pastedPrompt) },
    }));
    rows.delete('run-j');

    expect((await launchBuildAgentRun('run-k', deps(pastedPrompt))).ok).toBe(true);
  });

  it('VT-17 / DoD-1: refusals, events and logs never carry the planted secret or prompt text', async () => {
    const logSpies = (['log', 'warn', 'error'] as const).map((method) => (
      jest.spyOn(console, method).mockImplementation(() => undefined)
    ));
    try {
      const secretBearing = await writeBuildLaunchSnapshot({
        candidate: snapshot({ taskKey: `t1-${HELD}` }),
        expectedProjectId: 'MaxView',
        deps: deps(),
      });
      const incomplete = snapshot() as unknown as Record<string, unknown>;
      delete incomplete.caps;
      const missing = await writeBuildLaunchSnapshot({
        candidate: incomplete,
        expectedProjectId: 'MaxView',
        deps: deps(),
      });

      expect(secretBearing).toEqual({
        ok: false,
        refused: true,
        refusals: [{ code: 'snapshot_secret_value', fieldPath: 'taskKey' }],
      });
      expect(missing).toEqual({
        ok: false,
        refused: true,
        refusals: [{ code: 'snapshot_field_missing', fieldPath: 'caps' }],
      });
      expect(mockTrackEvent).toHaveBeenCalledWith('build_agent.launch_refused', expect.objectContaining({
        code: 'snapshot_secret_value',
        fieldPath: 'taskKey',
        taskKey: '',
      }));
      const emitted = JSON.stringify([
        secretBearing,
        missing,
        mockTrackEvent.mock.calls,
        ...logSpies.map((spy) => spy.mock.calls),
      ]);
      expect(emitted).not.toContain(HELD);
      expect(emitted).not.toContain(PROMPT);
      expect(mockEnqueue).not.toHaveBeenCalled();
    } finally {
      for (const spy of logSpies) spy.mockRestore();
    }
  });
});

describe('readBuildPromptBlob', () => {
  it.each([
    ['another container', { container: 'repo-grounding', key: 'builds/run-1/prompt.txt' }],
    ['a key outside builds/', { container: 'cursor-prompts', key: 'prompts/abc.txt' }],
  ])('refuses %s before touching storage', async (_label, pointer) => {
    await expect(readBuildPromptBlob(pointer)).rejects.toThrow('outside the build prompt area');
  });
});
