/**
 * Contracts for the two diagnostic jobs a human workflow evaluation starts.
 *
 * The judge runs as the `evaluation-judge` document workflow: it reuses
 * `AiRunV2DocumentSpecification` and adds the `evaluation` and `outputSchema`
 * fields checked here. Promptfoo has no skill and no model, so it gets its own
 * specification rather than padding the document one with invented values.
 */
import {
  WORKFLOW_EVALUATION_JOB_EVALUATORS,
  WORKFLOW_EVALUATION_SUBJECT_TYPES,
  type WorkflowEvaluationJobEvaluator,
  type WorkflowEvaluationSubjectType,
} from './workflowEvaluation';

export const AI_RUN_V2_EVALUATION_SPEC_VERSION = 1;

export const WORKFLOW_EVALUATION_THREAD_PREFIX = 'wfeval:';

/**
 * Each diagnostic job needs its own thread: V2 allows one active run per
 * thread, and the document harvest reads only the latest run on a thread, so
 * two jobs on one thread would hide one result.
 */
export function workflowEvaluationRunThreadId(
  eventId: string,
  evaluatorKey: WorkflowEvaluationJobEvaluator,
): string {
  return `${WORKFLOW_EVALUATION_THREAD_PREFIX}${eventId}:${evaluatorKey}`;
}

export function parseWorkflowEvaluationRunThreadId(
  threadId: string,
): { eventId: string; evaluatorKey: WorkflowEvaluationJobEvaluator } | null {
  if (!threadId.startsWith(WORKFLOW_EVALUATION_THREAD_PREFIX)) return null;
  const rest = threadId.slice(WORKFLOW_EVALUATION_THREAD_PREFIX.length);
  const separator = rest.lastIndexOf(':');
  if (separator <= 0) return null;
  const eventId = rest.slice(0, separator);
  const evaluatorKey = rest.slice(separator + 1);
  if (!(WORKFLOW_EVALUATION_JOB_EVALUATORS as readonly string[]).includes(evaluatorKey)) return null;
  return { eventId, evaluatorKey: evaluatorKey as WorkflowEvaluationJobEvaluator };
}

export const WORKFLOW_EVALUATION_SCRATCH_PATHS = {
  artifactPackage: '.ai-pilot/evaluation/artifact-package.json',
  rubric: '.ai-pilot/evaluation/rubric.json',
  outputSchema: '.ai-pilot/evaluation/output-schema.json',
} as const;

export const JUDGE_RESULT_FILE = 'judge-result.json';
export const JUDGE_APPENDIX_FILE = 'judge-result.md';
export const PROMPTFOO_SUMMARY_FILE = 'promptfoo-summary.json';
export const PROMPTFOO_RESULTS_FILE = 'promptfoo-results.json';

/** Largest artifact package a specification carries, measured as UTF-8 JSON. */
export const WORKFLOW_EVALUATION_PACKAGE_MAX_BYTES = 256 * 1024;

export type WorkflowEvaluationRunIdentity = Readonly<{
  eventId: string;
  jobId: string;
  stageKey: string;
  rubricVersion: number;
  artifactHash: string;
}>;

export type WorkflowEvaluationTranscriptMessage = Readonly<{
  role: string;
  text: string;
}>;

export type WorkflowEvaluationArtifactPackage =
  | Readonly<{
      kind: 'prd';
      markdown: string;
      /** Pretty-printed backlog JSON, or null when the PRD has none or it did not fit. */
      backlogJson: string | null;
      /** The interview the PRD was generated from, or null when it has none. */
      sourceTranscript: readonly WorkflowEvaluationTranscriptMessage[] | null;
      truncated: boolean;
      omittedSections: readonly string[];
      omittedMessages: number;
    }>
  | Readonly<{
      kind: 'interview_phase';
      phaseIndex: number;
      messages: readonly WorkflowEvaluationTranscriptMessage[];
      truncated: boolean;
      omittedMessages: number;
    }>;

/**
 * Assertion types that compare text and never call a model or run code, so a
 * suite gives the same answer for the same artifact on every run.
 */
export const PROMPTFOO_DETERMINISTIC_ASSERTION_TYPES = [
  'contains',
  'icontains',
  'not-contains',
  'not-icontains',
  'contains-all',
  'contains-any',
  'icontains-all',
  'icontains-any',
  'regex',
  'not-regex',
  'starts-with',
  'is-json',
  'contains-json',
] as const;

export type PromptfooDeterministicAssertionType =
  (typeof PROMPTFOO_DETERMINISTIC_ASSERTION_TYPES)[number];

export type WorkflowEvaluationPromptfooAssertion = Readonly<{
  type: PromptfooDeterministicAssertionType;
  value?: string | readonly string[];
}>;

/** `backlog` reads the PRD backlog JSON; every other test reads the artifact text. */
export type WorkflowEvaluationPromptfooTarget = 'artifact' | 'backlog';

export type WorkflowEvaluationPromptfooTest = Readonly<{
  description: string;
  target: WorkflowEvaluationPromptfooTarget;
  assert: readonly WorkflowEvaluationPromptfooAssertion[];
}>;

export type WorkflowEvaluationPromptfooSuite = Readonly<{
  ref: string;
  subjectType: WorkflowEvaluationSubjectType;
  tests: readonly WorkflowEvaluationPromptfooTest[];
}>;

export type AiRunV2PromptfooSpecification = Readonly<{
  specVersion: typeof AI_RUN_V2_EVALUATION_SPEC_VERSION;
  workloadLane: 'document';
  workflowClass: 'evaluation-promptfoo';
  projectId: string;
  threadId: string;
  deadlineMs: number;
  evaluation: WorkflowEvaluationRunIdentity;
  suite: WorkflowEvaluationPromptfooSuite;
  /** SHA-256 of the suite's canonical JSON, checked by the worker before it runs. */
  suiteSha256: string;
  artifactPackage: WorkflowEvaluationArtifactPackage;
}>;

/** One failed assertion, as the worker records it in the Promptfoo summary. */
export type WorkflowEvaluationPromptfooFailure = Readonly<{
  test: string;
  assertion: PromptfooDeterministicAssertionType;
  reason: string;
}>;

export const PROMPTFOO_SUMMARY_MAX_FAILURES = 20;

export type WorkflowEvaluationPromptfooSummary = Readonly<{
  suiteRef: string;
  suiteSha256: string;
  artifactHash: string;
  passed: boolean;
  totals: Readonly<{ tests: number; passed: number; failed: number }>;
  failures: readonly WorkflowEvaluationPromptfooFailure[];
  durationMs: number;
}>;

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const STRING_VALUE_TYPES = new Set<PromptfooDeterministicAssertionType>([
  'contains',
  'icontains',
  'not-contains',
  'not-icontains',
  'regex',
  'not-regex',
  'starts-with',
]);
const LIST_VALUE_TYPES = new Set<PromptfooDeterministicAssertionType>([
  'contains-all',
  'contains-any',
  'icontains-all',
  'icontains-any',
]);
const REGEX_TYPES = new Set<PromptfooDeterministicAssertionType>(['regex', 'not-regex']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

export function isWorkflowEvaluationRunIdentity(
  value: unknown,
): value is WorkflowEvaluationRunIdentity {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.eventId)
    && isNonEmptyString(value.jobId)
    && isNonEmptyString(value.stageKey)
    && isPositiveSafeInteger(value.rubricVersion)
    && isSha256Hex(value.artifactHash)
  );
}

/** The judge schema is data from the definition row; only its root shape is checked here. */
export function isJudgeOutputSchema(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value)
    && value.type === 'object'
    && isRecord(value.properties)
    && value.additionalProperties === false
  );
}

function isSubjectType(value: unknown): value is WorkflowEvaluationSubjectType {
  return (WORKFLOW_EVALUATION_SUBJECT_TYPES as readonly unknown[]).includes(value);
}

function isAssertionType(value: unknown): value is PromptfooDeterministicAssertionType {
  return (PROMPTFOO_DETERMINISTIC_ASSERTION_TYPES as readonly unknown[]).includes(value);
}

function isCompilableRegex(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

function isPromptfooAssertion(value: unknown): value is WorkflowEvaluationPromptfooAssertion {
  if (!isRecord(value) || !isAssertionType(value.type)) return false;
  if (STRING_VALUE_TYPES.has(value.type)) {
    if (!isNonEmptyString(value.value)) return false;
    return !REGEX_TYPES.has(value.type) || isCompilableRegex(value.value);
  }
  if (LIST_VALUE_TYPES.has(value.type)) {
    return (
      Array.isArray(value.value)
      && value.value.length > 0
      && value.value.every(isNonEmptyString)
    );
  }
  return value.value === undefined;
}

function isPromptfooTest(
  value: unknown,
  subjectType: WorkflowEvaluationSubjectType,
): value is WorkflowEvaluationPromptfooTest {
  if (!isRecord(value) || !isNonEmptyString(value.description)) return false;
  if (value.target !== 'artifact' && value.target !== 'backlog') return false;
  if (value.target === 'backlog' && subjectType !== 'prd') return false;
  return (
    Array.isArray(value.assert)
    && value.assert.length > 0
    && value.assert.every(isPromptfooAssertion)
  );
}

/** A suite with zero tests would report a pass that checks nothing, so it is refused. */
export function isWorkflowEvaluationPromptfooSuite(
  value: unknown,
): value is WorkflowEvaluationPromptfooSuite {
  if (!isRecord(value) || !isNonEmptyString(value.ref) || !isSubjectType(value.subjectType)) {
    return false;
  }
  const subjectType = value.subjectType;
  if (!Array.isArray(value.tests) || value.tests.length === 0) return false;
  const descriptions = new Set<string>();
  for (const test of value.tests) {
    if (!isPromptfooTest(test, subjectType) || descriptions.has(test.description)) return false;
    descriptions.add(test.description);
  }
  return true;
}

function isTranscriptMessage(value: unknown): value is WorkflowEvaluationTranscriptMessage {
  return isRecord(value) && isNonEmptyString(value.role) && typeof value.text === 'string';
}

export function isWorkflowEvaluationArtifactPackage(
  value: unknown,
): value is WorkflowEvaluationArtifactPackage {
  if (!isRecord(value) || typeof value.truncated !== 'boolean') return false;
  if (!isNonNegativeSafeInteger(value.omittedMessages)) return false;
  switch (value.kind) {
    case 'prd':
      return (
        isNonEmptyString(value.markdown)
        && (value.backlogJson === null || typeof value.backlogJson === 'string')
        && (
          value.sourceTranscript === null
          || (Array.isArray(value.sourceTranscript) && value.sourceTranscript.every(isTranscriptMessage))
        )
        && Array.isArray(value.omittedSections)
        && value.omittedSections.every((item) => typeof item === 'string')
      );
    case 'interview_phase':
      return (
        isPositiveSafeInteger(value.phaseIndex)
        && Array.isArray(value.messages)
        && value.messages.length > 0
        && value.messages.every(isTranscriptMessage)
      );
    default:
      return false;
  }
}

/**
 * The text a Promptfoo test checks. Interview messages render one per line as
 * `role: text`, so a suite can anchor a pattern on who spoke.
 */
export function renderPromptfooTarget(
  artifactPackage: WorkflowEvaluationArtifactPackage,
  target: WorkflowEvaluationPromptfooTarget,
): string {
  switch (artifactPackage.kind) {
    case 'prd':
      return target === 'backlog' ? artifactPackage.backlogJson ?? '' : artifactPackage.markdown;
    case 'interview_phase':
      return artifactPackage.messages
        .map((message) => `${message.role}: ${message.text.replace(/\s*\n\s*/g, ' ').trim()}`)
        .join('\n');
    default: {
      const unhandled: never = artifactPackage;
      throw new Error(`Unsupported artifact package: ${String(unhandled)}`);
    }
  }
}

export function isAiRunV2PromptfooSpecification(
  value: unknown,
): value is AiRunV2PromptfooSpecification {
  if (!isRecord(value)) return false;
  if (value.specVersion !== AI_RUN_V2_EVALUATION_SPEC_VERSION) return false;
  if (value.workloadLane !== 'document') return false;
  if (value.workflowClass !== 'evaluation-promptfoo') return false;
  if (!isNonEmptyString(value.projectId) || !isNonEmptyString(value.threadId)) return false;
  if (!isPositiveSafeInteger(value.deadlineMs)) return false;
  if (!isWorkflowEvaluationRunIdentity(value.evaluation)) return false;
  if (!isWorkflowEvaluationPromptfooSuite(value.suite)) return false;
  if (!isSha256Hex(value.suiteSha256)) return false;
  if (!isWorkflowEvaluationArtifactPackage(value.artifactPackage)) return false;
  if (value.suite.subjectType !== value.artifactPackage.kind) return false;
  for (const hostPathField of ['workspaceRef', 'checkoutRef', 'mirrorRef'] as const) {
    if (value[hostPathField] !== undefined) return false;
  }
  return true;
}
