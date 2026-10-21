import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AI_RUN_V2_SCHEMA_VERSION, type AiRunV2Command } from '../../../shared/types/aiRunV2';
import type {
  AiRunV2PromptfooSpecification,
  WorkflowEvaluationPromptfooSuite,
} from '../../../shared/types/aiRunV2EvaluationSpec';
import {
  createPromptfooExecute,
  forkPromptfooRunner,
  PROMPTFOO_BLOCKED_PROXY,
  promptfooRunnerEnvironment,
  type PromptfooRunnerReply,
  type RunPromptfooRunner,
} from '../../services/aiRunsV2Worker/promptfooExecution';

const FAKE_RUNNER = path.resolve(__dirname, '../fixtures/fakePromptfooRunner.cjs');

const suite: WorkflowEvaluationPromptfooSuite = {
  ref: 'orchestrated_workflow/prd_human_review/structural@1',
  subjectType: 'prd',
  tests: [
    { description: 'PRD has a problem statement', target: 'artifact', assert: [{ type: 'contains', value: '## Problem' }] },
    { description: 'PRD has a solution', target: 'artifact', assert: [{ type: 'contains', value: '## Solution' }] },
    { description: 'Backlog is JSON', target: 'backlog', assert: [{ type: 'is-json' }] },
  ],
};

function specification(overrides: Partial<AiRunV2PromptfooSpecification> = {}): AiRunV2PromptfooSpecification {
  const testSuite = overrides.suite ?? suite;
  return {
    specVersion: 1,
    workloadLane: 'document',
    workflowClass: 'evaluation-promptfoo',
    projectId: 'Apex',
    threadId: 'wfeval:event-1:promptfoo',
    deadlineMs: 300_000,
    evaluation: {
      eventId: 'event-1',
      jobId: 'job-1',
      stageKey: 'prd_human_review',
      rubricVersion: 1,
      artifactHash: 'a'.repeat(64),
    },
    suite: testSuite,
    suiteSha256: createHash('sha256').update(JSON.stringify(testSuite)).digest('hex'),
    artifactPackage: {
      kind: 'prd',
      markdown: '# PRD\n\n## Problem\nUsers cannot export.\n',
      backlogJson: '{"epics":[]}',
      sourceTranscript: null,
      truncated: false,
      omittedSections: [],
      omittedMessages: 0,
    },
    ...overrides,
  };
}

function command(): AiRunV2Command {
  return {
    schemaVersion: AI_RUN_V2_SCHEMA_VERSION,
    eventId: 'event-1',
    runId: 'run-1',
    attemptId: 'attempt-1',
    attemptNumber: 1,
    dispatchMessageId: 'dispatch-1',
    timestamp: '2026-10-21T12:00:00.000Z',
    kind: 'dispatch_command',
    transport: 'servicebus-blob-v2',
    workloadLane: 'document',
    capacityClass: 'batch',
    specRef: { container: 'ai-run-artifacts', key: 'runs/run-1/attempts/1/spec.json' },
  };
}

function checkpoints() {
  return {
    publishStarted: jest.fn(),
    publishHeartbeat: jest.fn(),
    publishProgress: jest.fn().mockResolvedValue(undefined),
    lastSequence: jest.fn().mockReturnValue(0),
  };
}

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'promptfoo-execute-test-'));
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

function run(
  runRunner: RunPromptfooRunner,
  spec: unknown = specification(),
  overrides: { runnerPath?: string | undefined } = { runnerPath: '/opt/promptfoo/run.cjs' },
) {
  const execute = createPromptfooExecute({
    runnerPath: overrides.runnerPath,
    runRunner,
    tempRoot,
    parentEnv: { PATH: '/usr/bin', AZURE_CLIENT_SECRET: 'secret' },
    now: () => 1_000,
  });
  return execute({
    specification: spec as AiRunV2PromptfooSpecification,
    command: command(),
    checkpoints: checkpoints(),
    signal: new AbortController().signal,
  });
}

function parse(content: Buffer | string): Record<string, unknown> {
  return JSON.parse(content.toString()) as Record<string, unknown>;
}

describe('Promptfoo execution', () => {
  it('sends the rendered targets and writes a summary and full results', async () => {
    const runRunner = jest.fn<Promise<PromptfooRunnerReply>, Parameters<RunPromptfooRunner>>(async () => ({
      ok: true,
      rows: [
        { testIdx: 0, success: true, failures: [] },
        {
          testIdx: 1,
          success: false,
          failures: [{ type: 'contains', reason: 'Expected output to contain "## Solution"' }],
        },
        { testIdx: 2, success: true, failures: [] },
      ],
    }));

    const outcome = await run(runRunner);

    const input = runRunner.mock.calls[0][0];
    expect(input.request.targets).toEqual({
      artifact: '# PRD\n\n## Problem\nUsers cannot export.\n',
      backlog: '{"epics":[]}',
    });
    expect(input.request.tests).toEqual(suite.tests);
    expect(input.cwd.startsWith(tempRoot)).toBe(true);
    expect(input.env.HTTPS_PROXY).toBe(PROMPTFOO_BLOCKED_PROXY);
    expect(input.env.AZURE_CLIENT_SECRET).toBeUndefined();

    expect(outcome.files.map((file) => file.path)).toEqual([
      'output/promptfoo-summary.json',
      'output/promptfoo-results.json',
    ]);
    expect(parse(outcome.files[0].content)).toEqual({
      suiteRef: suite.ref,
      suiteSha256: specification().suiteSha256,
      artifactHash: 'a'.repeat(64),
      passed: false,
      totals: { tests: 3, passed: 2, failed: 1 },
      failures: [{
        test: 'PRD has a solution',
        assertion: 'contains',
        reason: 'Expected output to contain "## Solution"',
      }],
      durationMs: 0,
    });
    expect(parse(outcome.files[1].content)).toMatchObject({
      suiteRef: suite.ref,
      tests: [
        { description: 'PRD has a problem statement', target: 'artifact', passed: true, failures: [] },
        { description: 'PRD has a solution', passed: false },
        { description: 'Backlog is JSON', target: 'backlog', passed: true },
      ],
    });
    expect(outcome.detail).toBe('2/3 Promptfoo tests passed');
    await expect(fs.readdir(tempRoot)).resolves.toEqual([]);
  });

  it('records a failure for a test Promptfoo returned no row for, and for a failed test with only an error', async () => {
    const outcome = await run(async () => ({
      ok: true,
      rows: [
        { description: 'PRD has a problem statement', success: true, failures: [] },
        { testIdx: 1, success: false, error: 'provider error', failures: [] },
      ],
    }));

    const summary = parse(outcome.files[0].content);
    expect(summary.totals).toEqual({ tests: 3, passed: 1, failed: 2 });
    expect(summary.failures).toEqual([
      { test: 'PRD has a solution', assertion: 'contains', reason: 'provider error' },
      { test: 'Backlog is JSON', assertion: 'is-json', reason: 'Promptfoo returned no result for this test.' },
    ]);
  });

  it('refuses a suite whose hash does not match before starting the runner', async () => {
    const runRunner = jest.fn();
    await expect(run(runRunner, specification({ suiteSha256: 'b'.repeat(64) }))).rejects.toThrow(
      'mismatched hash',
    );
    expect(runRunner).not.toHaveBeenCalled();
  });

  it('refuses an invalid specification and a worker with no runner installed', async () => {
    const runRunner = jest.fn();
    await expect(run(runRunner, { ...specification(), suite: { ...suite, tests: [] } })).rejects.toThrow(
      'invalid Promptfoo specification',
    );
    await expect(run(runRunner, specification(), { runnerPath: undefined })).rejects.toThrow(
      'no Promptfoo runner installed',
    );
    expect(runRunner).not.toHaveBeenCalled();
  });

  it('fails the run when Promptfoo reports an error, and still removes its working folder', async () => {
    await expect(run(async () => ({ ok: false, error: 'bad config' }))).rejects.toThrow(
      'Promptfoo could not run the suite: bad config',
    );
    await expect(fs.readdir(tempRoot)).resolves.toEqual([]);
  });
});

describe('promptfooRunnerEnvironment', () => {
  it('passes only what Node needs, turns Promptfoo off, and points every proxy at a closed port', () => {
    const env = promptfooRunnerEnvironment('/tmp/config', {
      PATH: '/usr/bin',
      HOME: '/root',
      AZURE_CLIENT_SECRET: 'secret',
      AI_RUNS_V2_SERVICEBUS_NAMESPACE: 'sb',
      NO_PROXY: 'r.promptfoo.app',
    });

    expect(env).toMatchObject({
      PATH: '/usr/bin',
      HOME: '/root',
      HTTPS_PROXY: PROMPTFOO_BLOCKED_PROXY,
      HTTP_PROXY: PROMPTFOO_BLOCKED_PROXY,
      https_proxy: PROMPTFOO_BLOCKED_PROXY,
      http_proxy: PROMPTFOO_BLOCKED_PROXY,
      NO_PROXY: '',
      PROMPTFOO_CONFIG_DIR: '/tmp/config',
      PROMPTFOO_DISABLE_TELEMETRY: '1',
      PROMPTFOO_CACHE_ENABLED: 'false',
    });
    expect(env.AZURE_CLIENT_SECRET).toBeUndefined();
    expect(env.AI_RUNS_V2_SERVICEBUS_NAMESPACE).toBeUndefined();
  });
});

describe('forkPromptfooRunner', () => {
  const env = promptfooRunnerEnvironment(os.tmpdir(), process.env);
  const request = (description: string) => ({
    targets: { artifact: '## Problem', backlog: '' },
    tests: [{ description, target: 'artifact' as const, assert: [{ type: 'contains' as const, value: '## Problem' }] }],
  });

  it('returns the runner reply from a child that cannot see the worker environment', async () => {
    const reply = await forkPromptfooRunner({
      runnerPath: FAKE_RUNNER,
      request: request('ok'),
      cwd: os.tmpdir(),
      env,
      signal: new AbortController().signal,
    });

    expect(reply).toMatchObject({
      ok: true,
      rows: [{ testIdx: 0, success: true }],
      env: { proxy: PROMPTFOO_BLOCKED_PROXY, secret: null },
    });
  });

  it('reports a child that exits without replying, with its stderr', async () => {
    await expect(forkPromptfooRunner({
      runnerPath: FAKE_RUNNER,
      request: request('CRASH'),
      cwd: os.tmpdir(),
      env,
      signal: new AbortController().signal,
    })).rejects.toThrow(/code=3.*runner blew up/);
  });

  it('kills a hung child when the attempt is aborted', async () => {
    const controller = new AbortController();
    const pending = forkPromptfooRunner({
      runnerPath: FAKE_RUNNER,
      request: request('HANG'),
      cwd: os.tmpdir(),
      env,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 200);

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
