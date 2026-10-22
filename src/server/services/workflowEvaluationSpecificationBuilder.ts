/**
 * Builds the execution specifications for the two diagnostic jobs a stored
 * human evaluation starts: a Promptfoo suite and an LLM judge.
 *
 * A V2 worker holds no policy, so everything it uses is resolved here: the
 * artifact package, the suite, the judge instructions, model and effort. The
 * artifact is re-read and re-hashed, so a job never judges an edit made after
 * the person submitted.
 */
import { createHash } from 'node:crypto';
import {
  isAiRunV2DocumentSpecification,
  type AiRunV2DocumentSpecification,
} from '../../shared/types/aiRunV2DocumentSpec';
import {
  AI_RUN_V2_EVALUATION_SPEC_VERSION,
  isAiRunV2PromptfooSpecification,
  WORKFLOW_EVALUATION_PACKAGE_MAX_BYTES,
  WORKFLOW_EVALUATION_SCRATCH_PATHS,
  workflowEvaluationRunThreadId,
  type AiRunV2PromptfooSpecification,
  type WorkflowEvaluationArtifactPackage,
  type WorkflowEvaluationRunIdentity,
  type WorkflowEvaluationTranscriptMessage,
} from '../../shared/types/aiRunV2EvaluationSpec';
import type { ProjectSkillConfig } from '../../shared/types/projectSettings';
import type {
  WorkflowEvaluationDefinition,
  WorkflowEvaluationEvent,
  WorkflowEvaluationJobEvaluator,
} from '../../shared/types/workflowEvaluation';
import { getDefaultModel } from './appSettingsService';
import { resolveEvaluationJudgeModel } from './workflowEvaluationJudgeModel';
import {
  hashDesignDocArtifact,
  hashInterviewPhaseArtifact,
  hashPrdArtifact,
  type DesignDocArtifactParts,
} from './artifactBindingResolver';
import { getDesignDocEvaluationInputs, type DesignDocEvaluationInputs } from './designDocService';
import { getInterviewEvaluationInputs, type InterviewEvaluationInputs } from './interviewService';
import { getPrdEvaluationInputs, type PrdEvaluationInputs } from './prdService';
import { resolveSkillConfig } from './projectSettingsService';
import {
  WORKFLOW_EVALUATION_JUDGE_INSTRUCTIONS,
  WORKFLOW_EVALUATION_JUDGE_PROMPT,
  WORKFLOW_EVALUATION_JUDGE_SKILL_PATH,
} from './workflowEvaluationJudgeInstructions';
import { getWorkflowEvaluationSuite } from './workflowEvaluationSuites';

export const WORKFLOW_EVALUATION_JUDGE_DEADLINE_MS = 15 * 60_000;
export const WORKFLOW_EVALUATION_PROMPTFOO_DEADLINE_MS = 5 * 60_000;

export type WorkflowEvaluationSpecificationFailureCode =
  | 'artifact_unavailable'
  | 'artifact_changed'
  | 'suite_missing'
  | 'skill_config_missing'
  | 'specification_invalid';

export class WorkflowEvaluationSpecificationError extends Error {
  constructor(
    readonly code: WorkflowEvaluationSpecificationFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkflowEvaluationSpecificationError';
  }
}

export type WorkflowEvaluationSpecificationRequest = Readonly<{
  event: Pick<
    WorkflowEvaluationEvent,
    | 'id'
    | 'projectId'
    | 'stageKey'
    | 'subjectType'
    | 'subjectId'
    | 'phaseIndex'
    | 'artifactContentHash'
    | 'criteria'
  >;
  definition: Pick<
    WorkflowEvaluationDefinition,
    'version' | 'rubric' | 'promptfooSuiteRef' | 'judgeOutputSchema'
  >;
  jobIds: Readonly<Record<WorkflowEvaluationJobEvaluator, string>>;
}>;

export type BuiltWorkflowEvaluationSpecification<T> =
  | Readonly<{ ok: true; specification: T; specificationHash: string }>
  | Readonly<{ ok: false; code: WorkflowEvaluationSpecificationFailureCode; message: string }>;

export type WorkflowEvaluationSpecifications = Readonly<{
  promptfoo: BuiltWorkflowEvaluationSpecification<AiRunV2PromptfooSpecification>;
  llm_judge: BuiltWorkflowEvaluationSpecification<AiRunV2DocumentSpecification>;
}>;

export type WorkflowEvaluationSpecificationDependencies = Readonly<{
  loadPrdInputs?: (prdId: string) => Promise<PrdEvaluationInputs | null>;
  loadInterviewInputs?: (interviewId: string) => Promise<InterviewEvaluationInputs | null>;
  loadDesignDocInputs?: (designDocId: string) => Promise<DesignDocEvaluationInputs | null>;
  loadSkillConfig?: (project: string) => Promise<ProjectSkillConfig | null>;
  loadDefaultModel?: () => Promise<string>;
}>;

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/** Whole `## ` sections; the leading title block is always kept. */
function splitSections(markdown: string): string[] {
  return markdown.split(/(?=^## )/m).filter((section) => section.length > 0);
}

function sectionName(section: string): string {
  return section.split('\n', 1)[0].replace(/^#+\s*/, '').trim();
}

function takeMessages(
  messages: readonly WorkflowEvaluationTranscriptMessage[],
  budget: number,
  keepFirst: boolean,
): { kept: WorkflowEvaluationTranscriptMessage[]; used: number } {
  const kept: WorkflowEvaluationTranscriptMessage[] = [];
  let used = 0;
  for (const message of messages) {
    const size = jsonBytes(message);
    if (used + size > budget && !(keepFirst && kept.length === 0)) break;
    kept.push({ role: message.role, text: message.text });
    used += size;
  }
  return { kept, used };
}

/** Keeps whole sections that fit the budget, in order. The first is kept regardless when `keepFirst`. */
function fitSections(
  markdown: string,
  budget: number,
  keepFirst: boolean,
): { kept: string[]; used: number; omitted: string[] } {
  const kept: string[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const section of splitSections(markdown)) {
    const size = jsonBytes(section);
    if (used + size <= budget || (keepFirst && kept.length === 0)) {
      kept.push(section);
      used += size;
    } else {
      omitted.push(sectionName(section));
    }
  }
  return { kept, used, omitted };
}

function packagePrd(
  markdown: string,
  backlog: unknown,
  transcript: readonly WorkflowEvaluationTranscriptMessage[] | null,
): WorkflowEvaluationArtifactPackage {
  const budget = WORKFLOW_EVALUATION_PACKAGE_MAX_BYTES;
  const fitted = fitSections(markdown, budget, true);
  const omittedSections = fitted.omitted;
  const kept = fitted.kept;
  let used = fitted.used;

  let backlogJson: string | null = null;
  if (backlog !== null && backlog !== undefined) {
    const pretty = JSON.stringify(backlog, null, 2);
    if (used + jsonBytes(pretty) <= budget) {
      backlogJson = pretty;
      used += jsonBytes(pretty);
    } else {
      omittedSections.push('Backlog JSON');
    }
  }

  let sourceTranscript: WorkflowEvaluationTranscriptMessage[] | null = null;
  let omittedMessages = 0;
  if (transcript) {
    const taken = takeMessages(transcript, budget - used, false);
    sourceTranscript = taken.kept;
    omittedMessages = transcript.length - taken.kept.length;
  }

  return {
    kind: 'prd',
    markdown: kept.join(''),
    backlogJson,
    sourceTranscript,
    truncated: omittedSections.length > 0 || omittedMessages > 0,
    omittedSections,
    omittedMessages,
  };
}

function packageInterviewPhase(
  phaseIndex: number,
  messages: readonly WorkflowEvaluationTranscriptMessage[],
): WorkflowEvaluationArtifactPackage {
  const taken = takeMessages(messages, WORKFLOW_EVALUATION_PACKAGE_MAX_BYTES, true);
  const omittedMessages = messages.length - taken.kept.length;
  return {
    kind: 'interview_phase',
    phaseIndex,
    messages: taken.kept,
    truncated: omittedMessages > 0,
    omittedMessages,
  };
}

export function renderDesignDocMarkdown(parts: DesignDocArtifactParts): string {
  return [
    `# Design\n\n${parts.designContent.trim()}\n\n`,
    `# Technical specification\n\n${parts.techSpecContent.trim()}\n\n`,
    `# Assumptions\n\n${parts.assumptionsContent.trim()}\n`,
  ].join('');
}

/** The design doc comes first; the source PRD gets whatever budget is left. */
function packageDesignDoc(
  parts: DesignDocArtifactParts,
  prdMarkdown: string | null,
): WorkflowEvaluationArtifactPackage {
  const budget = WORKFLOW_EVALUATION_PACKAGE_MAX_BYTES;
  const doc = fitSections(renderDesignDocMarkdown(parts), budget, true);
  const omittedSections = [...doc.omitted];
  let sourcePrd: string | null = null;
  if (prdMarkdown?.trim()) {
    const prd = fitSections(prdMarkdown, budget - doc.used, false);
    sourcePrd = prd.kept.length > 0 ? prd.kept.join('') : null;
    omittedSections.push(...prd.omitted.map((name) => `Source PRD: ${name}`));
  }
  return {
    kind: 'design_doc',
    markdown: doc.kept.join(''),
    sourcePrd,
    truncated: omittedSections.length > 0,
    omittedSections,
    omittedMessages: 0,
  };
}

async function buildArtifactPackage(
  event: WorkflowEvaluationSpecificationRequest['event'],
  loadPrdInputs: NonNullable<WorkflowEvaluationSpecificationDependencies['loadPrdInputs']>,
  loadInterviewInputs: NonNullable<WorkflowEvaluationSpecificationDependencies['loadInterviewInputs']>,
  loadDesignDocInputs: NonNullable<WorkflowEvaluationSpecificationDependencies['loadDesignDocInputs']>,
): Promise<WorkflowEvaluationArtifactPackage> {
  switch (event.subjectType) {
    case 'prd': {
      const prd = await loadPrdInputs(event.subjectId);
      if (!prd || prd.project !== event.projectId || !prd.content.trim()) {
        throw new WorkflowEvaluationSpecificationError(
          'artifact_unavailable',
          'The PRD is missing or has no content.',
        );
      }
      if (hashPrdArtifact(prd.content, prd.backlogJson) !== event.artifactContentHash) {
        throw new WorkflowEvaluationSpecificationError(
          'artifact_changed',
          'The PRD changed after the evaluation was submitted.',
        );
      }
      const interview = prd.interviewId ? await loadInterviewInputs(prd.interviewId) : null;
      const transcript = interview
        ? interview.phases.flatMap((phase) => phase.messages)
        : null;
      return packagePrd(prd.content, prd.backlogJson, transcript);
    }
    case 'interview_phase': {
      const interview = await loadInterviewInputs(event.subjectId);
      const phase = interview?.phases.find((item) => item.phaseIndex === event.phaseIndex);
      if (!interview || interview.project !== event.projectId || !phase || phase.messages.length === 0) {
        throw new WorkflowEvaluationSpecificationError(
          'artifact_unavailable',
          'The interview phase is missing or has no messages.',
        );
      }
      if (
        hashInterviewPhaseArtifact(phase.messages, interview.linkedContextIds)
        !== event.artifactContentHash
      ) {
        throw new WorkflowEvaluationSpecificationError(
          'artifact_changed',
          'The interview phase changed after the evaluation was submitted.',
        );
      }
      return packageInterviewPhase(phase.phaseIndex, phase.messages);
    }
    case 'design_doc': {
      const doc = await loadDesignDocInputs(event.subjectId);
      if (!doc || doc.project !== event.projectId || (!doc.designContent.trim() && !doc.techSpecContent.trim())) {
        throw new WorkflowEvaluationSpecificationError(
          'artifact_unavailable',
          'The design doc is missing or has no content.',
        );
      }
      if (hashDesignDocArtifact(doc) !== event.artifactContentHash) {
        throw new WorkflowEvaluationSpecificationError(
          'artifact_changed',
          'The design doc changed after the evaluation was submitted.',
        );
      }
      const prd = await loadPrdInputs(doc.prdId);
      return packageDesignDoc(doc, prd && prd.project === event.projectId ? prd.content : null);
    }
    default: {
      const unhandled: never = event.subjectType;
      throw new Error(`Unsupported evaluation subject: ${String(unhandled)}`);
    }
  }
}

function identity(
  request: WorkflowEvaluationSpecificationRequest,
  evaluatorKey: WorkflowEvaluationJobEvaluator,
): WorkflowEvaluationRunIdentity {
  return {
    eventId: request.event.id,
    jobId: request.jobIds[evaluatorKey],
    stageKey: request.event.stageKey,
    rubricVersion: request.definition.version,
    artifactHash: request.event.artifactContentHash,
  };
}

function built<T>(specification: T): BuiltWorkflowEvaluationSpecification<T> {
  return {
    ok: true,
    specification,
    specificationHash: sha256Hex(JSON.stringify(specification)),
  };
}

function failed<T>(error: unknown): BuiltWorkflowEvaluationSpecification<T> {
  if (error instanceof WorkflowEvaluationSpecificationError) {
    return { ok: false, code: error.code, message: error.message };
  }
  return {
    ok: false,
    code: 'specification_invalid',
    message: error instanceof Error ? error.message : String(error),
  };
}

function buildPromptfooSpecification(
  request: WorkflowEvaluationSpecificationRequest,
  artifactPackage: WorkflowEvaluationArtifactPackage,
): AiRunV2PromptfooSpecification {
  const suite = getWorkflowEvaluationSuite(request.definition.promptfooSuiteRef);
  if (!suite) {
    throw new WorkflowEvaluationSpecificationError(
      'suite_missing',
      `No Promptfoo suite is registered for ${request.definition.promptfooSuiteRef}.`,
    );
  }
  const candidate: Record<string, unknown> = {
    specVersion: AI_RUN_V2_EVALUATION_SPEC_VERSION,
    workloadLane: 'document',
    workflowClass: 'evaluation-promptfoo',
    projectId: request.event.projectId,
    threadId: workflowEvaluationRunThreadId(request.event.id, 'promptfoo'),
    deadlineMs: WORKFLOW_EVALUATION_PROMPTFOO_DEADLINE_MS,
    evaluation: identity(request, 'promptfoo'),
    suite,
    suiteSha256: sha256Hex(JSON.stringify(suite)),
    artifactPackage,
  };
  if (!isAiRunV2PromptfooSpecification(candidate)) {
    throw new WorkflowEvaluationSpecificationError(
      'specification_invalid',
      'The Promptfoo specification failed validation.',
    );
  }
  return candidate;
}

async function buildJudgeSpecification(
  request: WorkflowEvaluationSpecificationRequest,
  artifactPackage: WorkflowEvaluationArtifactPackage,
  loadSkillConfig: NonNullable<WorkflowEvaluationSpecificationDependencies['loadSkillConfig']>,
  loadDefaultModel: NonNullable<WorkflowEvaluationSpecificationDependencies['loadDefaultModel']>,
): Promise<AiRunV2DocumentSpecification> {
  const project = request.event.projectId;
  const skillConfig = await loadSkillConfig(project);
  if (!skillConfig) {
    throw new WorkflowEvaluationSpecificationError(
      'skill_config_missing',
      `Project ${project} has no skill configuration to resolve the judge model.`,
    );
  }
  const { model, effort } = await resolveEvaluationJudgeModel(project, skillConfig, loadDefaultModel);
  const { rubric } = request.definition;
  const candidate: Record<string, unknown> = {
    workloadLane: 'document',
    prompt: WORKFLOW_EVALUATION_JUDGE_PROMPT,
    model,
    effort,
    skillPath: WORKFLOW_EVALUATION_JUDGE_SKILL_PATH,
    skillContent: WORKFLOW_EVALUATION_JUDGE_INSTRUCTIONS,
    skillSha256: sha256Hex(WORKFLOW_EVALUATION_JUDGE_INSTRUCTIONS),
    workflowClass: 'evaluation-judge',
    projectId: project,
    threadId: workflowEvaluationRunThreadId(request.event.id, 'llm_judge'),
    deadlineMs: WORKFLOW_EVALUATION_JUDGE_DEADLINE_MS,
    scratchInputs: [
      {
        path: WORKFLOW_EVALUATION_SCRATCH_PATHS.artifactPackage,
        content: JSON.stringify(
          { ...artifactPackage, humanScoreHints: request.event.criteria },
          null,
          2,
        ),
      },
      {
        path: WORKFLOW_EVALUATION_SCRATCH_PATHS.rubric,
        content: JSON.stringify(
          { version: request.definition.version, criteria: rubric.criteria, scale: rubric.scale },
          null,
          2,
        ),
      },
      {
        path: WORKFLOW_EVALUATION_SCRATCH_PATHS.outputSchema,
        content: JSON.stringify(request.definition.judgeOutputSchema, null, 2),
      },
    ],
    outputSchema: request.definition.judgeOutputSchema,
    evaluation: identity(request, 'llm_judge'),
  };
  if (!isAiRunV2DocumentSpecification(candidate)) {
    throw new WorkflowEvaluationSpecificationError(
      'specification_invalid',
      'The judge specification failed validation.',
    );
  }
  return candidate;
}

/**
 * Never throws. A job whose specification cannot be built gets a failure code
 * to store on its row; the other job is unaffected unless the artifact itself
 * is the problem.
 */
export async function buildWorkflowEvaluationSpecifications(
  request: WorkflowEvaluationSpecificationRequest,
  dependencies: WorkflowEvaluationSpecificationDependencies = {},
): Promise<WorkflowEvaluationSpecifications> {
  const loadPrdInputs = dependencies.loadPrdInputs ?? getPrdEvaluationInputs;
  const loadInterviewInputs = dependencies.loadInterviewInputs ?? getInterviewEvaluationInputs;
  const loadDesignDocInputs = dependencies.loadDesignDocInputs ?? getDesignDocEvaluationInputs;
  const loadSkillConfig = dependencies.loadSkillConfig ?? ((project: string) => resolveSkillConfig({ project }));
  const loadDefaultModel = dependencies.loadDefaultModel ?? getDefaultModel;

  let artifactPackage: WorkflowEvaluationArtifactPackage;
  try {
    artifactPackage = await buildArtifactPackage(
      request.event,
      loadPrdInputs,
      loadInterviewInputs,
      loadDesignDocInputs,
    );
  } catch (error) {
    return { promptfoo: failed(error), llm_judge: failed(error) };
  }

  let promptfoo: WorkflowEvaluationSpecifications['promptfoo'];
  try {
    promptfoo = built(buildPromptfooSpecification(request, artifactPackage));
  } catch (error) {
    promptfoo = failed(error);
  }

  let judge: WorkflowEvaluationSpecifications['llm_judge'];
  try {
    judge = built(
      await buildJudgeSpecification(request, artifactPackage, loadSkillConfig, loadDefaultModel),
    );
  } catch (error) {
    judge = failed(error);
  }

  return { promptfoo, llm_judge: judge };
}
