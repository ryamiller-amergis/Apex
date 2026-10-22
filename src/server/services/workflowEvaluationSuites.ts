/**
 * Promptfoo suites for human workflow evaluation, keyed by the
 * `promptfoo_suite_ref` on each definition row.
 *
 * They live in code because App Service ships only `dist/`; a suite file on
 * disk would not exist in production. A suite change is a new ref
 * (`structural@2`) in a new definition version, never an edit to a shipped
 * one, so a stored result always names the checks that produced it.
 */
import type {
  WorkflowEvaluationPromptfooSuite,
  WorkflowEvaluationPromptfooTest,
} from '../../shared/types/aiRunV2EvaluationSpec';
import { workflowEvaluationPromptfooSuiteRef } from '../../shared/types/workflowEvaluation';

/** Sections `.cursor/skills/to-prd/prd-template.md` requires in every PRD. */
const PRD_REQUIRED_SECTIONS = [
  'Problem Statement',
  'Solution',
  'Implementation Decisions',
  'Testing Decisions',
  'Target Surface',
  'Access Control and Permissions',
  'Security and Data Sensitivity',
  'Non-Functional Requirements',
  'Feature Flag',
  'Out of Scope',
  'Assumptions Made',
] as const;

/** Top-level keys `.cursor/skills/to-prd/backlog-schema.json` marks required. */
const BACKLOG_REQUIRED_KEYS = [
  'personas',
  'businessRules',
  'epics',
  'implementationPhases',
  'assumptionsMade',
] as const;

const PRD_TESTS: readonly WorkflowEvaluationPromptfooTest[] = [
  ...PRD_REQUIRED_SECTIONS.map((section): WorkflowEvaluationPromptfooTest => ({
    description: `PRD has a "${section}" section`,
    target: 'artifact',
    assert: [{ type: 'contains', value: `## ${section}` }],
  })),
  {
    description: 'PRD has no authored "User Stories" section',
    target: 'artifact',
    assert: [{ type: 'not-regex', value: '(^|\\n)## User Stories\\b' }],
  },
  {
    description: 'Backlog is valid JSON',
    target: 'backlog',
    assert: [{ type: 'is-json' }],
  },
  ...BACKLOG_REQUIRED_KEYS.map((key): WorkflowEvaluationPromptfooTest => ({
    description: `Backlog has "${key}"`,
    target: 'backlog',
    assert: [{ type: 'contains', value: `"${key}":` }],
  })),
];

const INTERVIEW_PHASE_TESTS: readonly WorkflowEvaluationPromptfooTest[] = [
  {
    description: 'Both the agent and the participant spoke',
    target: 'artifact',
    assert: [{ type: 'contains-all', value: ['agent:', 'user:'] }],
  },
  {
    description: 'The agent asked at least one question',
    target: 'artifact',
    assert: [{ type: 'regex', value: '(^|\\n)agent:[^\\n]*\\?' }],
  },
];

/**
 * Sections from `.cursor/skills/prd-design-spec/design-template.md` and
 * `tech-spec-template.md`. The package renders the three parts as one text.
 */
const DESIGN_DOC_REQUIRED_SECTIONS = [
  'Feature Summary',
  'Scope and Out-of-Scope',
  'Acceptance Criteria',
  'Architecture and Approach',
  'Data and Contracts',
  'Testing Strategy',
] as const;

const DESIGN_DOC_TESTS: readonly WorkflowEvaluationPromptfooTest[] = DESIGN_DOC_REQUIRED_SECTIONS.map(
  (section): WorkflowEvaluationPromptfooTest => ({
    description: `Design doc has a "${section}" section`,
    target: 'artifact',
    assert: [{ type: 'contains', value: `## ${section}` }],
  }),
);

/** Sections and per-case fields from the markdown template in `.cursor/skills/create-test-case/SKILL.md`. */
const TEST_CASES_TESTS: readonly WorkflowEvaluationPromptfooTest[] = [
  ...['Coverage summary', 'Suites', 'Gaps and assumptions'].map(
    (section): WorkflowEvaluationPromptfooTest => ({
      description: `Test cases have a "${section}" section`,
      target: 'artifact',
      assert: [{ type: 'contains', value: `## ${section}` }],
    }),
  ),
  ...['**Steps:**', '**Expected result:**', '**Traceability:**'].map(
    (field): WorkflowEvaluationPromptfooTest => ({
      description: `Test cases include ${field.replace(/\*/g, '').replace(':', '')}`,
      target: 'artifact',
      assert: [{ type: 'contains', value: field }],
    }),
  ),
];

function prdSuite(stageKey: string): WorkflowEvaluationPromptfooSuite {
  return {
    ref: workflowEvaluationPromptfooSuiteRef(stageKey),
    subjectType: 'prd',
    tests: PRD_TESTS,
  };
}

function interviewSuite(stageKey: string): WorkflowEvaluationPromptfooSuite {
  return {
    ref: workflowEvaluationPromptfooSuiteRef(stageKey),
    subjectType: 'interview_phase',
    tests: INTERVIEW_PHASE_TESTS,
  };
}

function designDocSuite(stageKey: string): WorkflowEvaluationPromptfooSuite {
  return {
    ref: workflowEvaluationPromptfooSuiteRef(stageKey),
    subjectType: 'design_doc',
    tests: DESIGN_DOC_TESTS,
  };
}

function testCasesSuite(stageKey: string): WorkflowEvaluationPromptfooSuite {
  return {
    ref: workflowEvaluationPromptfooSuiteRef(stageKey),
    subjectType: 'test_cases',
    tests: TEST_CASES_TESTS,
  };
}

const SUITES: ReadonlyMap<string, WorkflowEvaluationPromptfooSuite> = new Map(
  [
    prdSuite('prd_human_review'),
    interviewSuite('interview_phase_1'),
    interviewSuite('interview_phase_2'),
    interviewSuite('interview_phase_3'),
    designDocSuite('design_doc_human_review'),
    testCasesSuite('test_cases_human_review'),
  ].map((suite) => [suite.ref, suite]),
);

export function getWorkflowEvaluationSuite(ref: string): WorkflowEvaluationPromptfooSuite | null {
  return SUITES.get(ref) ?? null;
}

export function listWorkflowEvaluationSuiteRefs(): string[] {
  return [...SUITES.keys()];
}
