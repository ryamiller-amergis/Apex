/**
 * Runs a Promptfoo evaluation from worker to job row: the worker executor
 * writes its files, the harvest reads them back through a manifest, and the
 * ingest records the job result.
 *
 * Uses the fake runner by default. Set AI_RUNS_V2_PROMPTFOO_RUNNER to
 * runners/ai-runs-documents-v2/promptfoo/run.cjs, after `npm ci` in that
 * folder, to run the same test against the pinned Promptfoo install.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AI_RUN_V2_SCHEMA_VERSION,
  type AiRunV2ArtifactManifest,
  type AiRunV2Command,
} from '../../shared/types/aiRunV2';
import type {
  AiRunV2PromptfooSpecification,
  WorkflowEvaluationPromptfooSuite,
} from '../../shared/types/aiRunV2EvaluationSpec';
import type { WorkflowEvaluationJob } from '../../shared/types/workflowEvaluation';
import type { FinishedV2DocumentAttempt } from '../services/aiRunV2/finishedAttemptReader';
import { createPromptfooExecute } from '../services/aiRunsV2Worker/promptfooExecution';
import { harvestFinishedV2Documents } from '../services/documentV2Harvest';
import { createWorkflowEvaluationJobIngestService } from '../services/workflowEvaluationJobIngestService';

const RUNNER = process.env.AI_RUNS_V2_PROMPTFOO_RUNNER
  ?? path.resolve(__dirname, 'fixtures/fakePromptfooRunner.cjs');
const EVENT_ID = '22222222-2222-4222-8222-222222222222';
const THREAD_ID = `wfeval:${EVENT_ID}:promptfoo`;
const CONTAINER = 'ai-run-artifacts';

const suite: WorkflowEvaluationPromptfooSuite = {
  ref: 'orchestrated_workflow/prd_human_review/structural@1',
  subjectType: 'prd',
  tests: [
    { description: 'PRD has a problem statement', target: 'artifact', assert: [{ type: 'contains', value: '## Problem' }] },
    { description: 'PRD has a solution', target: 'artifact', assert: [{ type: 'contains', value: '## Solution' }] },
  ],
};

const specification: AiRunV2PromptfooSpecification = {
  specVersion: 1,
  workloadLane: 'document',
  workflowClass: 'evaluation-promptfoo',
  projectId: 'Apex',
  threadId: THREAD_ID,
  deadlineMs: 120_000,
  evaluation: {
    eventId: EVENT_ID,
    jobId: 'job-promptfoo',
    stageKey: 'prd_human_review',
    rubricVersion: 1,
    artifactHash: 'a'.repeat(64),
  },
  suite,
  suiteSha256: createHash('sha256').update(JSON.stringify(suite)).digest('hex'),
  artifactPackage: {
    kind: 'prd',
    markdown: '# PRD\n\n## Problem\nUsers cannot export.\n',
    backlogJson: '{"epics":[]}',
    sourceTranscript: null,
    truncated: false,
    omittedSections: [],
    omittedMessages: 0,
  },
};

const command: AiRunV2Command = {
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
  specRef: { container: CONTAINER, key: 'runs/run-1/attempts/1/spec.json' },
};

const runningJob: WorkflowEvaluationJob = {
  id: 'job-promptfoo',
  eventId: EVENT_ID,
  evaluatorKey: 'promptfoo',
  status: 'running',
  runId: 'run-1',
  specificationHash: 'b'.repeat(64),
  summary: null,
  resultBlobRefs: null,
  errorDetail: null,
  createdAt: '2026-10-21T12:00:00.000Z',
  updatedAt: '2026-10-21T12:00:00.000Z',
};

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wfeval-round-trip-'));
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

it('records a Promptfoo run with one failed assertion as a failed job with its summary', async () => {
  const execute = createPromptfooExecute({ runnerPath: RUNNER, tempRoot, parentEnv: process.env });
  const outcome = await execute({
    specification,
    command,
    checkpoints: {
      publishStarted: jest.fn(),
      publishHeartbeat: jest.fn(),
      publishProgress: jest.fn().mockResolvedValue(undefined),
      lastSequence: jest.fn().mockReturnValue(0),
    },
    signal: new AbortController().signal,
  });

  const blobs = new Map(outcome.files.map((file) => [file.path, Buffer.from(file.content)]));
  const manifest: AiRunV2ArtifactManifest = {
    schemaVersion: AI_RUN_V2_SCHEMA_VERSION,
    transport: 'servicebus-blob-v2',
    runId: 'run-1',
    attemptId: 'attempt-1',
    attemptNumber: 1,
    writtenAt: '2026-10-21T12:01:00.000Z',
    files: [...blobs].map(([filePath, body]) => ({
      path: filePath,
      sha256: createHash('sha256').update(body).digest('hex'),
      sizeBytes: body.length,
      ref: { container: CONTAINER, key: `runs/run-1/attempts/1/${filePath}` },
    })),
  };
  const attempt: FinishedV2DocumentAttempt = {
    attemptId: 'attempt-1',
    attemptNumber: 1,
    runId: 'run-1',
    threadId: THREAD_ID,
    dispatchMessageId: 'dispatch-1',
    status: 'completed',
    manifestRef: { container: CONTAINER, key: 'runs/run-1/attempts/1/manifest.json' },
    failureDetail: null,
    generationOwner: null,
    workflowClass: 'evaluation-promptfoo',
  };
  const finishedAttempts = {
    listFinishedByThread: jest.fn(),
    listFinishedDocuments: jest.fn().mockResolvedValue([attempt]),
    isDocumentHarvestPending: jest.fn().mockResolvedValue(false),
    recordHarvestFailure: jest.fn().mockResolvedValue(1),
    claimHarvest: jest.fn().mockResolvedValue('claimed'),
    completeHarvest: jest.fn().mockResolvedValue(undefined),
  };
  const artifacts = {
    readManifest: jest.fn().mockResolvedValue(manifest),
    readText: jest.fn(),
    readFile: jest.fn(async (entry: { path: string }) => blobs.get(entry.path) ?? Buffer.alloc(0)),
  };
  const repository = {
    getJob: jest.fn().mockResolvedValue(runningJob),
    finishRunningJob: jest.fn().mockResolvedValue(true),
    getJudgeOutputSchema: jest.fn(),
    listStalledRunningJobs: jest.fn(),
    failStalledRunningJob: jest.fn(),
  };

  await expect(harvestFinishedV2Documents({
    finishedAttempts,
    artifacts,
    applyWorkspace: jest.fn(),
    applySmartTagging: jest.fn(),
    evaluationJobs: createWorkflowEvaluationJobIngestService({ repository }),
    tempRoot,
  })).resolves.toBe(1);

  expect(finishedAttempts.completeHarvest).toHaveBeenCalledWith('attempt-1');
  expect(repository.finishRunningJob).toHaveBeenCalledWith('job-promptfoo', 'run-1', {
    status: 'failed',
    errorDetail: 'assertions_failed: 1 of 2 Promptfoo tests failed',
    summary: expect.objectContaining({
      suiteRef: suite.ref,
      suiteSha256: specification.suiteSha256,
      passed: false,
      totals: { tests: 2, passed: 1, failed: 1 },
      failures: [expect.objectContaining({ test: 'PRD has a solution', assertion: 'contains' })],
    }),
    resultBlobRefs: {
      output: { container: CONTAINER, key: 'runs/run-1/attempts/1/output/promptfoo-summary.json' },
      appendix: { container: CONTAINER, key: 'runs/run-1/attempts/1/output/promptfoo-results.json' },
    },
  });
}, 60_000);
