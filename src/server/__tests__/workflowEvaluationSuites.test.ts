import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  isAiRunV2PromptfooSpecification,
  type WorkflowEvaluationArtifactPackage,
} from '../../shared/types/aiRunV2EvaluationSpec';
import {
  WORKFLOW_EVALUATION_SEEDED_STAGE_KEYS,
  workflowEvaluationPromptfooSuiteRef,
} from '../../shared/types/workflowEvaluation';
import {
  getWorkflowEvaluationSuite,
  listWorkflowEvaluationSuiteRefs,
} from '../services/workflowEvaluationSuites';

const TO_PRD_DIR = path.resolve(__dirname, '../../../.cursor/skills/to-prd');

function specificationFor(stageKey: string): Record<string, unknown> {
  const suite = getWorkflowEvaluationSuite(workflowEvaluationPromptfooSuiteRef(stageKey));
  const artifactPackage: WorkflowEvaluationArtifactPackage = suite?.subjectType === 'prd'
    ? {
      kind: 'prd',
      markdown: '# PRD',
      backlogJson: null,
      sourceTranscript: null,
      truncated: false,
      omittedSections: [],
      omittedMessages: 0,
    }
    : {
      kind: 'interview_phase',
      phaseIndex: 1,
      messages: [{ role: 'agent', text: 'What do you need?' }],
      truncated: false,
      omittedMessages: 0,
    };
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
  it.each(WORKFLOW_EVALUATION_SEEDED_STAGE_KEYS)(
    'resolves the seeded suite for %s and passes the specification guard',
    (stageKey) => {
      expect(getWorkflowEvaluationSuite(workflowEvaluationPromptfooSuiteRef(stageKey))).not.toBeNull();
      expect(isAiRunV2PromptfooSpecification(specificationFor(stageKey))).toBe(true);
    },
  );

  it('registers no suite beyond the seeded stages', () => {
    expect(listWorkflowEvaluationSuiteRefs().sort()).toEqual(
      WORKFLOW_EVALUATION_SEEDED_STAGE_KEYS.map(workflowEvaluationPromptfooSuiteRef).sort(),
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
});
