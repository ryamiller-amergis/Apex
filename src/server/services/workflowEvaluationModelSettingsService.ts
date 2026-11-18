/**
 * The one model and effort every workflow-evaluation judge in a project runs
 * on, edited from Admin -> Workflow evaluations.
 */
import { isEffortLevel } from '../../shared/types/effort';
import {
  ADMIN_EVALUATION_MODEL_MAX_LENGTH,
  type AdminEvaluationModelSettings,
  type UpdateAdminEvaluationModelSettingsRequest,
} from '../../shared/types/workflowEvaluationAdmin';
import type { ProjectSkillConfig } from '../../shared/types/projectSettings';
import { getDefaultModel } from './appSettingsService';
import { getSkillConfig, setEvaluationJudgeSettings } from './projectSettingsService';
import { resolveEvaluationJudgeModel } from './workflowEvaluationJudgeModel';
import { AdminEvaluationRequestError } from './workflowEvaluationAdminService';

async function toSettings(
  project: string,
  config: ProjectSkillConfig | null,
): Promise<AdminEvaluationModelSettings> {
  if (!config) return { hasSkillConfig: false, model: null, effort: null, effective: null };
  return {
    hasSkillConfig: true,
    model: config.evaluationJudgeModel ?? null,
    effort: config.evaluationJudgeEffort ?? null,
    effective: await resolveEvaluationJudgeModel(project, config, getDefaultModel),
  };
}

export function parseEvaluationModelSettings(body: unknown): UpdateAdminEvaluationModelSettingsRequest {
  const input = (body ?? {}) as Record<string, unknown>;
  const { model, effort } = input;
  if (effort !== null && !isEffortLevel(effort)) {
    throw new AdminEvaluationRequestError('effort must be low, medium, high or null');
  }
  if (model === null) return { model: null, effort };
  if (typeof model !== 'string' || !model.trim() || model.length > ADMIN_EVALUATION_MODEL_MAX_LENGTH) {
    throw new AdminEvaluationRequestError('model must be a model id or null');
  }
  return { model: model.trim(), effort };
}

export async function getEvaluationModelSettings(project: string): Promise<AdminEvaluationModelSettings> {
  return toSettings(project, await getSkillConfig(project));
}

/** Returns null when the project has no default skill configuration to store it on. */
export async function updateEvaluationModelSettings(
  project: string,
  settings: UpdateAdminEvaluationModelSettingsRequest,
  updatedBy?: string,
): Promise<AdminEvaluationModelSettings | null> {
  const config = await setEvaluationJudgeSettings(project, settings, updatedBy);
  return config ? toSettings(project, config) : null;
}
