import { createHash } from 'node:crypto';
import { isAiRunV2DocumentSpecification } from '../../../shared/types/aiRunV2DocumentSpec';
import {
  isAiRunV2PromptfooSpecification,
  parseWorkflowEvaluationRunThreadId,
  renderPromptfooTarget,
  WORKFLOW_EVALUATION_SCRATCH_PATHS,
  workflowEvaluationRunThreadId,
  type WorkflowEvaluationArtifactPackage,
} from '../../../shared/types/aiRunV2EvaluationSpec';

const HASH = 'a'.repeat(64);

const prdPackage: WorkflowEvaluationArtifactPackage = {
  kind: 'prd',
  markdown: '# PRD\n\n## Problem Statement\nUsers cannot X.\n',
  backlogJson: '{\n  "epics": []\n}',
  sourceTranscript: [{ role: 'user', text: 'We need X.' }],
  truncated: false,
  omittedSections: [],
  omittedMessages: 0,
};

const evaluation = {
  eventId: 'event-1',
  jobId: 'job-1',
  stageKey: 'prd_human_review',
  rubricVersion: 1,
  artifactHash: HASH,
};

function promptfooSpecification(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    specVersion: 1,
    workloadLane: 'document',
    workflowClass: 'evaluation-promptfoo',
    projectId: 'Apex',
    threadId: 'wfeval:event-1:promptfoo',
    deadlineMs: 300_000,
    evaluation,
    suite: {
      ref: 'orchestrated_workflow/prd_human_review/structural@1',
      subjectType: 'prd',
      tests: [
        {
          description: 'PRD has a problem statement',
          target: 'artifact',
          assert: [{ type: 'contains', value: '## Problem Statement' }],
        },
        { description: 'Backlog is JSON', target: 'backlog', assert: [{ type: 'is-json' }] },
      ],
    },
    suiteSha256: HASH,
    artifactPackage: prdPackage,
    ...overrides,
  };
}

const judgeSchema = {
  type: 'object',
  properties: { confidence: { type: 'string' } },
  required: ['confidence'],
  additionalProperties: false,
};

function judgeSpecification(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const skillContent = '# Judge';
  return {
    workloadLane: 'document',
    prompt: 'Judge the artifact',
    model: 'claude-4',
    effort: null,
    skillPath: 'apex/workflow-evaluation-judge@1',
    skillContent,
    skillSha256: createHash('sha256').update(skillContent).digest('hex'),
    workflowClass: 'evaluation-judge',
    projectId: 'Apex',
    threadId: 'wfeval:event-1:llm_judge',
    deadlineMs: 900_000,
    scratchInputs: Object.values(WORKFLOW_EVALUATION_SCRATCH_PATHS).map((path) => ({
      path,
      content: '{}',
    })),
    outputSchema: judgeSchema,
    evaluation: { ...evaluation, jobId: 'job-2' },
    ...overrides,
  };
}

describe('Promptfoo execution specification', () => {
  it('accepts a complete specification and is refused by the document guard', () => {
    expect(isAiRunV2PromptfooSpecification(promptfooSpecification())).toBe(true);
    expect(isAiRunV2DocumentSpecification(promptfooSpecification())).toBe(false);
  });

  it.each([
    ['specVersion', 2],
    ['deadlineMs', undefined],
    ['deadlineMs', 0],
    ['projectId', ''],
    ['threadId', undefined],
    ['suiteSha256', 'not-a-sha'],
    ['artifactPackage', undefined],
    ['evaluation', { ...evaluation, artifactHash: undefined }],
    ['evaluation', { ...evaluation, rubricVersion: 0 }],
    ['workspaceRef', '/tmp/host-path'],
  ])('rejects a specification with %s = %p', (field, value) => {
    expect(isAiRunV2PromptfooSpecification(promptfooSpecification({ [field]: value }))).toBe(false);
  });

  it('rejects a suite with zero tests, because it would pass while checking nothing', () => {
    const suite = { ...(promptfooSpecification().suite as object), tests: [] };
    expect(isAiRunV2PromptfooSpecification(promptfooSpecification({ suite }))).toBe(false);
  });

  it.each([
    ['a model-graded assertion', { type: 'llm-rubric', value: 'Is it good?' }],
    ['a code assertion', { type: 'javascript', value: 'output.length > 0' }],
    ['a string assertion with no value', { type: 'contains' }],
    ['a list assertion with a string', { type: 'contains-all', value: 'x' }],
    ['an invalid regex', { type: 'regex', value: '(' }],
    ['a value on is-json', { type: 'is-json', value: '{}' }],
  ])('rejects %s', (_label, assertion) => {
    const suite = {
      ref: 'r',
      subjectType: 'prd',
      tests: [{ description: 't', target: 'artifact', assert: [assertion] }],
    };
    expect(isAiRunV2PromptfooSpecification(promptfooSpecification({ suite }))).toBe(false);
  });

  it('rejects a backlog test on an interview suite and a suite that does not match the package', () => {
    const interviewPackage: WorkflowEvaluationArtifactPackage = {
      kind: 'interview_phase',
      phaseIndex: 1,
      messages: [{ role: 'agent', text: 'What do you need?' }],
      truncated: false,
      omittedMessages: 0,
    };
    const backlogOnInterview = {
      ref: 'r',
      subjectType: 'interview_phase',
      tests: [{ description: 't', target: 'backlog', assert: [{ type: 'is-json' }] }],
    };
    expect(
      isAiRunV2PromptfooSpecification(
        promptfooSpecification({ suite: backlogOnInterview, artifactPackage: interviewPackage }),
      ),
    ).toBe(false);
    expect(
      isAiRunV2PromptfooSpecification(promptfooSpecification({ artifactPackage: interviewPackage })),
    ).toBe(false);
  });

  it('rejects two tests with the same description, so failure names stay unique', () => {
    const test = { description: 'same', target: 'artifact', assert: [{ type: 'contains', value: 'x' }] };
    const suite = { ref: 'r', subjectType: 'prd', tests: [test, test] };
    expect(isAiRunV2PromptfooSpecification(promptfooSpecification({ suite }))).toBe(false);
  });
});

describe('workflow evaluation run thread ids', () => {
  it('round-trips the event id and evaluator', () => {
    const threadId = workflowEvaluationRunThreadId('event-1', 'llm_judge');
    expect(threadId).toBe('wfeval:event-1:llm_judge');
    expect(parseWorkflowEvaluationRunThreadId(threadId)).toEqual({
      eventId: 'event-1',
      evaluatorKey: 'llm_judge',
    });
  });

  it.each(['thread-1', 'wfeval:', 'wfeval:event-1', 'wfeval::promptfoo', 'wfeval:event-1:human'])(
    'returns null for %p',
    (threadId) => {
      expect(parseWorkflowEvaluationRunThreadId(threadId)).toBeNull();
    },
  );
});

describe('renderPromptfooTarget', () => {
  it('returns the PRD markdown or backlog, and an empty backlog when there is none', () => {
    expect(renderPromptfooTarget(prdPackage, 'artifact')).toBe(prdPackage.markdown);
    expect(renderPromptfooTarget(prdPackage, 'backlog')).toBe('{\n  "epics": []\n}');
    expect(renderPromptfooTarget({ ...prdPackage, backlogJson: null }, 'backlog')).toBe('');
  });

  it('renders one interview message per line, prefixed with its role', () => {
    const rendered = renderPromptfooTarget(
      {
        kind: 'interview_phase',
        phaseIndex: 1,
        messages: [
          { role: 'agent', text: 'Hello.\n\nWhat do you need?' },
          { role: 'user', text: 'A report.' },
        ],
        truncated: false,
        omittedMessages: 0,
      },
      'artifact',
    );
    expect(rendered).toBe('agent: Hello. What do you need?\nuser: A report.');
  });
});

describe('judge document specification', () => {
  it('accepts a complete judge specification', () => {
    expect(isAiRunV2DocumentSpecification(judgeSpecification())).toBe(true);
  });

  it.each([
    ['outputSchema', undefined],
    ['outputSchema', { type: 'object', properties: {} }],
    ['evaluation', undefined],
    ['evaluation', { ...evaluation, jobId: '' }],
    ['repository', 'apex'],
    ['groundedSha', 'abc123'],
    ['provider', 'ado'],
  ])('rejects a judge specification with %s = %p', (field, value) => {
    expect(isAiRunV2DocumentSpecification(judgeSpecification({ [field]: value }))).toBe(false);
  });

  it('rejects a judge specification missing an input file or carrying an unlisted one', () => {
    const inputs = judgeSpecification().scratchInputs as Array<{ path: string; content: string }>;
    expect(
      isAiRunV2DocumentSpecification(judgeSpecification({ scratchInputs: inputs.slice(1) })),
    ).toBe(false);
    expect(
      isAiRunV2DocumentSpecification(
        judgeSpecification({
          scratchInputs: [...inputs, { path: '.ai-pilot/evaluation/extra.json', content: '{}' }],
        }),
      ),
    ).toBe(false);
  });

  it('rejects judge-only fields on any other document workflow', () => {
    const skillContent = '# Validate';
    const validation = {
      workloadLane: 'document',
      prompt: 'Validate',
      model: 'claude-4',
      effort: null,
      skillPath: '.cursor/skills/prd-spec-review/SKILL.md',
      skillContent,
      skillSha256: createHash('sha256').update(skillContent).digest('hex'),
      workflowClass: 'validation',
      projectId: 'Apex',
      threadId: 'thread-1',
      deadlineMs: 60_000,
      scratchInputs: [{ path: '.ai-pilot/kickoff-context.md', content: '# Context' }],
    };
    expect(isAiRunV2DocumentSpecification(validation)).toBe(true);
    expect(isAiRunV2DocumentSpecification({ ...validation, evaluation })).toBe(false);
    expect(isAiRunV2DocumentSpecification({ ...validation, outputSchema: judgeSchema })).toBe(false);
  });
});
