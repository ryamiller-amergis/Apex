/**
 * Writes finished workflow evaluation runs onto their jobs. The document
 * harvest calls it once per finished attempt, after the artifacts are verified
 * and written to a local workspace.
 *
 * A result applies only while its run still owns the running job, so a late
 * result from a run that a retry replaced changes nothing.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { AiRunBlobRef, AiRunV2ArtifactManifest } from '../../shared/types/aiRunV2';
import {
  JUDGE_APPENDIX_FILE,
  JUDGE_RESULT_FILE,
  PROMPTFOO_RESULTS_FILE,
  PROMPTFOO_SUMMARY_FILE,
  parseWorkflowEvaluationRunThreadId,
} from '../../shared/types/aiRunV2EvaluationSpec';
import type {
  WorkflowEvaluationJob,
  WorkflowEvaluationJobEvaluator,
  WorkflowEvaluationJobResultBlobRefs,
} from '../../shared/types/workflowEvaluation';
import { checkJudgeOutput } from './workflowEvaluationJudgeOutput';
import {
  workflowEvaluationJobRepository,
  type FinishedJobFields,
  type WorkflowEvaluationJobRepository,
} from './workflowEvaluationJobRepository';

export type WorkflowEvaluationRunClass = 'evaluation-promptfoo' | 'evaluation-judge';

export type WorkflowEvaluationIngestFailureCode =
  | 'run_failed'
  | 'assertions_failed'
  | 'result_invalid';

export type EvaluationRunReference = Readonly<{
  runId: string;
  threadId: string;
  workflowClass: WorkflowEvaluationRunClass;
}>;

export type CompletedEvaluationRun = EvaluationRunReference & Readonly<{
  outputDir: string;
  manifest: AiRunV2ArtifactManifest;
}>;

export type FailedEvaluationRun = EvaluationRunReference & Readonly<{
  reason: string;
}>;

export type IngestOutcome = 'applied' | 'skipped';

type IngestRepository = Pick<
  WorkflowEvaluationJobRepository,
  'getJob' | 'finishRunningJob' | 'getJudgeOutputSchema'
>;

export type WorkflowEvaluationJobIngestDependencies = Readonly<{
  repository?: IngestRepository;
}>;

const EVALUATOR_BY_CLASS: Record<WorkflowEvaluationRunClass, WorkflowEvaluationJobEvaluator> = {
  'evaluation-promptfoo': 'promptfoo',
  'evaluation-judge': 'llm_judge',
};

const OUTPUT_FILES: Record<WorkflowEvaluationRunClass, Readonly<{ output: string; appendix: string }>> = {
  'evaluation-promptfoo': { output: PROMPTFOO_SUMMARY_FILE, appendix: PROMPTFOO_RESULTS_FILE },
  'evaluation-judge': { output: JUDGE_RESULT_FILE, appendix: JUDGE_APPENDIX_FILE },
};

function formatIngestFailure(code: WorkflowEvaluationIngestFailureCode, message: string): string {
  return `${code}: ${message}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

type PromptfooSummaryShape = Record<string, unknown> & Readonly<{
  passed: boolean;
  totals: Readonly<{ tests: number; failed: number }>;
}>;

function parsePromptfooSummary(text: string): PromptfooSummaryShape | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.passed !== 'boolean') return null;
  if (!Array.isArray(parsed.failures) || !isRecord(parsed.totals)) return null;
  const { tests, passed, failed } = parsed.totals;
  if (!isCount(tests) || !isCount(passed) || !isCount(failed)) return null;
  return parsed as PromptfooSummaryShape;
}

function resultBlobRefs(
  workflowClass: WorkflowEvaluationRunClass,
  manifest: AiRunV2ArtifactManifest,
): WorkflowEvaluationJobResultBlobRefs {
  const refFor = (name: string): AiRunBlobRef | undefined =>
    manifest.files.find((entry) => entry.path === `output/${name}`)?.ref;
  const files = OUTPUT_FILES[workflowClass];
  const refs: { output?: AiRunBlobRef; appendix?: AiRunBlobRef } = {};
  const output = refFor(files.output);
  const appendix = refFor(files.appendix);
  if (output) refs.output = output;
  if (appendix) refs.appendix = appendix;
  return refs;
}

async function readOutput(outputDir: string, name: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(outputDir, name), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function failed(code: WorkflowEvaluationIngestFailureCode, message: string): Pick<
  FinishedJobFields,
  'status' | 'summary' | 'errorDetail'
> {
  return { status: 'failed', summary: null, errorDetail: formatIngestFailure(code, message) };
}

export function createWorkflowEvaluationJobIngestService(
  dependencies: WorkflowEvaluationJobIngestDependencies = {},
) {
  const repository = dependencies.repository ?? workflowEvaluationJobRepository;

  async function findOwnedJob(run: EvaluationRunReference): Promise<WorkflowEvaluationJob | null> {
    const identity = parseWorkflowEvaluationRunThreadId(run.threadId);
    if (!identity || identity.evaluatorKey !== EVALUATOR_BY_CLASS[run.workflowClass]) {
      console.warn(
        `[workflowEvaluationJobIngest] Run ${run.runId} on thread ${run.threadId} `
          + `does not name a ${run.workflowClass} job; nothing to apply.`,
      );
      return null;
    }
    const job = await repository.getJob(identity.eventId, identity.evaluatorKey);
    if (!job || job.runId !== run.runId) {
      console.info(
        `[workflowEvaluationJobIngest] Run ${run.runId} no longer owns job `
          + `${identity.eventId}/${identity.evaluatorKey}; result ignored.`,
      );
      return null;
    }
    return job;
  }

  async function finish(
    job: WorkflowEvaluationJob,
    runId: string,
    fields: FinishedJobFields,
  ): Promise<IngestOutcome> {
    return (await repository.finishRunningJob(job.id, runId, fields)) ? 'applied' : 'skipped';
  }

  async function promptfooFields(
    run: CompletedEvaluationRun,
  ): Promise<Pick<FinishedJobFields, 'status' | 'summary' | 'errorDetail'>> {
    const text = await readOutput(run.outputDir, PROMPTFOO_SUMMARY_FILE);
    const summary = text === null ? null : parsePromptfooSummary(text);
    if (!summary) {
      return failed('result_invalid', 'The Promptfoo summary is missing or not in the expected shape');
    }
    if (!summary.passed) {
      return {
        status: 'failed',
        summary,
        errorDetail: formatIngestFailure(
          'assertions_failed',
          `${summary.totals.failed} of ${summary.totals.tests} Promptfoo tests failed`,
        ),
      };
    }
    return { status: 'ready', summary, errorDetail: null };
  }

  async function judgeFields(
    run: CompletedEvaluationRun,
    job: WorkflowEvaluationJob,
  ): Promise<Pick<FinishedJobFields, 'status' | 'summary' | 'errorDetail'>> {
    const text = await readOutput(run.outputDir, JUDGE_RESULT_FILE);
    if (text === null) return failed('result_invalid', 'The judge result file is missing');
    const schema = await repository.getJudgeOutputSchema(job.eventId);
    if (!schema) return failed('result_invalid', 'The evaluation definition has no judge output schema');
    const check = checkJudgeOutput(text, schema);
    if (!check.ok) {
      return failed(
        'result_invalid',
        `Judge output does not match the output schema: ${check.errors.join('; ')}`,
      );
    }
    return { status: 'ready', summary: check.output, errorDetail: null };
  }

  return {
    async applyCompleted(run: CompletedEvaluationRun): Promise<IngestOutcome> {
      const job = await findOwnedJob(run);
      if (!job) return 'skipped';
      let fields: Pick<FinishedJobFields, 'status' | 'summary' | 'errorDetail'>;
      switch (run.workflowClass) {
        case 'evaluation-promptfoo':
          fields = await promptfooFields(run);
          break;
        case 'evaluation-judge':
          fields = await judgeFields(run, job);
          break;
        default: {
          const unhandled: never = run.workflowClass;
          throw new Error(`Unsupported evaluation workflow: ${String(unhandled)}`);
        }
      }
      return finish(job, run.runId, {
        ...fields,
        resultBlobRefs: resultBlobRefs(run.workflowClass, run.manifest),
      });
    },

    async applyFailed(run: FailedEvaluationRun): Promise<IngestOutcome> {
      const job = await findOwnedJob(run);
      if (!job) return 'skipped';
      return finish(job, run.runId, {
        ...failed('run_failed', run.reason),
        resultBlobRefs: null,
      });
    },
  };
}

export type WorkflowEvaluationJobIngestService = ReturnType<
  typeof createWorkflowEvaluationJobIngestService
>;
