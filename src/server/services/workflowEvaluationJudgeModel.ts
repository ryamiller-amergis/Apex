import type { EffortLevel } from '../../shared/types/effort';
import type { ProjectSkillConfig } from '../../shared/types/projectSettings';
import type { AdminEvaluationModelSource } from '../../shared/types/workflowEvaluationAdmin';
import { resolveEffort } from './agentEffortResolver';

export type ResolvedEvaluationJudgeModel = {
  model: string;
  effort: EffortLevel | null;
  source: AdminEvaluationModelSource;
};

/** The project's evaluation model wins, then PRD Validation's, then the app default. */
export async function resolveEvaluationJudgeModel(
  project: string,
  skillConfig: ProjectSkillConfig,
  loadDefaultModel: () => Promise<string>,
): Promise<ResolvedEvaluationJudgeModel> {
  const effort = skillConfig.evaluationJudgeEffort
    ?? resolveEffort({
      kickoff: { project, repo: skillConfig.skillRepo, agentModule: 'prdValidation' },
      skillConfig,
    })
    ?? null;
  if (skillConfig.evaluationJudgeModel) {
    return { model: skillConfig.evaluationJudgeModel, effort, source: 'evaluation' };
  }
  if (skillConfig.prdValidationModel) {
    return { model: skillConfig.prdValidationModel, effort, source: 'prd_validation' };
  }
  return { model: await loadDefaultModel(), effort, source: 'app_default' };
}
