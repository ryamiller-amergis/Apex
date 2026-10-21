import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AI_RUN_V2_SCHEMA_VERSION, type AiRunV2ArtifactManifest } from '../../shared/types/aiRunV2';
import type {
  WorkflowEvaluationJob,
  WorkflowEvaluationJobEvaluator,
} from '../../shared/types/workflowEvaluation';
import {
  createWorkflowEvaluationJobIngestService,
  type WorkflowEvaluationRunClass,
} from '../services/workflowEvaluationJobIngestService';

jest.mock('../db/drizzle', () => ({ db: {} }));

const EVENT_ID = '11111111-1111-4111-8111-111111111111';

const SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    missedRequirements: { type: 'array' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
  required: ['missedRequirements', 'confidence'],
  additionalProperties: false,
};

function job(
  evaluatorKey: WorkflowEvaluationJobEvaluator,
  overrides: Partial<WorkflowEvaluationJob> = {},
): WorkflowEvaluationJob {
  return {
    id: `job-${evaluatorKey}`,
    eventId: EVENT_ID,
    evaluatorKey,
    status: 'running',
    runId: 'run-1',
    specificationHash: 'a'.repeat(64),
    summary: null,
    resultBlobRefs: null,
    errorDetail: null,
    createdAt: '2026-10-21T12:00:00.000Z',
    updatedAt: '2026-10-21T12:00:00.000Z',
    ...overrides,
  };
}

function manifest(names: string[]): AiRunV2ArtifactManifest {
  return {
    schemaVersion: AI_RUN_V2_SCHEMA_VERSION,
    transport: 'servicebus-blob-v2',
    runId: 'run-1',
    attemptId: 'attempt-1',
    attemptNumber: 1,
    writtenAt: '2026-10-21T12:00:00.000Z',
    files: names.map((name) => ({
      path: `output/${name}`,
      sha256: 'b'.repeat(64),
      sizeBytes: 1,
      ref: { container: 'ai-run-artifacts', key: `runs/run-1/attempts/1/output/${name}` },
    })),
  };
}

function promptfooSummary(failed: number) {
  return {
    suiteRef: 'orchestrated_workflow/prd_human_review/structural@1',
    suiteSha256: 'c'.repeat(64),
    artifactHash: 'd'.repeat(64),
    passed: failed === 0,
    totals: { tests: 4, passed: 4 - failed, failed },
    failures: failed === 0
      ? []
      : [{ test: 'has goals', assertion: 'contains', reason: 'Expected output to contain "## Goals"' }],
    durationMs: 12,
  };
}

describe('workflow evaluation job ingest', () => {
  let outputDir: string;

  beforeEach(async () => {
    outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wfeval-ingest-'));
  });

  afterEach(async () => {
    await fs.rm(outputDir, { recursive: true, force: true });
  });

  function arrange(current: WorkflowEvaluationJob | null) {
    const repository = {
      getJob: jest.fn().mockResolvedValue(current),
      finishRunningJob: jest.fn().mockResolvedValue(true),
      getJudgeOutputSchema: jest.fn().mockResolvedValue(SCHEMA),
      listStalledRunningJobs: jest.fn().mockResolvedValue([]),
      failStalledRunningJob: jest.fn().mockResolvedValue(true),
    };
    const service = createWorkflowEvaluationJobIngestService({
      repository,
      now: () => new Date('2026-10-21T13:00:00.000Z'),
    });
    return { repository, service };
  }

  function completed(workflowClass: WorkflowEvaluationRunClass, names: string[]) {
    const evaluator = workflowClass === 'evaluation-judge' ? 'llm_judge' : 'promptfoo';
    return {
      runId: 'run-1',
      threadId: `wfeval:${EVENT_ID}:${evaluator}`,
      workflowClass,
      outputDir,
      manifest: manifest(names),
    };
  }

  it('marks a passing Promptfoo job ready with its summary and both blob refs', async () => {
    const { repository, service } = arrange(job('promptfoo'));
    await fs.writeFile(path.join(outputDir, 'promptfoo-summary.json'), JSON.stringify(promptfooSummary(0)));

    await expect(service.applyCompleted(
      completed('evaluation-promptfoo', ['promptfoo-summary.json', 'promptfoo-results.json']),
    )).resolves.toBe('applied');

    expect(repository.getJob).toHaveBeenCalledWith(EVENT_ID, 'promptfoo');
    expect(repository.finishRunningJob).toHaveBeenCalledWith('job-promptfoo', 'run-1', {
      status: 'ready',
      summary: promptfooSummary(0),
      errorDetail: null,
      resultBlobRefs: {
        output: { container: 'ai-run-artifacts', key: 'runs/run-1/attempts/1/output/promptfoo-summary.json' },
        appendix: { container: 'ai-run-artifacts', key: 'runs/run-1/attempts/1/output/promptfoo-results.json' },
      },
    });
  });

  it('fails a Promptfoo job with failed assertions and keeps the summary', async () => {
    const { repository, service } = arrange(job('promptfoo'));
    await fs.writeFile(path.join(outputDir, 'promptfoo-summary.json'), JSON.stringify(promptfooSummary(1)));

    await service.applyCompleted(
      completed('evaluation-promptfoo', ['promptfoo-summary.json', 'promptfoo-results.json']),
    );

    expect(repository.finishRunningJob).toHaveBeenCalledWith('job-promptfoo', 'run-1', expect.objectContaining({
      status: 'failed',
      summary: promptfooSummary(1),
      errorDetail: 'assertions_failed: 1 of 4 Promptfoo tests failed',
    }));
  });

  it('fails a Promptfoo job whose summary is malformed', async () => {
    const { repository, service } = arrange(job('promptfoo'));
    await fs.writeFile(path.join(outputDir, 'promptfoo-summary.json'), '{"passed":"yes"}');

    await service.applyCompleted(completed('evaluation-promptfoo', ['promptfoo-summary.json']));

    expect(repository.finishRunningJob).toHaveBeenCalledWith('job-promptfoo', 'run-1', expect.objectContaining({
      status: 'failed',
      summary: null,
      errorDetail: expect.stringMatching(/^result_invalid: /),
    }));
  });

  it('marks a judge job ready when the result matches the definition schema', async () => {
    const { repository, service } = arrange(job('llm_judge'));
    const output = { missedRequirements: [], confidence: 'high' };
    await fs.writeFile(path.join(outputDir, 'judge-result.json'), JSON.stringify(output));

    await service.applyCompleted(completed('evaluation-judge', ['judge-result.json', 'judge-result.md']));

    expect(repository.getJudgeOutputSchema).toHaveBeenCalledWith(EVENT_ID);
    expect(repository.finishRunningJob).toHaveBeenCalledWith('job-llm_judge', 'run-1', expect.objectContaining({
      status: 'ready',
      summary: output,
      errorDetail: null,
      resultBlobRefs: {
        output: expect.objectContaining({ key: 'runs/run-1/attempts/1/output/judge-result.json' }),
        appendix: expect.objectContaining({ key: 'runs/run-1/attempts/1/output/judge-result.md' }),
      },
    }));
  });

  it('fails a judge job whose result breaks the definition schema', async () => {
    const { repository, service } = arrange(job('llm_judge'));
    await fs.writeFile(
      path.join(outputDir, 'judge-result.json'),
      JSON.stringify({ missedRequirements: [], confidence: 'certain' }),
    );

    await service.applyCompleted(completed('evaluation-judge', ['judge-result.json']));

    expect(repository.finishRunningJob).toHaveBeenCalledWith('job-llm_judge', 'run-1', expect.objectContaining({
      status: 'failed',
      summary: null,
      errorDetail: expect.stringMatching(/^result_invalid: Judge output does not match the output schema/),
    }));
  });

  it('ignores a result from a run that no longer owns the job', async () => {
    const { repository, service } = arrange(job('promptfoo', { runId: 'run-2' }));
    await fs.writeFile(path.join(outputDir, 'promptfoo-summary.json'), JSON.stringify(promptfooSummary(0)));

    await expect(service.applyCompleted(
      completed('evaluation-promptfoo', ['promptfoo-summary.json']),
    )).resolves.toBe('skipped');
    expect(repository.finishRunningJob).not.toHaveBeenCalled();
  });

  it('ignores a run whose thread names the other evaluator', async () => {
    const { repository, service } = arrange(job('promptfoo'));

    await expect(service.applyCompleted({
      ...completed('evaluation-promptfoo', []),
      threadId: `wfeval:${EVENT_ID}:llm_judge`,
    })).resolves.toBe('skipped');
    expect(repository.getJob).not.toHaveBeenCalled();
  });

  it('reports skipped when the guarded update finds the job already finished', async () => {
    const { repository, service } = arrange(job('promptfoo'));
    repository.finishRunningJob.mockResolvedValue(false);
    await fs.writeFile(path.join(outputDir, 'promptfoo-summary.json'), JSON.stringify(promptfooSummary(0)));

    await expect(service.applyCompleted(
      completed('evaluation-promptfoo', ['promptfoo-summary.json']),
    )).resolves.toBe('skipped');
  });

  it('fails the job when its run failed', async () => {
    const { repository, service } = arrange(job('llm_judge'));

    await service.applyFailed({
      runId: 'run-1',
      threadId: `wfeval:${EVENT_ID}:llm_judge`,
      workflowClass: 'evaluation-judge',
      reason: 'Document generation failed on the durable transport.',
    });

    expect(repository.finishRunningJob).toHaveBeenCalledWith('job-llm_judge', 'run-1', {
      status: 'failed',
      summary: null,
      resultBlobRefs: null,
      errorDetail: 'run_failed: Document generation failed on the durable transport.',
    });
  });

  it('fails running jobs whose run finished more than 15 minutes ago or is gone', async () => {
    const { repository, service } = arrange(null);
    repository.listStalledRunningJobs.mockResolvedValue([
      job('promptfoo', { runId: 'run-1' }),
      job('llm_judge', { runId: null }),
    ]);
    repository.failStalledRunningJob
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await expect(service.failStalledRunningJobs()).resolves.toBe(1);

    expect(repository.listStalledRunningJobs).toHaveBeenCalledWith('2026-10-21T12:45:00.000Z', 50);
    expect(repository.failStalledRunningJob).toHaveBeenCalledWith(
      'job-promptfoo',
      'run-1',
      'result_not_applied: Run run-1 finished but its result was never applied',
    );
    expect(repository.failStalledRunningJob).toHaveBeenCalledWith(
      'job-llm_judge',
      null,
      'result_not_applied: The run for this job no longer exists',
    );
  });
});
