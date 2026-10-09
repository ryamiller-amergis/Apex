import type { EffortLevel } from '../../shared/types/effort';
import { isEffortLevel } from '../../shared/types/effort';
import type { AgentModuleId, ChatThreadKickoff } from '../../shared/types/chat';
import type { ProjectSkillConfig } from '../../shared/types/projectSettings';

const MODULE_EFFORT_KEYS = {
  interview: 'interviewEffort',
  prd: 'prdEffort',
  adr: 'adrEffort',
  designDoc: 'designDocEffort',
  designDocAssistant: 'designDocAssistantEffort',
  designPrototype: 'designPrototypeEffort',
  testCase: 'testCaseEffort',
  designDocValidation: 'designDocValidationEffort',
  prdAssistant: 'prdAssistantEffort',
  prdValidation: 'prdValidationEffort',
  development: 'developmentEffort',
  standup: 'standupEffort',
  featureRequest: 'featureRequestEffort',
  technical: 'technicalEffort',
  issue: 'issueEffort',
  calendarAssistant: 'calendarAssistantEffort',
  loadTestGeneration: 'loadTestGenerationEffort',
  designModule: 'designModuleEffort',
  designModuleScoping: 'designModuleScopingEffort',
} as const satisfies Record<AgentModuleId, keyof ProjectSkillConfig>;

const SKILL_PATH_MODULES = [
  ['adrFinalizeSkillPath', 'adr'],
  ['adrAssistantSkillPath', 'adr'],
  ['prdSkillPath', 'prd'],
  ['prdAssistantSkillPath', 'prdAssistant'],
  ['prdValidationSkillPath', 'prdValidation'],
  ['designDocSkillPath', 'designDoc'],
  ['designDocAssistantSkillPath', 'designDocAssistant'],
  ['designPrototypeSkillPath', 'designPrototype'],
  ['testCaseSkillPath', 'testCase'],
  ['designDocValidationSkillPath', 'designDocValidation'],
  ['developmentSkillPath', 'development'],
  ['standupSkillPath', 'standup'],
  ['featureRequestSkillPath', 'featureRequest'],
  ['technicalSkillPath', 'technical'],
  ['issueSkillPath', 'issue'],
  ['calendarAssistantSkillPath', 'calendarAssistant'],
  ['loadTestGenerationSkillPath', 'loadTestGeneration'],
  ['designModuleSkillPath', 'designModule'],
  ['designModuleScopingSkillPath', 'designModuleScoping'],
] as const satisfies ReadonlyArray<
  readonly [keyof ProjectSkillConfig, AgentModuleId]
>;

export function isAgentModuleId(value: unknown): value is AgentModuleId {
  return typeof value === 'string' && value in MODULE_EFFORT_KEYS;
}

export function deriveAgentModule(
  kickoff: ChatThreadKickoff,
  skillConfig: ProjectSkillConfig | null
): AgentModuleId | undefined {
  if (kickoff.mode === 'development') return 'development';
  if (kickoff.mode?.startsWith('standup-')) return 'standup';

  switch (kickoff.assistantType) {
    case 'design-doc':
      return 'designDocAssistant';
    case 'prd':
      return 'prdAssistant';
    case 'adr':
      return 'adr';
    case 'calendar-work-item':
      return 'calendarAssistant';
  }

  if (!kickoff.skillPath || !skillConfig) return undefined;
  if (kickoff.skillPath === skillConfig.adrInterviewSkillPath) return 'adr';
  if (
    kickoff.skillPath === skillConfig.interviewSkillPath ||
    skillConfig.interviewSkillOptions?.some(
      (option) => option.path === kickoff.skillPath
    )
  ) {
    return 'interview';
  }

  for (const [key, moduleId] of SKILL_PATH_MODULES) {
    const configured = skillConfig[key];
    if (typeof configured === 'string' && configured === kickoff.skillPath) {
      return moduleId;
    }
  }
  return undefined;
}

export function resolveSelectedEffort(
  kickoff: ChatThreadKickoff,
  skillConfig: ProjectSkillConfig | null
): EffortLevel | undefined {
  if (!skillConfig) return undefined;

  const interviewOption = skillConfig.interviewSkillOptions?.find(
    (option) => option.path === kickoff.skillPath
  );
  if (isEffortLevel(interviewOption?.effort)) return interviewOption.effort;

  const skillPill = skillConfig.quickSkillPills?.find(
    (pill) =>
      pill.skillPath === kickoff.skillPath &&
      (!kickoff.pillLabel || pill.label === kickoff.pillLabel)
  );
  if (isEffortLevel(skillPill?.effort)) return skillPill.effort;

  const mcpPill = skillConfig.quickMcpPills?.find(
    (pill) =>
      pill.mcpServerName === kickoff.mcpPill?.mcpServerName &&
      (!kickoff.pillLabel || pill.label === kickoff.pillLabel)
  );
  return isEffortLevel(mcpPill?.effort) ? mcpPill.effort : undefined;
}

export function resolveEffort(input: {
  kickoff: ChatThreadKickoff;
  skillConfig: ProjectSkillConfig | null;
  selectedEffort?: unknown;
}): EffortLevel | undefined {
  if (isEffortLevel(input.selectedEffort)) return input.selectedEffort;

  if (input.kickoff.agentModule && input.skillConfig) {
    const effortKey = MODULE_EFFORT_KEYS[input.kickoff.agentModule];
    const moduleEffort = input.skillConfig[effortKey];
    if (isEffortLevel(moduleEffort)) return moduleEffort;
  }

  return isEffortLevel(input.skillConfig?.defaultEffort)
    ? input.skillConfig.defaultEffort
    : undefined;
}

/**
 * Cursor team policy blocks Composer variants selected through the `effort`
 * parameter, so Composer models are sent as the plain model id.
 */
function acceptsEffortParameter(model: string): boolean {
  return !model.trim().toLowerCase().startsWith('composer-');
}

/** The parameter names Cursor models use for reasoning effort. */
const EFFORT_PARAMETER_IDS = ['effort', 'reasoning_effort', 'reasoning'] as const;

export interface CursorModelParameterDefinition {
  id: string;
  values: ReadonlyArray<{ value: string }>;
}

/**
 * The parameter a model takes the effort level under, or null when none of
 * its parameters accepts that level. Cursor rejects a run whose parameter
 * name or value the model does not list.
 */
export function effortParameterFor(
  parameters: ReadonlyArray<CursorModelParameterDefinition>,
  effort: EffortLevel,
): string | null {
  for (const id of EFFORT_PARAMETER_IDS) {
    const definition = parameters.find((parameter) => parameter.id === id);
    if (definition?.values.some((option) => option.value === effort)) return id;
  }
  return null;
}

/**
 * `parameters` is the model's definition list from `Cursor.models.list()`.
 * Without it the effort is sent as `effort`, so callers that cannot read the
 * catalog must pass an effort the model accepts under that name.
 */
export function buildCursorModelSelection(
  model: string,
  effort?: EffortLevel,
  parameters?: ReadonlyArray<CursorModelParameterDefinition>,
): {
  id: string;
  params?: Array<{ id: string; value: EffortLevel }>;
} {
  if (!effort) return { id: model };
  const parameterId = parameters
    ? effortParameterFor(parameters, effort)
    : acceptsEffortParameter(model)
      ? 'effort'
      : null;
  return parameterId
    ? { id: model, params: [{ id: parameterId, value: effort }] }
    : { id: model };
}
