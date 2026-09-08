import type { EffortLevel } from '../../shared/types/effort';
import { isEffortLevel } from '../../shared/types/effort';
import type {
  AgentModuleId,
  ChatThreadKickoff,
} from '../../shared/types/chat';
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

export function isAgentModuleId(value: unknown): value is AgentModuleId {
  return typeof value === 'string' && value in MODULE_EFFORT_KEYS;
}

export function deriveAgentModule(
  kickoff: ChatThreadKickoff,
  skillConfig: ProjectSkillConfig | null,
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
    kickoff.skillPath === skillConfig.interviewSkillPath
    || skillConfig.interviewSkillOptions?.some(
      (option) => option.path === kickoff.skillPath,
    )
  ) {
    return 'interview';
  }
  return undefined;
}

export function resolveSelectedEffort(
  kickoff: ChatThreadKickoff,
  skillConfig: ProjectSkillConfig | null,
): EffortLevel | undefined {
  if (!skillConfig) return undefined;

  const interviewOption = skillConfig.interviewSkillOptions?.find(
    (option) => option.path === kickoff.skillPath,
  );
  if (isEffortLevel(interviewOption?.effort)) return interviewOption.effort;

  const skillPill = skillConfig.quickSkillPills?.find(
    (pill) => pill.skillPath === kickoff.skillPath
      && (!kickoff.pillLabel || pill.label === kickoff.pillLabel),
  );
  if (isEffortLevel(skillPill?.effort)) return skillPill.effort;

  const mcpPill = skillConfig.quickMcpPills?.find(
    (pill) => pill.mcpServerName === kickoff.mcpPill?.mcpServerName
      && (!kickoff.pillLabel || pill.label === kickoff.pillLabel),
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

export function buildCursorModelSelection(
  model: string,
  effort?: EffortLevel,
): {
  id: string;
  params?: Array<{ id: 'effort'; value: EffortLevel }>;
} {
  return effort
    ? { id: model, params: [{ id: 'effort', value: effort }] }
    : { id: model };
}
