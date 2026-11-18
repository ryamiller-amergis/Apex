import { isAiRunV2DocumentSpecification } from '../../shared/types/aiRunV2DocumentSpec';
import {
  buildSkillLearningSpecification,
  parseSkillLearningThreadId,
  skillLearningThreadId,
} from '../services/skillLearningRuns';

jest.mock('../services/aiRunV2/v2AdmissionService', () => ({ createV2AdmissionService: jest.fn() }));
jest.mock('../services/appSettingsService', () => ({ getDefaultModel: jest.fn().mockResolvedValue('default-model') }));
jest.mock('../services/projectSettingsService', () => ({ resolveSkillConfig: jest.fn().mockResolvedValue({ skillRepo: 'repo' }) }));
jest.mock('../services/workflowEvaluationJudgeModel', () => ({
  resolveEvaluationJudgeModel: jest.fn().mockResolvedValue({ model: 'judge-model', effort: null, source: 'evaluation' }),
}));

const SCHEMA = { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } };

describe('skillLearningRuns', () => {
  it('round-trips thread ids, keeping colons in the subject key', () => {
    const threadId = skillLearningThreadId('artifact_judge', 'brainstorm_artifact:abc:3');
    expect(parseSkillLearningThreadId(threadId)).toEqual({ task: 'artifact_judge', subjectKey: 'brainstorm_artifact:abc:3' });
    expect(parseSkillLearningThreadId('skill-learning:unknown:x')).toBeNull();
    expect(parseSkillLearningThreadId('skill-replay:run:generate')).toBeNull();
  });

  it('builds a document specification the worker accepts, with the model chosen on App Service', async () => {
    const spec = await buildSkillLearningSpecification({
      project: 'Apex',
      task: 'candidate',
      subjectKey: 'exp-1',
      skillPath: 'apex/skill-learning-candidate@1',
      instructions: '# Instructions',
      input: { currentSkill: '# Skill' },
      outputSchema: SCHEMA,
    });
    expect(spec).toEqual(expect.objectContaining({
      workflowClass: 'skill-learning',
      model: 'judge-model',
      effort: null,
      threadId: 'skill-learning:candidate:exp-1',
      outputSchema: SCHEMA,
    }));
    expect(isAiRunV2DocumentSpecification(spec)).toBe(true);
  });

  it('refuses a Skill Learning specification without a closed output schema or with a repository', async () => {
    const spec = await buildSkillLearningSpecification({
      project: 'Apex',
      task: 'candidate',
      subjectKey: 'exp-1',
      skillPath: 'apex/skill-learning-candidate@1',
      instructions: '# Instructions',
      input: {},
      outputSchema: SCHEMA,
    });
    expect(isAiRunV2DocumentSpecification({ ...spec, outputSchema: undefined })).toBe(false);
    expect(isAiRunV2DocumentSpecification({ ...spec, outputSchema: { type: 'object', properties: {} } })).toBe(false);
    expect(isAiRunV2DocumentSpecification({ ...spec, repository: 'repo' })).toBe(false);
    expect(isAiRunV2DocumentSpecification({
      ...spec,
      scratchInputs: [...spec.scratchInputs, { path: '.ai-pilot/evaluation/rubric.json', content: '{}' }],
    })).toBe(false);
  });
});
