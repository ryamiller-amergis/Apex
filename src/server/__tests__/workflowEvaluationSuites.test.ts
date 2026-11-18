import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  isAiRunV2PromptfooSpecification,
  type WorkflowEvaluationArtifactPackage,
} from '../../shared/types/aiRunV2EvaluationSpec';
import {
  WORKFLOW_EVALUATION_STAGE_KEYS,
  workflowEvaluationPromptfooSuiteRef,
} from '../../shared/types/workflowEvaluation';
import {
  getWorkflowEvaluationSuite,
  listWorkflowEvaluationSuiteRefs,
} from '../services/workflowEvaluationSuites';

const TO_PRD_DIR = path.resolve(__dirname, '../../../.cursor/skills/to-prd');
const DESIGN_SPEC_DIR = path.resolve(__dirname, '../../../.cursor/skills/prd-design-spec');
const TEST_CASE_SKILL_DIR = path.resolve(__dirname, '../../../.cursor/skills/create-test-case');

const PACKAGES: Record<string, WorkflowEvaluationArtifactPackage> = {
  prd: {
    kind: 'prd',
    markdown: '# PRD',
    backlogJson: null,
    sourceTranscript: null,
    truncated: false,
    omittedSections: [],
    omittedMessages: 0,
  },
  interview_phase: {
    kind: 'interview_phase',
    phaseIndex: 1,
    messages: [{ role: 'agent', text: 'What do you need?' }],
    truncated: false,
    omittedMessages: 0,
  },
  design_doc: {
    kind: 'design_doc',
    markdown: '# Design',
    sourcePrd: null,
    truncated: false,
    omittedSections: [],
    omittedMessages: 0,
  },
  test_cases: {
    kind: 'test_cases',
    markdown: '# Test Cases',
    sourcePrd: null,
    sourceBacklogJson: null,
    truncated: false,
    omittedSections: [],
    omittedMessages: 0,
  },
};

function specificationFor(stageKey: string): Record<string, unknown> {
  const suite = getWorkflowEvaluationSuite(workflowEvaluationPromptfooSuiteRef(stageKey));
  const artifactPackage = PACKAGES[suite?.subjectType ?? 'prd'];
  return {
    specVersion: 1,
    workloadLane: 'document',
    workflowClass: 'evaluation-promptfoo',
    projectId: 'Apex',
    threadId: `wfeval:event-1:promptfoo`,
    deadlineMs: 300_000,
    evaluation: {
      eventId: 'event-1',
      jobId: 'job-1',
      stageKey,
      rubricVersion: 1,
      artifactHash: 'a'.repeat(64),
    },
    suite,
    suiteSha256: 'b'.repeat(64),
    artifactPackage,
  };
}

describe('workflow evaluation Promptfoo suites', () => {
  it.each(WORKFLOW_EVALUATION_STAGE_KEYS)(
    'resolves the seeded suite for %s and passes the specification guard',
    (stageKey) => {
      expect(getWorkflowEvaluationSuite(workflowEvaluationPromptfooSuiteRef(stageKey))).not.toBeNull();
      expect(isAiRunV2PromptfooSpecification(specificationFor(stageKey))).toBe(true);
    },
  );

  it('registers no suite beyond the seeded stages', () => {
    expect(listWorkflowEvaluationSuiteRefs().sort()).toEqual(
      WORKFLOW_EVALUATION_STAGE_KEYS.map(workflowEvaluationPromptfooSuiteRef).sort(),
    );
  });

  it('returns null for an unknown ref', () => {
    expect(getWorkflowEvaluationSuite('orchestrated_workflow/prd_human_review/structural@99')).toBeNull();
  });

  it('checks every section the to-prd template requires, and no others', () => {
    const template = readFileSync(path.join(TO_PRD_DIR, 'prd-template.md'), 'utf8');
    const templateSections = [...template.matchAll(/^## (.+)$/gm)].map((match) => match[1].trim());
    const suite = getWorkflowEvaluationSuite(workflowEvaluationPromptfooSuiteRef('prd_human_review'));
    const checkedSections = (suite?.tests ?? [])
      .flatMap((test) => test.assert)
      .filter((assertion) => assertion.type === 'contains' && typeof assertion.value === 'string')
      .map((assertion) => String(assertion.value))
      .filter((value) => value.startsWith('## '))
      .map((value) => value.slice(3));
    expect(checkedSections.sort()).toEqual(templateSections.sort());
  });

  it('checks every top-level key the backlog schema requires', () => {
    const schema = JSON.parse(readFileSync(path.join(TO_PRD_DIR, 'backlog-schema.json'), 'utf8')) as {
      required: string[];
    };
    const suite = getWorkflowEvaluationSuite(workflowEvaluationPromptfooSuiteRef('prd_human_review'));
    const backlogValues = (suite?.tests ?? [])
      .filter((test) => test.target === 'backlog')
      .flatMap((test) => test.assert)
      .map((assertion) => assertion.value);
    for (const key of schema.required) {
      expect(backlogValues).toContain(`"${key}":`);
    }
  });

  it('checks only sections the design and tech spec templates define', () => {
    const templates = ['design-template.md', 'tech-spec-template.md']
      .map((name) => readFileSync(path.join(DESIGN_SPEC_DIR, name), 'utf8'))
      .join('\n');
    const templateSections = [...templates.matchAll(/^## (.+)$/gm)].map((match) => match[1].trim());
    const suite = getWorkflowEvaluationSuite(workflowEvaluationPromptfooSuiteRef('design_doc_human_review'));
    expect(suite?.subjectType).toBe('design_doc');
    const checked = (suite?.tests ?? [])
      .flatMap((test) => test.assert)
      .map((assertion) => String(assertion.value).replace(/^## /, ''));
    expect(checked.length).toBeGreaterThan(0);
    for (const section of checked) expect(templateSections).toContain(section);
  });

  it('checks only text the create-test-case markdown template contains', () => {
    const skill = readFileSync(path.join(TEST_CASE_SKILL_DIR, 'SKILL.md'), 'utf8');
    const template = /### Markdown template[\s\S]*?```markdown\r?\n([\s\S]*?)\r?\n```/.exec(skill)?.[1] ?? '';
    const suite = getWorkflowEvaluationSuite(workflowEvaluationPromptfooSuiteRef('test_cases_human_review'));
    expect(suite?.subjectType).toBe('test_cases');
    const checked = (suite?.tests ?? []).flatMap((test) => test.assert).map((assertion) => String(assertion.value));
    expect(checked.length).toBeGreaterThan(0);
    for (const value of checked) expect(template).toContain(value);
  });
});
