/**
 * Starts the two diagnostic jobs (Promptfoo and the LLM judge) for every
 * stored human evaluation, retries a failed one on request, and fails jobs
 * whose enqueue never finished.
 *
 * Both jobs run on the V2 document lane. Nothing here retries on its own:
 * a failed job stays failed until a person retries it.
 */
import type { AiRunV2DocumentSpecification } from '../../shared/types/aiRunV2DocumentSpec';
import {
  workflowEvaluationRunThreadId,
  type AiRunV2PromptfooSpecification,
} from '../../shared/types/aiRunV2EvaluationSpec';
import { WORKFLOW_HUMAN_EVALUATION_FLAG } from '../../shared/types/featureFlags';
import type {
  WorkflowEvaluationDefinition,
  WorkflowEvaluationEvent,
  WorkflowEvaluationJob,
  WorkflowEvaluationJobEvaluator,
} from '../../shared/types/workflowEvaluation';
import {
  createV2AdmissionService,
  type AdmitV2RunInput,
  type AdmitV2RunResult,
} from './aiRunV2/v2AdmissionService';
import { isFeatureEnabled } from './featureFlagService';
import {
  workflowEvaluationJobRepository,
  type WorkflowEvaluationJobRepository,
} from './workflowEvaluationJobRepository';
import { getDefinitionById } from './workflowEvaluationRepository';
import { getEvaluationEvent, registerEventStoredListener } from './workflowEvaluationService';
import {
  buildWorkflowEvaluationSpecifications,
  type BuiltWorkflowEvaluationSpecification,
  type WorkflowEvaluationSpecificationFailureCode,
} from './workflowEvaluationSpecificationBuilder';

const V2_TRANSPORT_FLAG = 'ai-runs-v2-transport';

export const WORKFLOW_EVALUATION_STALE_PENDING_MS = 5 * 60_000;
const STALE_SWEEP_BATCH_SIZE = 50;

/**
 * The document queue is shared with PRD and design-doc generation, so a job
 * may wait behind long runs before the worker starts its own deadline.
 */
const QUEUE_ALLOWANCE_MS = 30 * 60_000;

export type WorkflowEvaluationJobFailureCode =
  | WorkflowEvaluationSpecificationFailureCode
  | 'flag_disabled'
  | 'transport_disabled'
  | 'enqueue_failed'
  | 'enqueue_interrupted';

export function formatJobFailure(code: WorkflowEvaluationJobFailureCode, message: string): string {
  return `${code}: ${message}`;
}

export type JobEnqueueOutcome =
  | Readonly<{ status: 'dispatched'; runId: string }>
  | Readonly<{ status: 'failed'; code: WorkflowEvaluationJobFailureCode; message: string }>
  | Readonly<{ status: 'skipped' }>;

export type RetryJobResult =
  | Readonly<{ status: 'dispatched'; job: WorkflowEvaluationJob }>
  | Readonly<{ status: 'not_found' }>
  | Readonly<{ status: 'job_not_failed'; job: WorkflowEvaluationJob }>
  | Readonly<{
      status: 'failed';
      code: WorkflowEvaluationJobFailureCode;
      message: string;
      job: WorkflowEvaluationJob | null;
    }>;

type EventForJobs = Pick<
  WorkflowEvaluationEvent,
  | 'id'
  | 'projectId'
  | 'stageKey'
  | 'definitionId'
  | 'subjectType'
  | 'subjectId'
  | 'phaseIndex'
  | 'artifactContentHash'
  | 'criteria'
>;

type JobRepository = Pick<
  WorkflowEvaluationJobRepository,
  | 'createPendingJobs'
  | 'getJob'
  | 'claimPendingJob'
  | 'markJobRunning'
  | 'failJob'
  | 'failStalePendingJob'
  | 'listStalePendingJobs'
  | 'findRunOnThreadSince'
  | 'claimFailedJobForRetry'
>;

export type WorkflowEvaluationJobOrchestratorDependencies = Readonly<{
  repository?: JobRepository;
  loadDefinition?: (id: string) => Promise<WorkflowEvaluationDefinition | null>;
  loadEvent?: (projectId: string, eventId: string) => Promise<EventForJobs | null>;
  buildSpecifications?: typeof buildWorkflowEvaluationSpecifications;
  admit?: (input: AdmitV2RunInput) => Promise<AdmitV2RunResult>;
  isFlagEnabled?: (key: string, context: { userId: string; project: string; caller?: string }) => Promise<boolean>;
  now?: () => number;
}>;

type AnySpecification = AiRunV2PromptfooSpecification | AiRunV2DocumentSpecification;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function log(
  name: string,
  job: Pick<WorkflowEvaluationJob, 'id' | 'eventId' | 'evaluatorKey'>,
  projectId: string,
  extra: Record<string, string> = {},
): void {
  console.log(`[workflowEvaluation] ${name}`, {
    eventId: job.eventId,
    jobId: job.id,
    evaluatorKey: job.evaluatorKey,
    projectId,
    ...extra,
  });
}

/** Run header copy for the harvest (`workflowClass`) and usage (`model`, `skillPath`). */
function executionSnapshot(
  specification: AnySpecification,
  eventId: string,
  jobId: string,
): Record<string, unknown> {
  const base = {
    workflowClass: specification.workflowClass,
    projectId: specification.projectId,
    evaluationEventId: eventId,
    evaluationJobId: jobId,
  };
  return 'model' in specification
    ? { ...base, model: specification.model, skillPath: specification.skillPath }
    : base;
}

export function createWorkflowEvaluationJobOrchestrator(
  dependencies: WorkflowEvaluationJobOrchestratorDependencies = {},
) {
  const repository = dependencies.repository ?? workflowEvaluationJobRepository;
  const loadDefinition = dependencies.loadDefinition ?? getDefinitionById;
  const loadEvent = dependencies.loadEvent ?? getEvaluationEvent;
  const buildSpecifications = dependencies.buildSpecifications ?? buildWorkflowEvaluationSpecifications;
  const admit = dependencies.admit ?? ((input: AdmitV2RunInput) => createV2AdmissionService().admit(input));
  const isFlagEnabled = dependencies.isFlagEnabled ?? isFeatureEnabled;
  const now = dependencies.now ?? Date.now;

  async function fail(
    job: WorkflowEvaluationJob,
    projectId: string,
    code: WorkflowEvaluationJobFailureCode,
    message: string,
  ): Promise<JobEnqueueOutcome> {
    await repository.failJob(job.id, formatJobFailure(code, message), ['pending']);
    log('job_enqueue_failed', job, projectId, { code });
    return { status: 'failed', code, message };
  }

  async function checkFlags(
    projectId: string,
    userId: string,
  ): Promise<{ code: WorkflowEvaluationJobFailureCode; message: string } | null> {
    const context = { userId, project: projectId, caller: 'workflow-evaluation' };
    // The flag can change between submit and enqueue.
    // @feature-flag:workflow-human-evaluation start winner=enabled
    if (!await isFlagEnabled(WORKFLOW_HUMAN_EVALUATION_FLAG, context)) {
      // @feature-flag:workflow-human-evaluation disabled-start
      return { code: 'flag_disabled', message: 'Workflow human evaluation is turned off for this project.' };
      // @feature-flag:workflow-human-evaluation disabled-end
    }
    // @feature-flag:workflow-human-evaluation end
    // Diagnostic jobs have no V1 path.
    // @feature-flag:ai-runs-v2-transport start winner=enabled
    if (!await isFlagEnabled(V2_TRANSPORT_FLAG, context)) {
      // @feature-flag:ai-runs-v2-transport disabled-start
      return { code: 'transport_disabled', message: 'V2 run transport is turned off for this project.' };
      // @feature-flag:ai-runs-v2-transport disabled-end
    }
    // @feature-flag:ai-runs-v2-transport end
    return null;
  }

  async function enqueueJob(
    job: WorkflowEvaluationJob,
    projectId: string,
    built: BuiltWorkflowEvaluationSpecification<AnySpecification>,
  ): Promise<JobEnqueueOutcome> {
    if (!built.ok) return fail(job, projectId, built.code, built.message);
    if (!await repository.claimPendingJob(job.id, built.specificationHash)) {
      return { status: 'skipped' };
    }
    const { specification } = built;
    let admitted: AdmitV2RunResult;
    try {
      admitted = await admit({
        threadId: specification.threadId,
        projectId,
        workloadLane: 'document',
        capacityClass: 'batch',
        timeoutAt: new Date(now() + QUEUE_ALLOWANCE_MS + specification.deadlineMs).toISOString(),
        specification: specification as unknown as Record<string, unknown>,
        executionSnapshot: executionSnapshot(specification, job.eventId, job.id),
      });
    } catch (error) {
      return fail(job, projectId, 'enqueue_failed', errorMessage(error));
    }
    if (admitted.status === 'active_run_conflict') {
      return fail(
        job,
        projectId,
        'enqueue_failed',
        `Run ${admitted.existingRunId} is still active on this job's thread.`,
      );
    }
    await repository.markJobRunning(job.id, admitted.runId);
    log('job_enqueued', job, projectId, { runId: admitted.runId });
    return { status: 'dispatched', runId: admitted.runId };
  }

  async function enqueueJobs(
    event: EventForJobs,
    jobs: readonly WorkflowEvaluationJob[],
    userId: string,
  ): Promise<Map<WorkflowEvaluationJobEvaluator, JobEnqueueOutcome>> {
    const outcomes = new Map<WorkflowEvaluationJobEvaluator, JobEnqueueOutcome>();
    const pending = jobs.filter((job) => job.status === 'pending' && job.specificationHash === null);
    if (pending.length === 0) return outcomes;

    const blocked = await checkFlags(event.projectId, userId);
    if (blocked) {
      for (const job of pending) {
        outcomes.set(job.evaluatorKey, await fail(job, event.projectId, blocked.code, blocked.message));
      }
      return outcomes;
    }

    const definition = await loadDefinition(event.definitionId);
    if (!definition) {
      for (const job of pending) {
        outcomes.set(
          job.evaluatorKey,
          await fail(job, event.projectId, 'specification_invalid', 'The evaluation definition is missing.'),
        );
      }
      return outcomes;
    }

    const jobIds = Object.fromEntries(
      jobs.map((job) => [job.evaluatorKey, job.id]),
    ) as Record<WorkflowEvaluationJobEvaluator, string>;
    const specifications = await buildSpecifications({ event, definition, jobIds });

    const settled = await Promise.allSettled(
      pending.map(async (job) => {
        const outcome = await enqueueJob(job, event.projectId, specifications[job.evaluatorKey]);
        outcomes.set(job.evaluatorKey, outcome);
      }),
    );
    settled.forEach((result, index) => {
      if (result.status === 'rejected') {
        console.error(
          `[workflowEvaluation] enqueue threw (jobId=${pending[index].id})`,
          result.reason,
        );
      }
    });
    return outcomes;
  }

  return {
    /**
     * Runs inside the submit request, so it only inserts the job rows. Building
     * and admitting continue after the response.
     */
    async onEventStored(event: WorkflowEvaluationEvent): Promise<void> {
      const jobs = await repository.createPendingJobs(event.id);
      for (const job of jobs) log('job_created', job, event.projectId);
      void enqueueJobs(event, jobs, event.reviewerUserId).catch((error: unknown) => {
        console.error(`[workflowEvaluation] enqueue failed (eventId=${event.id})`, error);
      });
    },

    enqueueJobs,

    async retryJob(input: {
      projectId: string;
      eventId: string;
      evaluatorKey: WorkflowEvaluationJobEvaluator;
      userId: string;
    }): Promise<RetryJobResult> {
      const event = await loadEvent(input.projectId, input.eventId);
      if (!event) return { status: 'not_found' };

      const claimed = await repository.claimFailedJobForRetry(input.eventId, input.evaluatorKey);
      if (!claimed) {
        const existing = await repository.getJob(input.eventId, input.evaluatorKey);
        return existing ? { status: 'job_not_failed', job: existing } : { status: 'not_found' };
      }
      log('job_retried', claimed, input.projectId);

      const outcomes = await enqueueJobs(event, [claimed], input.userId);
      const outcome = outcomes.get(input.evaluatorKey);
      const job = await repository.getJob(input.eventId, input.evaluatorKey);
      if (outcome?.status === 'failed') {
        return { status: 'failed', code: outcome.code, message: outcome.message, job };
      }
      if (!job) return { status: 'not_found' };
      return { status: 'dispatched', job };
    },

    /**
     * A crash between commit and admission leaves a job pending forever.
     * Attach the run if admission did finish; otherwise fail the job. Never
     * enqueues: manual retry is the only retry path.
     */
    async failStalePendingJobs(): Promise<number> {
      const cutoff = new Date(now() - WORKFLOW_EVALUATION_STALE_PENDING_MS).toISOString();
      const stale = await repository.listStalePendingJobs(cutoff, STALE_SWEEP_BATCH_SIZE);
      let failed = 0;
      for (const job of stale) {
        const threadId = workflowEvaluationRunThreadId(job.eventId, job.evaluatorKey);
        const runId = await repository.findRunOnThreadSince(threadId, job.updatedAt);
        if (runId) {
          if (await repository.markJobRunning(job.id, runId)) {
            console.log('[workflowEvaluation] job_stale_attached', { jobId: job.id, runId });
          }
          continue;
        }
        const detail = formatJobFailure(
          'enqueue_interrupted',
          'The job was never queued. Retry it to run again.',
        );
        if (await repository.failStalePendingJob(job.id, cutoff, detail)) {
          failed += 1;
          console.log('[workflowEvaluation] job_stale_failed', {
            jobId: job.id,
            eventId: job.eventId,
            evaluatorKey: job.evaluatorKey,
            threadId,
          });
        }
      }
      return failed;
    },
  };
}

export type WorkflowEvaluationJobOrchestrator = ReturnType<typeof createWorkflowEvaluationJobOrchestrator>;

let registered = false;

/** Called by the reviewer router at load; later calls do nothing. */
export function registerWorkflowEvaluationJobListener(
  orchestrator: WorkflowEvaluationJobOrchestrator = createWorkflowEvaluationJobOrchestrator(),
): void {
  if (registered) return;
  registered = true;
  registerEventStoredListener((event) => orchestrator.onEventStored(event));
}
