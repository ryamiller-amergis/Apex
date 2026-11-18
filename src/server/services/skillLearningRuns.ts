/**
 * Skill Learning AI work runs on the V2 document worker as `skill-learning` runs. App Service
 * builds the inputs, instructions and result schema here, admits the run, and the document
 * harvest hands the checked result back (see skillLearningHarvest.ts).
 */
import { createHash } from 'node:crypto';
import {
  SKILL_LEARNING_RESULT_FILE,
  SKILL_LEARNING_SCRATCH_PATHS,
  type AiRunV2DocumentSpecification,
} from '../../shared/types/aiRunV2DocumentSpec';
import { createV2AdmissionService } from './aiRunV2/v2AdmissionService';
import { getDefaultModel } from './appSettingsService';
import { resolveSkillConfig } from './projectSettingsService';
import { resolveEvaluationJudgeModel } from './workflowEvaluationJudgeModel';

export const SKILL_LEARNING_TASKS = ['candidate', 'artifact_judge', 'check_mining'] as const;
export type SkillLearningTask = (typeof SKILL_LEARNING_TASKS)[number];

const THREAD_PREFIX = 'skill-learning:';
const DEFAULT_DEADLINE_MS = 15 * 60_000;
const QUEUE_ALLOWANCE_MS = 30 * 60_000;

export function skillLearningThreadId(task: SkillLearningTask, subjectKey: string): string {
  return `${THREAD_PREFIX}${task}:${subjectKey}`;
}

/** The subject key may itself contain colons. */
export function parseSkillLearningThreadId(threadId: string): { task: SkillLearningTask; subjectKey: string } | null {
  if (!threadId.startsWith(THREAD_PREFIX)) return null;
  const rest = threadId.slice(THREAD_PREFIX.length);
  const split = rest.indexOf(':');
  if (split <= 0) return null;
  const task = rest.slice(0, split);
  const subjectKey = rest.slice(split + 1);
  if (!subjectKey || !(SKILL_LEARNING_TASKS as readonly string[]).includes(task)) return null;
  return { task: task as SkillLearningTask, subjectKey };
}

export class SkillLearningRunConflict extends Error {
  constructor(readonly existingRunId: string) {
    super(`Run ${existingRunId} is still active on this thread.`);
    this.name = 'SkillLearningRunConflict';
  }
}

export interface SkillLearningRunRequest {
  project: string;
  task: SkillLearningTask;
  subjectKey: string;
  /** Versioned name of the frozen instructions, e.g. `apex/skill-learning-candidate@1`. */
  skillPath: string;
  instructions: string;
  input: unknown;
  outputSchema: Record<string, unknown>;
  deadlineMs?: number;
  /** Kept on the run's execution snapshot for the harvest; never sent to the agent. */
  context?: Record<string, unknown>;
}

const PROMPT = [
  'Follow the skill. Read `.ai-pilot/skill-learning/input.json` and `.ai-pilot/skill-learning/output-schema.json`.',
  `Write exactly one file: \`.ai-pilot/output/${SKILL_LEARNING_RESULT_FILE}\`, a JSON object that matches the schema.`,
].join('\n');

export async function buildSkillLearningSpecification(
  request: SkillLearningRunRequest,
): Promise<AiRunV2DocumentSpecification> {
  const skillConfig = await resolveSkillConfig({ project: request.project });
  if (!skillConfig) throw new Error(`Project ${request.project} has no skill configuration to resolve a model.`);
  const { model, effort } = await resolveEvaluationJudgeModel(request.project, skillConfig, getDefaultModel);
  return {
    workloadLane: 'document',
    prompt: PROMPT,
    model,
    effort,
    skillPath: request.skillPath,
    skillContent: request.instructions,
    skillSha256: createHash('sha256').update(request.instructions, 'utf8').digest('hex'),
    workflowClass: 'skill-learning',
    projectId: request.project,
    threadId: skillLearningThreadId(request.task, request.subjectKey),
    deadlineMs: request.deadlineMs ?? DEFAULT_DEADLINE_MS,
    scratchInputs: [
      { path: SKILL_LEARNING_SCRATCH_PATHS.input, content: JSON.stringify(request.input, null, 2) },
      { path: SKILL_LEARNING_SCRATCH_PATHS.outputSchema, content: JSON.stringify(request.outputSchema, null, 2) },
    ],
    outputSchema: request.outputSchema,
  };
}

/** Returns the agent run id; throws SkillLearningRunConflict when the thread already has an active run. */
export async function admitSkillLearningRun(request: SkillLearningRunRequest): Promise<string> {
  const specification = await buildSkillLearningSpecification(request);
  const admitted = await createV2AdmissionService().admit({
    threadId: specification.threadId,
    projectId: request.project,
    workloadLane: 'document',
    capacityClass: 'batch',
    timeoutAt: new Date(Date.now() + QUEUE_ALLOWANCE_MS + specification.deadlineMs).toISOString(),
    specification: specification as unknown as Record<string, unknown>,
    executionSnapshot: {
      workflowClass: specification.workflowClass,
      projectId: request.project,
      model: specification.model,
      skillPath: specification.skillPath,
      skillLearningTask: request.task,
      ...(request.context ? { skillLearningContext: request.context } : {}),
    },
  });
  if (admitted.status !== 'dispatched') throw new SkillLearningRunConflict(admitted.existingRunId);
  return admitted.runId;
}
