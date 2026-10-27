import type { EffortLevel } from '../types/effort';
import type { ProjectSkillConfig } from '../types/projectSettings';

/**
 * Per-workflow settings stored in `project_skill_workflow_settings`, one row per
 * `(settings_id, workflow)`. A workflow with no overrides has no row.
 */
export interface ProjectSkillWorkflowSettings {
  skillPath: string | null;
  model: string | null;
  effort: EffortLevel | null;
  bedrockModelId: string | null;
  bedrockMaxTokens: number | null;
  bedrockTimeoutMs: number | null;
  bedrockTemperature: number | null;
  regenBedrockModelId: string | null;
  regenBedrockMaxTokens: number | null;
  scoreThreshold: number | null;
}

export type ProjectSkillWorkflowField = keyof ProjectSkillWorkflowSettings;

export const PROJECT_SKILL_WORKFLOW_FIELDS = [
  'skillPath',
  'model',
  'effort',
  'bedrockModelId',
  'bedrockMaxTokens',
  'bedrockTimeoutMs',
  'bedrockTemperature',
  'regenBedrockModelId',
  'regenBedrockMaxTokens',
  'scoreThreshold',
] as const satisfies readonly ProjectSkillWorkflowField[];

export interface ProjectSkillWorkflowDefinition {
  key: string;
  /** Child-row field → the flat `ProjectSkillConfig` field it replaces. */
  legacy: Partial<Record<ProjectSkillWorkflowField, keyof ProjectSkillConfig>>;
}

/**
 * Every AI workflow with per-project settings. Adding a workflow is one entry
 * here; while the legacy columns exist (rollout steps 1-4) it also needs its
 * flat fields and the backfill row in the migration.
 *
 * The three ADR workflows share `adrModel` / `adrEffort` in the flat shape.
 */
export const PROJECT_SKILL_WORKFLOWS = [
  {
    key: 'interview',
    legacy: { skillPath: 'interviewSkillPath', model: 'interviewModel', effort: 'interviewEffort' },
  },
  { key: 'prd', legacy: { skillPath: 'prdSkillPath', model: 'prdModel', effort: 'prdEffort' } },
  {
    key: 'adr_interview',
    legacy: { skillPath: 'adrInterviewSkillPath', model: 'adrModel', effort: 'adrEffort' },
  },
  {
    key: 'adr_finalize',
    legacy: { skillPath: 'adrFinalizeSkillPath', model: 'adrModel', effort: 'adrEffort' },
  },
  {
    key: 'adr_assistant',
    legacy: { skillPath: 'adrAssistantSkillPath', model: 'adrModel', effort: 'adrEffort' },
  },
  {
    key: 'design_doc',
    legacy: { skillPath: 'designDocSkillPath', model: 'designDocModel', effort: 'designDocEffort' },
  },
  {
    key: 'design_doc_assistant',
    legacy: {
      skillPath: 'designDocAssistantSkillPath',
      model: 'designDocAssistantModel',
      effort: 'designDocAssistantEffort',
    },
  },
  {
    key: 'design_doc_validation',
    legacy: {
      skillPath: 'designDocValidationSkillPath',
      model: 'designDocValidationModel',
      effort: 'designDocValidationEffort',
      scoreThreshold: 'designDocValidationScoreThreshold',
    },
  },
  {
    key: 'design_prototype',
    legacy: {
      skillPath: 'designPrototypeSkillPath',
      model: 'designPrototypeModel',
      effort: 'designPrototypeEffort',
      bedrockModelId: 'designPrototypeBedrockModelId',
      bedrockMaxTokens: 'designPrototypeBedrockMaxTokens',
      bedrockTimeoutMs: 'designPrototypeBedrockTimeoutMs',
      regenBedrockModelId: 'designPrototypeRegenBedrockModelId',
      regenBedrockMaxTokens: 'designPrototypeRegenBedrockMaxTokens',
    },
  },
  {
    key: 'design_plan',
    legacy: {
      bedrockModelId: 'designPlanBedrockModelId',
      bedrockMaxTokens: 'designPlanBedrockMaxTokens',
    },
  },
  {
    key: 'test_case',
    legacy: { skillPath: 'testCaseSkillPath', model: 'testCaseModel', effort: 'testCaseEffort' },
  },
  {
    key: 'prd_assistant',
    legacy: {
      skillPath: 'prdAssistantSkillPath',
      model: 'prdAssistantModel',
      effort: 'prdAssistantEffort',
    },
  },
  {
    key: 'prd_validation',
    legacy: {
      skillPath: 'prdValidationSkillPath',
      model: 'prdValidationModel',
      effort: 'prdValidationEffort',
      scoreThreshold: 'prdValidationScoreThreshold',
    },
  },
  {
    key: 'prd_review',
    legacy: {
      bedrockModelId: 'prdReviewBedrockModelId',
      bedrockMaxTokens: 'prdReviewBedrockMaxTokens',
    },
  },
  {
    key: 'ui_lab',
    legacy: {
      skillPath: 'uiLabSkillPath',
      bedrockModelId: 'uiLabBedrockModelId',
      bedrockMaxTokens: 'uiLabBedrockMaxTokens',
      bedrockTimeoutMs: 'uiLabBedrockTimeoutMs',
      bedrockTemperature: 'uiLabBedrockTemperature',
      regenBedrockModelId: 'uiLabRegenBedrockModelId',
      regenBedrockMaxTokens: 'uiLabRegenBedrockMaxTokens',
    },
  },
  {
    key: 'development',
    legacy: {
      skillPath: 'developmentSkillPath',
      model: 'developmentModel',
      effort: 'developmentEffort',
    },
  },
  {
    key: 'standup',
    legacy: { skillPath: 'standupSkillPath', model: 'standupModel', effort: 'standupEffort' },
  },
  {
    key: 'feature_request',
    legacy: {
      skillPath: 'featureRequestSkillPath',
      model: 'featureRequestModel',
      effort: 'featureRequestEffort',
    },
  },
  {
    key: 'technical',
    legacy: { skillPath: 'technicalSkillPath', model: 'technicalModel', effort: 'technicalEffort' },
  },
  {
    key: 'issue',
    legacy: { skillPath: 'issueSkillPath', model: 'issueModel', effort: 'issueEffort' },
  },
  {
    key: 'calendar_assistant',
    legacy: {
      skillPath: 'calendarAssistantSkillPath',
      model: 'calendarAssistantModel',
      effort: 'calendarAssistantEffort',
    },
  },
  {
    key: 'load_test_generation',
    legacy: {
      skillPath: 'loadTestGenerationSkillPath',
      model: 'loadTestGenerationModel',
      effort: 'loadTestGenerationEffort',
    },
  },
  {
    key: 'design_module',
    legacy: {
      skillPath: 'designModuleSkillPath',
      model: 'designModuleModel',
      effort: 'designModuleEffort',
    },
  },
  {
    key: 'design_module_scoping',
    legacy: {
      skillPath: 'designModuleScopingSkillPath',
      model: 'designModuleScopingModel',
      effort: 'designModuleScopingEffort',
    },
  },
] as const satisfies readonly ProjectSkillWorkflowDefinition[];

export type ProjectSkillWorkflowKey = (typeof PROJECT_SKILL_WORKFLOWS)[number]['key'];

/** Every flat `ProjectSkillConfig` field the registry replaces, without duplicates. */
export function legacyWorkflowFields(): Array<keyof ProjectSkillConfig> {
  const fields = new Set<keyof ProjectSkillConfig>();
  for (const workflow of PROJECT_SKILL_WORKFLOWS) {
    for (const legacyField of Object.values(workflow.legacy)) fields.add(legacyField);
  }
  return [...fields];
}

/** One workflow's child-row values, read from the flat legacy fields. */
export function workflowSettingsFromLegacy(
  workflow: ProjectSkillWorkflowDefinition,
  legacy: Partial<Record<keyof ProjectSkillConfig, unknown>>,
): ProjectSkillWorkflowSettings {
  const settings = {} as Record<ProjectSkillWorkflowField, unknown>;
  for (const field of PROJECT_SKILL_WORKFLOW_FIELDS) {
    const legacyField = workflow.legacy[field];
    settings[field] = legacyField ? (legacy[legacyField] ?? null) : null;
  }
  return settings as unknown as ProjectSkillWorkflowSettings;
}

/** True when no field carries an override, so the workflow needs no child row. */
export function isEmptyWorkflowSettings(settings: ProjectSkillWorkflowSettings): boolean {
  return PROJECT_SKILL_WORKFLOW_FIELDS.every((field) => settings[field] === null);
}
