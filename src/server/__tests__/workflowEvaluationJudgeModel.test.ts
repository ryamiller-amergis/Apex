import type { ProjectSkillConfig } from '../../shared/types/projectSettings';
import { resolveEvaluationJudgeModel } from '../services/workflowEvaluationJudgeModel';

function config(overrides: Partial<ProjectSkillConfig>): ProjectSkillConfig {
  return { skillRepo: 'repo', ...overrides } as ProjectSkillConfig;
}

describe('resolveEvaluationJudgeModel', () => {
  const loadDefault = jest.fn(async () => 'composer-2.5');

  beforeEach(() => loadDefault.mockClear());

  it('uses the evaluation model and effort when set', async () => {
    const result = await resolveEvaluationJudgeModel(
      'proj',
      config({ evaluationJudgeModel: 'judge', evaluationJudgeEffort: 'low', prdValidationModel: 'prd' }),
      loadDefault,
    );
    expect(result).toEqual({ model: 'judge', effort: 'low', source: 'evaluation' });
    expect(loadDefault).not.toHaveBeenCalled();
  });

  it('falls back to the PRD Validation model and effort', async () => {
    const result = await resolveEvaluationJudgeModel(
      'proj',
      config({ prdValidationModel: 'prd', prdValidationEffort: 'high' }),
      loadDefault,
    );
    expect(result).toEqual({ model: 'prd', effort: 'high', source: 'prd_validation' });
  });

  it('falls back to the app default model', async () => {
    const result = await resolveEvaluationJudgeModel('proj', config({}), loadDefault);
    expect(result).toEqual({ model: 'composer-2.5', effort: null, source: 'app_default' });
  });
});
