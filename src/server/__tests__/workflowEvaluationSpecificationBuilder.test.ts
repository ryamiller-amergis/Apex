import { createHash } from 'node:crypto';
import {
  WORKFLOW_EVALUATION_PACKAGE_MAX_BYTES,
  WORKFLOW_EVALUATION_SCRATCH_PATHS,
  type WorkflowEvaluationArtifactPackage,
} from '../../shared/types/aiRunV2EvaluationSpec';
import type { ProjectSkillConfig } from '../../shared/types/projectSettings';
import {
  WORKFLOW_EVALUATION_DESIGN_DOC_RUBRIC,
  WORKFLOW_EVALUATION_INTERVIEW_PHASE_RUBRIC,
  WORKFLOW_EVALUATION_PRD_RUBRIC,
  workflowEvaluationPromptfooSuiteRef,
} from '../../shared/types/workflowEvaluation';
import {
  hashDesignDocArtifact,
  hashInterviewPhaseArtifact,
  hashPrdArtifact,
} from '../services/artifactBindingResolver';
import type { DesignDocEvaluationInputs } from '../services/designDocService';
import type { InterviewEvaluationInputs } from '../services/interviewService';
import type { PrdEvaluationInputs } from '../services/prdService';
import {
  buildWorkflowEvaluationSpecifications,
  renderDesignDocMarkdown,
  type WorkflowEvaluationSpecificationDependencies,
  type WorkflowEvaluationSpecificationRequest,
} from '../services/workflowEvaluationSpecificationBuilder';

jest.mock('../db/drizzle', () => ({ db: {} }));
jest.mock('../services/prdService', () => ({ getPrdEvaluationInputs: jest.fn() }));
jest.mock('../services/interviewService', () => ({ getInterviewEvaluationInputs: jest.fn() }));
jest.mock('../services/designDocService', () => ({ getDesignDocEvaluationInputs: jest.fn() }));
jest.mock('../services/projectSettingsService', () => ({ resolveSkillConfig: jest.fn() }));
jest.mock('../services/appSettingsService', () => ({ getDefaultModel: jest.fn() }));

const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    missedRequirements: { type: 'array' },
    inventedRequirements: { type: 'array' },
    recommendedImprovements: { type: 'array' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
  required: ['missedRequirements', 'inventedRequirements', 'recommendedImprovements', 'confidence'],
  additionalProperties: false,
};

const CRITERIA = {
  intent_alignment: 4,
  requirements_coverage: 2,
  scope_alignment: 3,
  acceptance_criteria: 3,
  readiness: 2,
} as const;

const PRD_MARKDOWN = '# Reporting PRD\n\n## Problem Statement\nUsers cannot export.\n\n## Solution\nAdd export.\n';
const BACKLOG = { personas: [], businessRules: [], epics: [], implementationPhases: [], assumptionsMade: [] };

const INTERVIEW: InterviewEvaluationInputs = {
  id: 'interview-1',
  project: 'Apex',
  model: null,
  skillPath: null,
  skillVersion: null,
  phaseCount: 3,
  currentPhase: 3,
  phases: [
    {
      phaseIndex: 1,
      messages: [
        { role: 'agent', text: 'What problem are we solving?' },
        { role: 'user', text: 'Users cannot export reports.' },
      ],
    },
    {
      phaseIndex: 2,
      messages: [
        { role: 'agent', text: 'Which formats?' },
        { role: 'user', text: 'CSV only.' },
      ],
    },
  ],
  linkedContextIds: { adrIds: [], designModuleIds: [] },
};

function prdInputs(overrides: Partial<PrdEvaluationInputs> = {}): PrdEvaluationInputs {
  return {
    id: 'prd-1',
    project: 'Apex',
    status: 'in_review',
    interviewId: 'interview-1',
    model: null,
    skillPath: null,
    skillVersion: null,
    content: PRD_MARKDOWN,
    backlogJson: BACKLOG,
    ...overrides,
  };
}

function prdRequest(
  overrides: Partial<WorkflowEvaluationSpecificationRequest['event']> = {},
  definition: Partial<WorkflowEvaluationSpecificationRequest['definition']> = {},
): WorkflowEvaluationSpecificationRequest {
  return {
    event: {
      id: 'event-1',
      projectId: 'Apex',
      stageKey: 'prd_human_review',
      subjectType: 'prd',
      subjectId: 'prd-1',
      phaseIndex: null,
      artifactContentHash: hashPrdArtifact(PRD_MARKDOWN, BACKLOG),
      criteria: CRITERIA,
      ...overrides,
    },
    definition: {
      version: 1,
      rubric: WORKFLOW_EVALUATION_PRD_RUBRIC,
      promptfooSuiteRef: workflowEvaluationPromptfooSuiteRef('prd_human_review'),
      judgeOutputSchema: JUDGE_SCHEMA,
      ...definition,
    },
    jobIds: { promptfoo: 'job-promptfoo', llm_judge: 'job-judge' },
  };
}

function interviewRequest(phaseIndex = 2): WorkflowEvaluationSpecificationRequest {
  const phase = INTERVIEW.phases.find((item) => item.phaseIndex === phaseIndex);
  return {
    event: {
      id: 'event-2',
      projectId: 'Apex',
      stageKey: `interview_phase_${phaseIndex}`,
      subjectType: 'interview_phase',
      subjectId: 'interview-1',
      phaseIndex,
      artifactContentHash: hashInterviewPhaseArtifact(phase?.messages ?? [], INTERVIEW.linkedContextIds),
      criteria: CRITERIA,
    },
    definition: {
      version: 1,
      rubric: WORKFLOW_EVALUATION_INTERVIEW_PHASE_RUBRIC,
      promptfooSuiteRef: workflowEvaluationPromptfooSuiteRef(`interview_phase_${phaseIndex}`),
      judgeOutputSchema: JUDGE_SCHEMA,
    },
    jobIds: { promptfoo: 'job-promptfoo', llm_judge: 'job-judge' },
  };
}

function dependencies(
  overrides: Partial<WorkflowEvaluationSpecificationDependencies> = {},
): WorkflowEvaluationSpecificationDependencies {
  return {
    loadPrdInputs: async () => prdInputs(),
    loadInterviewInputs: async () => INTERVIEW,
    loadSkillConfig: async () => ({
      skillRepo: 'apex',
      prdValidationModel: 'claude-4-opus',
      prdValidationEffort: 'high',
    }) as unknown as ProjectSkillConfig,
    loadDefaultModel: async () => 'default-model',
    ...overrides,
  };
}

function scratchJson(
  specification: { scratchInputs?: ReadonlyArray<{ path: string; content: string }> },
  path: string,
): Record<string, unknown> {
  const input = specification.scratchInputs?.find((item) => item.path === path);
  if (!input) throw new Error(`missing scratch input ${path}`);
  return JSON.parse(input.content) as Record<string, unknown>;
}

describe('buildWorkflowEvaluationSpecifications', () => {
  it('builds both PRD specifications from the live artifact with the source transcript', async () => {
    const result = await buildWorkflowEvaluationSpecifications(prdRequest(), dependencies());

    if (!result.promptfoo.ok || !result.llm_judge.ok) throw new Error('expected both to build');
    const promptfoo = result.promptfoo.specification;
    expect(promptfoo.threadId).toBe('wfeval:event-1:promptfoo');
    expect(promptfoo.evaluation).toEqual({
      eventId: 'event-1',
      jobId: 'job-promptfoo',
      stageKey: 'prd_human_review',
      rubricVersion: 1,
      artifactHash: hashPrdArtifact(PRD_MARKDOWN, BACKLOG),
    });
    expect(promptfoo.suite.ref).toBe('orchestrated_workflow/prd_human_review/structural@1');
    expect(promptfoo.suiteSha256).toBe(
      createHash('sha256').update(JSON.stringify(promptfoo.suite)).digest('hex'),
    );
    expect(promptfoo.artifactPackage).toEqual({
      kind: 'prd',
      markdown: PRD_MARKDOWN,
      backlogJson: JSON.stringify(BACKLOG, null, 2),
      sourceTranscript: [...INTERVIEW.phases[0].messages, ...INTERVIEW.phases[1].messages],
      truncated: false,
      omittedSections: [],
      omittedMessages: 0,
    });
    expect(result.promptfoo.specificationHash).toBe(
      createHash('sha256').update(JSON.stringify(promptfoo)).digest('hex'),
    );

    const judge = result.llm_judge.specification;
    expect(judge.workflowClass).toBe('evaluation-judge');
    expect(judge.threadId).toBe('wfeval:event-1:llm_judge');
    expect(judge.evaluation?.jobId).toBe('job-judge');
    expect(judge.model).toBe('claude-4-opus');
    expect(judge.effort).toBe('high');
    expect(judge.outputSchema).toEqual(JUDGE_SCHEMA);
    expect(judge.skillSha256).toBe(createHash('sha256').update(judge.skillContent).digest('hex'));
    expect(scratchJson(judge, WORKFLOW_EVALUATION_SCRATCH_PATHS.outputSchema)).toEqual(JUDGE_SCHEMA);
    expect(scratchJson(judge, WORKFLOW_EVALUATION_SCRATCH_PATHS.rubric)).toEqual(
      JSON.parse(JSON.stringify({
        version: 1,
        criteria: WORKFLOW_EVALUATION_PRD_RUBRIC.criteria,
        scale: WORKFLOW_EVALUATION_PRD_RUBRIC.scale,
      })),
    );
  });

  it('gives the person\'s scores to the judge as hints but never to Promptfoo', async () => {
    const result = await buildWorkflowEvaluationSpecifications(prdRequest(), dependencies());

    if (!result.promptfoo.ok || !result.llm_judge.ok) throw new Error('expected both to build');
    const artifact = scratchJson(result.llm_judge.specification, WORKFLOW_EVALUATION_SCRATCH_PATHS.artifactPackage);
    expect(artifact.humanScoreHints).toEqual(CRITERIA);
    expect(JSON.stringify(result.promptfoo.specification)).not.toContain('humanScoreHints');
  });

  it('falls back to the default model when the project sets no PRD validation model', async () => {
    const result = await buildWorkflowEvaluationSpecifications(
      prdRequest(),
      dependencies({
        loadSkillConfig: async () => ({ skillRepo: 'apex' }) as unknown as ProjectSkillConfig,
      }),
    );

    if (!result.llm_judge.ok) throw new Error('expected judge to build');
    expect(result.llm_judge.specification.model).toBe('default-model');
    expect(result.llm_judge.specification.effort).toBeNull();
  });

  it('uses the project judge model and effort ahead of the PRD validation ones', async () => {
    const result = await buildWorkflowEvaluationSpecifications(
      prdRequest(),
      dependencies({
        loadSkillConfig: async () => ({
          skillRepo: 'apex',
          prdValidationModel: 'claude-4-opus',
          prdValidationEffort: 'high',
          evaluationJudgeModel: 'gpt-judge',
          evaluationJudgeEffort: 'low',
        }) as unknown as ProjectSkillConfig,
      }),
    );

    if (!result.llm_judge.ok) throw new Error('expected judge to build');
    expect(result.llm_judge.specification.model).toBe('gpt-judge');
    expect(result.llm_judge.specification.effort).toBe('low');
  });

  it('packages only the evaluated interview phase', async () => {
    const result = await buildWorkflowEvaluationSpecifications(interviewRequest(2), dependencies());

    if (!result.promptfoo.ok || !result.llm_judge.ok) throw new Error('expected both to build');
    expect(result.promptfoo.specification.artifactPackage).toEqual({
      kind: 'interview_phase',
      phaseIndex: 2,
      messages: INTERVIEW.phases[1].messages,
      truncated: false,
      omittedMessages: 0,
    });
    expect(result.promptfoo.specification.suite.subjectType).toBe('interview_phase');
  });

  it('fails both jobs with artifact_changed when the PRD was edited after submission', async () => {
    const result = await buildWorkflowEvaluationSpecifications(
      prdRequest(),
      dependencies({ loadPrdInputs: async () => prdInputs({ content: `${PRD_MARKDOWN}\nEdited.` }) }),
    );

    expect(result.promptfoo).toMatchObject({ ok: false, code: 'artifact_changed' });
    expect(result.llm_judge).toMatchObject({ ok: false, code: 'artifact_changed' });
  });

  it('fails both jobs with artifact_changed when the interview phase was edited', async () => {
    const edited: InterviewEvaluationInputs = {
      ...INTERVIEW,
      phases: [INTERVIEW.phases[0], { phaseIndex: 2, messages: [{ role: 'agent', text: 'Changed?' }] }],
    };
    const result = await buildWorkflowEvaluationSpecifications(
      interviewRequest(2),
      dependencies({ loadInterviewInputs: async () => edited }),
    );

    expect(result.promptfoo).toMatchObject({ ok: false, code: 'artifact_changed' });
    expect(result.llm_judge).toMatchObject({ ok: false, code: 'artifact_changed' });
  });

  it.each([
    ['the PRD is gone', { loadPrdInputs: async () => null }],
    ['the PRD belongs to another project', { loadPrdInputs: async () => prdInputs({ project: 'Other' }) }],
    ['the PRD is blank', { loadPrdInputs: async () => prdInputs({ content: '  ' }) }],
  ])('fails both jobs with artifact_unavailable when %s', async (_label, overrides) => {
    const result = await buildWorkflowEvaluationSpecifications(prdRequest(), dependencies(overrides));

    expect(result.promptfoo).toMatchObject({ ok: false, code: 'artifact_unavailable' });
    expect(result.llm_judge).toMatchObject({ ok: false, code: 'artifact_unavailable' });
  });

  it('fails both jobs with artifact_unavailable when the interview phase has no messages', async () => {
    const result = await buildWorkflowEvaluationSpecifications(interviewRequest(3), dependencies());

    expect(result.promptfoo).toMatchObject({ ok: false, code: 'artifact_unavailable' });
    expect(result.llm_judge).toMatchObject({ ok: false, code: 'artifact_unavailable' });
  });

  it('fails only Promptfoo with suite_missing when the ref is not registered', async () => {
    const result = await buildWorkflowEvaluationSpecifications(
      prdRequest({}, { promptfooSuiteRef: 'orchestrated_workflow/prd_human_review/structural@99' }),
      dependencies(),
    );

    expect(result.promptfoo).toMatchObject({ ok: false, code: 'suite_missing' });
    expect(result.llm_judge.ok).toBe(true);
  });

  it('fails only the judge with skill_config_missing when the project has no skill config', async () => {
    const result = await buildWorkflowEvaluationSpecifications(
      prdRequest(),
      dependencies({ loadSkillConfig: async () => null }),
    );

    expect(result.promptfoo.ok).toBe(true);
    expect(result.llm_judge).toMatchObject({ ok: false, code: 'skill_config_missing' });
  });

  it('fails only the judge with specification_invalid when the output schema allows extra fields', async () => {
    const result = await buildWorkflowEvaluationSpecifications(
      prdRequest({}, { judgeOutputSchema: { ...JUDGE_SCHEMA, additionalProperties: true } }),
      dependencies(),
    );

    expect(result.promptfoo.ok).toBe(true);
    expect(result.llm_judge).toMatchObject({ ok: false, code: 'specification_invalid' });
  });

  it('returns a failure instead of throwing when a loader rejects', async () => {
    const result = await buildWorkflowEvaluationSpecifications(
      prdRequest(),
      dependencies({ loadPrdInputs: async () => { throw new Error('database is down'); } }),
    );

    expect(result.promptfoo).toEqual({ ok: false, code: 'specification_invalid', message: 'database is down' });
    expect(result.llm_judge).toEqual({ ok: false, code: 'specification_invalid', message: 'database is down' });
  });

  it('drops whole sections, then the backlog, then transcript messages to stay under the size limit', async () => {
    const big = 'x'.repeat(WORKFLOW_EVALUATION_PACKAGE_MAX_BYTES / 2);
    const markdown = `# Big PRD\n\n## Problem Statement\n${big}\n## Solution\n${big}\n## Out of Scope\nNone.\n`;
    const result = await buildWorkflowEvaluationSpecifications(
      prdRequest({ artifactContentHash: hashPrdArtifact(markdown, BACKLOG) }),
      dependencies({ loadPrdInputs: async () => prdInputs({ content: markdown }) }),
    );

    if (!result.promptfoo.ok) throw new Error('expected Promptfoo to build');
    const pkg = result.promptfoo.specification.artifactPackage as Extract<
      WorkflowEvaluationArtifactPackage,
      { kind: 'prd' }
    >;
    expect(pkg.truncated).toBe(true);
    expect(pkg.markdown).toContain('## Problem Statement');
    expect(pkg.markdown).toContain('## Out of Scope');
    expect(pkg.markdown).not.toContain('## Solution');
    expect(pkg.omittedSections).toContain('Solution');
    expect(Buffer.byteLength(JSON.stringify(pkg), 'utf8')).toBeLessThan(
      WORKFLOW_EVALUATION_PACKAGE_MAX_BYTES + 1024,
    );
  });

  it('always keeps the first interview message even when it alone is over the limit', async () => {
    const huge = 'y'.repeat(WORKFLOW_EVALUATION_PACKAGE_MAX_BYTES + 10);
    const phase = {
      phaseIndex: 1,
      messages: [
        { role: 'agent' as const, text: huge },
        { role: 'user' as const, text: 'Short answer.' },
      ],
    };
    const interview: InterviewEvaluationInputs = { ...INTERVIEW, phases: [phase] };
    const request = interviewRequest(1);
    const result = await buildWorkflowEvaluationSpecifications(
      {
        ...request,
        event: {
          ...request.event,
          artifactContentHash: hashInterviewPhaseArtifact(phase.messages, INTERVIEW.linkedContextIds),
        },
      },
      dependencies({ loadInterviewInputs: async () => interview }),
    );

    if (!result.promptfoo.ok) throw new Error('expected Promptfoo to build');
    expect(result.promptfoo.specification.artifactPackage).toMatchObject({
      kind: 'interview_phase',
      messages: [{ role: 'agent', text: huge }],
      truncated: true,
      omittedMessages: 1,
    });
  });

  describe('design docs', () => {
    const DOC: DesignDocEvaluationInputs = {
      id: 'dd-1',
      project: 'Apex',
      status: 'reviewer_approved',
      prdId: 'prd-1',
      interviewId: 'interview-1',
      model: null,
      skillPath: null,
      skillVersion: null,
      designContent: '## Feature Summary\nExport reports.\n',
      techSpecContent: '## Testing Strategy\nUnit tests.\n',
      assumptionsContent: '## Assumptions Accepted\nCSV only.\n',
    };

    function designDocRequest(hash = hashDesignDocArtifact(DOC)): WorkflowEvaluationSpecificationRequest {
      return {
        event: {
          id: 'event-3',
          projectId: 'Apex',
          stageKey: 'design_doc_human_review',
          subjectType: 'design_doc',
          subjectId: 'dd-1',
          phaseIndex: null,
          artifactContentHash: hash,
          criteria: CRITERIA,
        },
        definition: {
          version: 1,
          rubric: WORKFLOW_EVALUATION_DESIGN_DOC_RUBRIC,
          promptfooSuiteRef: workflowEvaluationPromptfooSuiteRef('design_doc_human_review'),
          judgeOutputSchema: JUDGE_SCHEMA,
        },
        jobIds: { promptfoo: 'job-promptfoo', llm_judge: 'job-judge' },
      };
    }

    it('packages the design doc with its source PRD for both jobs', async () => {
      const result = await buildWorkflowEvaluationSpecifications(
        designDocRequest(),
        dependencies({ loadDesignDocInputs: async () => DOC }),
      );

      if (!result.promptfoo.ok || !result.llm_judge.ok) throw new Error('expected both to build');
      expect(result.promptfoo.specification.suite.subjectType).toBe('design_doc');
      expect(result.promptfoo.specification.artifactPackage).toEqual({
        kind: 'design_doc',
        markdown: renderDesignDocMarkdown(DOC),
        sourcePrd: PRD_MARKDOWN,
        truncated: false,
        omittedSections: [],
        omittedMessages: 0,
      });
      const artifact = scratchJson(result.llm_judge.specification, WORKFLOW_EVALUATION_SCRATCH_PATHS.artifactPackage);
      expect(artifact).toMatchObject({ kind: 'design_doc', sourcePrd: PRD_MARKDOWN, humanScoreHints: CRITERIA });
    });

    it('fails both jobs when the design doc changed after submission', async () => {
      const result = await buildWorkflowEvaluationSpecifications(
        designDocRequest('c'.repeat(64)),
        dependencies({ loadDesignDocInputs: async () => DOC }),
      );
      expect(result.promptfoo).toMatchObject({ ok: false, code: 'artifact_changed' });
      expect(result.llm_judge).toMatchObject({ ok: false, code: 'artifact_changed' });
    });

    it('still builds without the source PRD', async () => {
      const result = await buildWorkflowEvaluationSpecifications(
        designDocRequest(),
        dependencies({ loadDesignDocInputs: async () => DOC, loadPrdInputs: async () => null }),
      );
      if (!result.promptfoo.ok) throw new Error('expected Promptfoo to build');
      expect(result.promptfoo.specification.artifactPackage).toMatchObject({ kind: 'design_doc', sourcePrd: null });
    });
  });
});
