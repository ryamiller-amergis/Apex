import type { AdmitV2RunInput, AdmitV2RunResult } from '../services/aiRunV2/v2AdmissionService';
import type {
  WorkflowEvaluationDefinition,
  WorkflowEvaluationEvent,
  WorkflowEvaluationJob,
  WorkflowEvaluationJobEvaluator,
} from '../../shared/types/workflowEvaluation';
import {
  createWorkflowEvaluationJobOrchestrator,
  WORKFLOW_EVALUATION_STALE_PENDING_MS,
  type WorkflowEvaluationJobOrchestratorDependencies,
} from '../services/workflowEvaluationJobOrchestrator';
import type { WorkflowEvaluationSpecifications } from '../services/workflowEvaluationSpecificationBuilder';

jest.mock('../db/drizzle', () => ({ db: {} }));
jest.mock('../services/workflowEvaluationService', () => ({
  getEvaluationEvent: jest.fn(),
  registerEventStoredListener: jest.fn(),
}));
jest.mock('../services/workflowEvaluationRepository', () => ({ getDefinitionById: jest.fn() }));
jest.mock('../services/featureFlagService', () => ({ isFeatureEnabled: jest.fn() }));
jest.mock('../services/prdService', () => ({ getPrdEvaluationInputs: jest.fn() }));
jest.mock('../services/interviewService', () => ({ getInterviewEvaluationInputs: jest.fn() }));
jest.mock('../services/projectSettingsService', () => ({ resolveSkillConfig: jest.fn() }));
jest.mock('../services/appSettingsService', () => ({ getDefaultModel: jest.fn() }));

const NOW = Date.parse('2026-10-21T12:00:00.000Z');

const event = {
  id: 'event-1',
  projectId: 'Apex',
  processKey: 'orchestrated_workflow',
  stageKey: 'prd_human_review',
  definitionId: 'def-1',
  definitionVersion: 1,
  subjectType: 'prd',
  subjectId: 'prd-1',
  phaseIndex: null,
  reviewerUserId: 'reviewer-1',
  reviewerName: 'Ada',
  reviewerRoleKey: 'product_owner',
  reviewerRoleLabel: 'Product owner',
  lineage: { skillPath: null, skillVersion: null, model: null, interviewId: null, prdId: 'prd-1' },
  artifactContentHash: 'a'.repeat(64),
  criteria: {
    intent_alignment: 4,
    requirements_coverage: 2,
    scope_alignment: 3,
    acceptance_criteria: 3,
    readiness: 2,
  },
  outcome: 'accept_unchanged',
  reasonCodes: [],
  comment: 'Private comment',
  hasCorrectedArtifact: false,
  createdAt: '2026-10-21T11:59:00.000Z',
} as unknown as WorkflowEvaluationEvent;

const definition = { id: 'def-1', version: 1 } as unknown as WorkflowEvaluationDefinition;

function job(
  evaluatorKey: WorkflowEvaluationJobEvaluator,
  overrides: Partial<WorkflowEvaluationJob> = {},
): WorkflowEvaluationJob {
  return {
    id: `job-${evaluatorKey}`,
    eventId: 'event-1',
    evaluatorKey,
    status: 'pending',
    runId: null,
    specificationHash: null,
    summary: null,
    resultBlobRefs: null,
    errorDetail: null,
    createdAt: '2026-10-21T11:59:00.000Z',
    updatedAt: '2026-10-21T11:59:00.000Z',
    ...overrides,
  };
}

function specifications(
  overrides: Partial<WorkflowEvaluationSpecifications> = {},
): WorkflowEvaluationSpecifications {
  return {
    promptfoo: {
      ok: true,
      specificationHash: 'p'.repeat(64),
      specification: {
        workflowClass: 'evaluation-promptfoo',
        projectId: 'Apex',
        threadId: 'wfeval:event-1:promptfoo',
        deadlineMs: 300_000,
      } as never,
    },
    llm_judge: {
      ok: true,
      specificationHash: 'j'.repeat(64),
      specification: {
        workflowClass: 'evaluation-judge',
        projectId: 'Apex',
        threadId: 'wfeval:event-1:llm_judge',
        deadlineMs: 900_000,
        model: 'claude-4-opus',
        skillPath: 'apex/workflow-evaluation-judge@1',
      } as never,
    },
    ...overrides,
  };
}

function repository() {
  return {
    createPendingJobs: jest.fn(async () => [job('llm_judge'), job('promptfoo')]),
    getJob: jest.fn(async (_eventId: string, evaluatorKey: WorkflowEvaluationJobEvaluator) => job(evaluatorKey)),
    claimPendingJob: jest.fn(async () => true),
    markJobRunning: jest.fn(async () => true),
    failJob: jest.fn(async () => true),
    failStalePendingJob: jest.fn(async () => true),
    listStalePendingJobs: jest.fn(async () => [] as WorkflowEvaluationJob[]),
    findRunOnThreadSince: jest.fn(async (_threadId: string, _since: string) => null as string | null),
    claimFailedJobForRetry: jest.fn(async () => null as WorkflowEvaluationJob | null),
  };
}

function setup(overrides: Partial<WorkflowEvaluationJobOrchestratorDependencies> = {}) {
  const repo = repository();
  const admit = jest.fn(async (input: AdmitV2RunInput): Promise<AdmitV2RunResult> => ({
    status: 'dispatched',
    runId: `run-${input.threadId.split(':')[2]}`,
    attemptId: 'attempt-1',
    attemptNumber: 1,
    dispatchMessageId: 'dispatch-1',
    outboxId: null,
  }));
  const buildSpecifications = jest.fn(async () => specifications());
  const isFlagEnabled = jest.fn(async () => true);
  const orchestrator = createWorkflowEvaluationJobOrchestrator({
    repository: repo,
    loadDefinition: async () => definition,
    loadEvent: async () => event,
    buildSpecifications,
    admit,
    isFlagEnabled,
    now: () => NOW,
    ...overrides,
  });
  return { orchestrator, repo, admit, buildSpecifications, isFlagEnabled };
}

describe('workflow evaluation job orchestrator', () => {
  it('inserts the job pair inside the request and admits after it returns', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { orchestrator, repo, admit } = setup({
      buildSpecifications: jest.fn(async () => {
        await gate;
        return specifications();
      }),
    });

    await orchestrator.onEventStored(event);

    expect(repo.createPendingJobs).toHaveBeenCalledWith('event-1');
    expect(admit).not.toHaveBeenCalled();
    release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(admit).toHaveBeenCalledTimes(2);
    expect(repo.markJobRunning).toHaveBeenCalledTimes(2);
  });

  it('admits each job on its own thread, claiming it before admission and storing the run id after', async () => {
    const { orchestrator, repo, admit, buildSpecifications } = setup();

    const outcomes = await orchestrator.enqueueJobs(event, [job('llm_judge'), job('promptfoo')], 'reviewer-1');

    expect(buildSpecifications).toHaveBeenCalledWith({
      event,
      definition,
      jobIds: { llm_judge: 'job-llm_judge', promptfoo: 'job-promptfoo' },
    });
    expect(admit).toHaveBeenCalledTimes(2);
    const judge = admit.mock.calls.find(([input]) => input.threadId === 'wfeval:event-1:llm_judge')?.[0];
    const promptfoo = admit.mock.calls.find(([input]) => input.threadId === 'wfeval:event-1:promptfoo')?.[0];
    expect(judge).toMatchObject({
      projectId: 'Apex',
      workloadLane: 'document',
      capacityClass: 'batch',
      timeoutAt: new Date(NOW + 30 * 60_000 + 900_000).toISOString(),
      executionSnapshot: {
        workflowClass: 'evaluation-judge',
        projectId: 'Apex',
        evaluationEventId: 'event-1',
        evaluationJobId: 'job-llm_judge',
        model: 'claude-4-opus',
        skillPath: 'apex/workflow-evaluation-judge@1',
      },
    });
    expect(promptfoo?.executionSnapshot).toEqual({
      workflowClass: 'evaluation-promptfoo',
      projectId: 'Apex',
      evaluationEventId: 'event-1',
      evaluationJobId: 'job-promptfoo',
    });
    expect(repo.claimPendingJob).toHaveBeenCalledWith('job-llm_judge', 'j'.repeat(64));
    expect(repo.claimPendingJob.mock.invocationCallOrder[0]).toBeLessThan(admit.mock.invocationCallOrder[0]);
    expect(repo.markJobRunning).toHaveBeenCalledWith('job-llm_judge', 'run-llm_judge');
    expect(repo.markJobRunning).toHaveBeenCalledWith('job-promptfoo', 'run-promptfoo');
    expect(outcomes.get('promptfoo')).toEqual({ status: 'dispatched', runId: 'run-promptfoo' });
  });

  it('fails only the job whose admission throws', async () => {
    const { orchestrator, repo } = setup({
      admit: jest.fn(async (input: AdmitV2RunInput): Promise<AdmitV2RunResult> => {
        if (input.threadId.endsWith('llm_judge')) throw new Error('blob store unavailable');
        return {
          status: 'dispatched',
          runId: 'run-promptfoo',
          attemptId: 'a',
          attemptNumber: 1,
          dispatchMessageId: 'd',
          outboxId: null,
        };
      }),
    });

    const outcomes = await orchestrator.enqueueJobs(event, [job('llm_judge'), job('promptfoo')], 'reviewer-1');

    expect(repo.failJob).toHaveBeenCalledWith(
      'job-llm_judge',
      'enqueue_failed: blob store unavailable',
      ['pending'],
    );
    expect(repo.markJobRunning).toHaveBeenCalledWith('job-promptfoo', 'run-promptfoo');
    expect(outcomes.get('llm_judge')).toMatchObject({ status: 'failed', code: 'enqueue_failed' });
  });

  it('fails a job with enqueue_failed when another run is still active on its thread', async () => {
    const { orchestrator, repo } = setup({
      admit: jest.fn(async (): Promise<AdmitV2RunResult> => ({
        status: 'active_run_conflict',
        existingRunId: 'run-old',
        existingTransportVersion: 'v2',
        existingStatus: 'running',
      })),
    });

    await orchestrator.enqueueJobs(event, [job('promptfoo')], 'reviewer-1');

    expect(repo.failJob).toHaveBeenCalledWith(
      'job-promptfoo',
      expect.stringContaining('enqueue_failed: Run run-old'),
      ['pending'],
    );
    expect(repo.markJobRunning).not.toHaveBeenCalled();
  });

  it('stores the builder failure code on the job it belongs to and still admits the other', async () => {
    const { orchestrator, repo, admit } = setup({
      buildSpecifications: jest.fn(async () => specifications({
        llm_judge: { ok: false, code: 'skill_config_missing', message: 'No skill config.' },
      })),
    });

    await orchestrator.enqueueJobs(event, [job('llm_judge'), job('promptfoo')], 'reviewer-1');

    expect(repo.failJob).toHaveBeenCalledWith(
      'job-llm_judge',
      'skill_config_missing: No skill config.',
      ['pending'],
    );
    expect(admit).toHaveBeenCalledTimes(1);
    expect(admit.mock.calls[0][0].threadId).toBe('wfeval:event-1:promptfoo');
  });

  it.each([
    ['workflow-human-evaluation', 'flag_disabled'],
    ['ai-runs-v2-transport', 'transport_disabled'],
  ])('fails both jobs without admitting when %s is off', async (flag, code) => {
    const { orchestrator, repo, admit, buildSpecifications } = setup({
      isFlagEnabled: jest.fn(async (key: string) => key !== flag),
    });

    await orchestrator.enqueueJobs(event, [job('llm_judge'), job('promptfoo')], 'reviewer-1');

    expect(admit).not.toHaveBeenCalled();
    expect(buildSpecifications).not.toHaveBeenCalled();
    expect(repo.failJob).toHaveBeenCalledTimes(2);
    for (const [, detail] of repo.failJob.mock.calls as unknown as Array<[string, string]>) {
      expect(detail.startsWith(`${code}:`)).toBe(true);
    }
  });

  it('fails both jobs with specification_invalid when the definition is missing', async () => {
    const { orchestrator, repo, admit } = setup({ loadDefinition: async () => null });

    await orchestrator.enqueueJobs(event, [job('llm_judge'), job('promptfoo')], 'reviewer-1');

    expect(admit).not.toHaveBeenCalled();
    expect(repo.failJob).toHaveBeenCalledWith(
      'job-promptfoo',
      expect.stringMatching(/^specification_invalid:/),
      ['pending'],
    );
  });

  it('does not admit a job another caller already claimed, nor a job that is not pending', async () => {
    const { orchestrator, repo, admit } = setup();
    repo.claimPendingJob.mockResolvedValueOnce(false);

    await orchestrator.enqueueJobs(
      event,
      [job('llm_judge'), job('promptfoo', { status: 'ready' })],
      'reviewer-1',
    );

    expect(repo.claimPendingJob).toHaveBeenCalledTimes(1);
    expect(admit).not.toHaveBeenCalled();
  });

  describe('retryJob', () => {
    const input = { projectId: 'Apex', eventId: 'event-1', evaluatorKey: 'llm_judge' as const, userId: 'admin-1' };

    it('returns not_found when the event is not in the project', async () => {
      const { orchestrator, repo } = setup({ loadEvent: async () => null });
      await expect(orchestrator.retryJob(input)).resolves.toEqual({ status: 'not_found' });
      expect(repo.claimFailedJobForRetry).not.toHaveBeenCalled();
    });

    it('returns job_not_failed when the job is not failed', async () => {
      const { orchestrator, admit } = setup();
      await expect(orchestrator.retryJob(input)).resolves.toMatchObject({
        status: 'job_not_failed',
        job: { id: 'job-llm_judge' },
      });
      expect(admit).not.toHaveBeenCalled();
    });

    it('re-admits a failed job with the retrying user\'s flags and returns its new state', async () => {
      const { orchestrator, repo, admit, isFlagEnabled } = setup();
      repo.claimFailedJobForRetry.mockResolvedValue(job('llm_judge'));
      repo.getJob.mockResolvedValue(job('llm_judge', { status: 'running', runId: 'run-llm_judge' }));

      const result = await orchestrator.retryJob(input);

      expect(result).toEqual({
        status: 'dispatched',
        job: expect.objectContaining({ status: 'running', runId: 'run-llm_judge' }),
      });
      expect(admit).toHaveBeenCalledTimes(1);
      expect(isFlagEnabled).toHaveBeenCalledWith(
        'workflow-human-evaluation',
        expect.objectContaining({ userId: 'admin-1', project: 'Apex' }),
      );
    });

    it('reports artifact_changed and leaves the job failed when the artifact was edited', async () => {
      const { orchestrator, repo, admit } = setup({
        buildSpecifications: jest.fn(async () => specifications({
          llm_judge: { ok: false, code: 'artifact_changed', message: 'The PRD changed.' },
        })),
      });
      repo.claimFailedJobForRetry.mockResolvedValue(job('llm_judge'));

      await expect(orchestrator.retryJob(input)).resolves.toMatchObject({
        status: 'failed',
        code: 'artifact_changed',
      });
      expect(admit).not.toHaveBeenCalled();
      expect(repo.failJob).toHaveBeenCalledWith(
        'job-llm_judge',
        'artifact_changed: The PRD changed.',
        ['pending'],
      );
    });
  });

  describe('failStalePendingJobs', () => {
    const cutoff = new Date(NOW - WORKFLOW_EVALUATION_STALE_PENDING_MS).toISOString();

    it('fails stale jobs with no run and attaches the run when admission did finish', async () => {
      const { orchestrator, repo, admit } = setup();
      repo.listStalePendingJobs.mockResolvedValue([job('llm_judge'), job('promptfoo')]);
      repo.findRunOnThreadSince.mockImplementation(async (threadId: string) =>
        (threadId === 'wfeval:event-1:promptfoo' ? 'run-promptfoo' : null));

      await expect(orchestrator.failStalePendingJobs()).resolves.toBe(1);

      expect(repo.listStalePendingJobs).toHaveBeenCalledWith(cutoff, 50);
      expect(repo.findRunOnThreadSince).toHaveBeenCalledWith(
        'wfeval:event-1:llm_judge',
        '2026-10-21T11:59:00.000Z',
      );
      expect(repo.failStalePendingJob).toHaveBeenCalledWith(
        'job-llm_judge',
        cutoff,
        expect.stringMatching(/^enqueue_interrupted:/),
      );
      expect(repo.markJobRunning).toHaveBeenCalledWith('job-promptfoo', 'run-promptfoo');
      expect(admit).not.toHaveBeenCalled();
    });

    it('does not count a job a retry touched after the sweep listed it', async () => {
      const { orchestrator, repo } = setup();
      repo.listStalePendingJobs.mockResolvedValue([job('llm_judge')]);
      repo.failStalePendingJob.mockResolvedValue(false);

      await expect(orchestrator.failStalePendingJobs()).resolves.toBe(0);
    });
  });
});
