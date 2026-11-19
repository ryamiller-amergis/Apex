import path from 'node:path';
import {
  isHarnessContextRef,
  type HarnessContextRef,
} from '../../../shared/types/chatHarness';
import { BRAINSTORM_SKILL_PATH } from '../../../shared/types/brainstorm';
import { BUILD_INTAKE_OPTION_KEY } from '../../../shared/types/buildPreflight';
import type {
  FrozenHarnessCustomTool,
  FrozenHarnessSpec,
} from '../../../shared/types/durableInteractiveTurn';
import { isEffortLevel, type EffortLevel } from '../../../shared/types/effort';
import type { InteractiveWorkflowClass } from '../../../shared/types/interactiveWorkflow';
import type { ProjectSkillConfig } from '../../../shared/types/projectSettings';
import { isCabReleaseSkillPath } from '../../../shared/utils/cabReleaseSkill';
import { getAppSetting } from '../appSettingsService';
import { resolveSkillConfig } from '../projectSettingsService';
import {
  HarnessProfileError,
  getAreaProfile,
  type AreaProfile,
  type AreaProfileRating,
  type AreaProfileSafety,
  type AreaProfileWriteConfirmation,
  type AreaSettingsLane,
} from './areaProfiles';

export { HarnessProfileError } from './areaProfiles';

export type ResolvedAreaSkill = Readonly<{
  name: string;
  path: string;
  source: 'project-setting' | 'app-default' | 'turn-override';
}>;

export type ResolvedAreaProfile = Readonly<{
  profile: AreaProfile;
  project: string;
  settingsId: string | null;
  skill: ResolvedAreaSkill | null;
  model: string;
  effort: EffortLevel | null;
  permission: string;
  workflowClass: InteractiveWorkflowClass;
  toolAllowlist: ReadonlyArray<string>;
  disallowedTools: ReadonlyArray<string>;
  customTools: ReadonlyArray<FrozenHarnessCustomTool>;
  writeConfirmation: ReadonlyArray<AreaProfileWriteConfirmation>;
  safety: AreaProfileSafety;
  recreationCapChars: number;
  rating: AreaProfileRating;
}>;

export interface AreaProfileResolverDeps {
  resolveSkillConfig?: (opts: {
    project: string;
    settingsId?: string;
  }) => Promise<ProjectSkillConfig | null>;
  /**
   * Returns the app-configured default model (without any hardcoded fallback).
   * Defaults to reading `app_settings.defaultModel`.
   */
  getAppDefaultModel?: () => Promise<string | null>;
  /**
   * Returns an app-configured default skill path for a lane (without any hardcoded fallback).
   * Defaults to reading `app_settings.defaultSkillPath:<lane>`.
   */
  getAppDefaultSkill?: (lane: AreaSettingsLane) => Promise<string | null>;
  getEnv?: (key: string) => string | undefined;
}

export interface ResolveAreaProfileOptions {
  settingsId?: string;
  context?: HarnessContextRef | null;
  skillPath?: string | null;
}

const DEFAULT_MODEL_ENV_KEY = 'APEX_HARNESS_DEFAULT_MODEL';

function laneSkillEnvKey(lane: AreaSettingsLane): string {
  return `APEX_HARNESS_SKILL_PATH_${lane.toUpperCase()}`;
}

function nonEmptyTrimmed(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function deriveSkillName(skillPath: string): string {
  const normalized = skillPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const base = path.posix.basename(normalized);
  if (base.toLowerCase() === 'skill.md') {
    const parent = path.posix.basename(path.posix.dirname(normalized));
    if (parent && parent !== '.' && parent !== '/') return parent;
  }
  const ext = path.posix.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  return stem || normalized;
}

function findMatchingQuickPill(
  config: ProjectSkillConfig | null,
  predicate: (skillPath: string) => boolean,
) {
  return config?.quickSkillPills?.find((pill) => {
    const p = nonEmptyTrimmed(pill.skillPath);
    return p !== null && predicate(p);
  });
}

function findBuildIntakeOption(config: ProjectSkillConfig | null) {
  return config?.interviewSkillOptions?.find(
    (option) =>
      option.enabled !== false && option.key?.trim() === BUILD_INTAKE_OPTION_KEY,
  );
}

function findFirstEnabledInterviewOption(config: ProjectSkillConfig | null) {
  return config?.interviewSkillOptions?.find(
    (option) => option.enabled !== false && nonEmptyTrimmed(option.path) !== null,
  );
}

function resolveProjectLaneSkillPath(
  lane: AreaSettingsLane,
  config: ProjectSkillConfig | null,
): string | null {
  if (!config) return null;

  switch (lane) {
    case 'agent_home':
      return null;
    case 'interview':
      return (
        nonEmptyTrimmed(config.interviewSkillPath) ??
        nonEmptyTrimmed(findFirstEnabledInterviewOption(config)?.path)
      );
    case 'adr_interview':
      return nonEmptyTrimmed(config.adrInterviewSkillPath);
    case 'prd_assistant':
      return nonEmptyTrimmed(config.prdAssistantSkillPath);
    case 'design_doc_assistant':
      return nonEmptyTrimmed(config.designDocAssistantSkillPath);
    case 'ask_apex':
      return nonEmptyTrimmed(
        findMatchingQuickPill(config, (p) =>
          p.replace(/\\/g, '/').toLowerCase().includes('app-knowledge'),
        )?.skillPath,
      );
    case 'calendar_assistant':
      return nonEmptyTrimmed(config.calendarAssistantSkillPath);
    case 'test_case':
      return nonEmptyTrimmed(config.testCaseSkillPath);
    case 'brainstorm':
      return nonEmptyTrimmed(
        findMatchingQuickPill(config, (p) => {
          const normalized = p.replace(/\\/g, '/').toLowerCase();
          return (
            normalized === BRAINSTORM_SKILL_PATH.toLowerCase() ||
            normalized.includes('/brainstorm/')
          );
        })?.skillPath,
      );
    case 'cab_release':
      return nonEmptyTrimmed(
        findMatchingQuickPill(config, (p) => isCabReleaseSkillPath(p))?.skillPath,
      );
    case 'build_intake':
      return (
        nonEmptyTrimmed(findBuildIntakeOption(config)?.path) ??
        nonEmptyTrimmed(config.interviewSkillPath)
      );
    case 'standup':
      return nonEmptyTrimmed(config.standupSkillPath);
    default: {
      const unhandled: never = lane;
      throw new HarnessProfileError(
        'invalid-profile',
        `Unsupported settings lane "${String(unhandled)}"`,
        'settingsLane',
      );
    }
  }
}

function resolveProjectLaneModel(
  lane: AreaSettingsLane,
  config: ProjectSkillConfig | null,
): string | null {
  if (!config) return null;

  switch (lane) {
    case 'agent_home':
      return null;
    case 'interview':
      return nonEmptyTrimmed(config.interviewModel);
    case 'adr_interview':
      return nonEmptyTrimmed(config.adrModel);
    case 'prd_assistant':
      return nonEmptyTrimmed(config.prdAssistantModel);
    case 'design_doc_assistant':
      return nonEmptyTrimmed(config.designDocAssistantModel);
    case 'ask_apex':
      return nonEmptyTrimmed(
        findMatchingQuickPill(config, (p) =>
          p.replace(/\\/g, '/').toLowerCase().includes('app-knowledge'),
        )?.model,
      );
    case 'calendar_assistant':
      return nonEmptyTrimmed(config.calendarAssistantModel);
    case 'test_case':
      return nonEmptyTrimmed(config.testCaseModel);
    case 'brainstorm':
      return nonEmptyTrimmed(
        findMatchingQuickPill(config, (p) => {
          const normalized = p.replace(/\\/g, '/').toLowerCase();
          return (
            normalized === BRAINSTORM_SKILL_PATH.toLowerCase() ||
            normalized.includes('/brainstorm/')
          );
        })?.model,
      );
    case 'cab_release':
      return nonEmptyTrimmed(
        findMatchingQuickPill(config, (p) => isCabReleaseSkillPath(p))?.model,
      );
    case 'build_intake':
      return (
        nonEmptyTrimmed(findBuildIntakeOption(config)?.model) ??
        nonEmptyTrimmed(config.interviewModel)
      );
    case 'standup':
      return nonEmptyTrimmed(config.standupModel);
    default: {
      const unhandled: never = lane;
      throw new HarnessProfileError(
        'invalid-profile',
        `Unsupported settings lane "${String(unhandled)}"`,
        'settingsLane',
      );
    }
  }
}

function resolveProjectLaneEffort(
  lane: AreaSettingsLane,
  config: ProjectSkillConfig | null,
): EffortLevel | null {
  if (!config) return null;

  let candidate: unknown;
  switch (lane) {
    case 'agent_home':
      candidate = config.defaultEffort;
      break;
    case 'interview':
      candidate = config.interviewEffort;
      break;
    case 'adr_interview':
      candidate = config.adrEffort;
      break;
    case 'prd_assistant':
      candidate = config.prdAssistantEffort;
      break;
    case 'design_doc_assistant':
      candidate = config.designDocAssistantEffort;
      break;
    case 'ask_apex':
      candidate = findMatchingQuickPill(config, (p) =>
        p.replace(/\\/g, '/').toLowerCase().includes('app-knowledge'),
      )?.effort;
      break;
    case 'calendar_assistant':
      candidate = config.calendarAssistantEffort;
      break;
    case 'test_case':
      candidate = config.testCaseEffort;
      break;
    case 'brainstorm':
      candidate = findMatchingQuickPill(config, (p) => {
        const normalized = p.replace(/\\/g, '/').toLowerCase();
        return (
          normalized === BRAINSTORM_SKILL_PATH.toLowerCase() ||
          normalized.includes('/brainstorm/')
        );
      })?.effort;
      break;
    case 'cab_release':
      candidate = findMatchingQuickPill(config, (p) =>
        isCabReleaseSkillPath(p),
      )?.effort;
      break;
    case 'build_intake':
      candidate = findBuildIntakeOption(config)?.effort ?? config.interviewEffort;
      break;
    case 'standup':
      candidate = config.standupEffort;
      break;
    default: {
      const unhandled: never = lane;
      throw new HarnessProfileError(
        'invalid-profile',
        `Unsupported settings lane "${String(unhandled)}"`,
        'settingsLane',
      );
    }
  }

  if (isEffortLevel(candidate)) return candidate;
  return isEffortLevel(config.defaultEffort) ? config.defaultEffort : null;
}

const defaultDeps: Required<AreaProfileResolverDeps> = {
  resolveSkillConfig: (opts) => resolveSkillConfig(opts),
  getAppDefaultModel: () => getAppSetting('defaultModel'),
  getAppDefaultSkill: (lane) => getAppSetting(`defaultSkillPath:${lane}`),
  getEnv: (key) => process.env[key],
};

export function validateHarnessContext(
  profile: AreaProfile,
  context?: HarnessContextRef | null,
): void {
  if (context === undefined || context === null) return;

  if (!isHarnessContextRef(context)) {
    throw new HarnessProfileError(
      'invalid-context',
      `Invalid harnessContext for area "${profile.area}"`,
      'harnessContext',
    );
  }

  if (!profile.contextKinds.includes(context.kind)) {
    throw new HarnessProfileError(
      'invalid-context',
      `Area "${profile.area}" does not accept harnessContext kind "${context.kind}"`,
      'harnessContext',
    );
  }
}

export async function resolveAreaProfile(
  area: string,
  project: string,
  deps?: AreaProfileResolverDeps,
  options?: ResolveAreaProfileOptions,
): Promise<ResolvedAreaProfile> {
  const profile = getAreaProfile(area);
  validateHarnessContext(profile, options?.context);

  const loadSkillConfig = deps?.resolveSkillConfig ?? defaultDeps.resolveSkillConfig;
  const loadAppDefaultModel =
    deps?.getAppDefaultModel ?? defaultDeps.getAppDefaultModel;
  const loadAppDefaultSkill =
    deps?.getAppDefaultSkill ?? defaultDeps.getAppDefaultSkill;
  const readEnv = deps?.getEnv ?? defaultDeps.getEnv;

  const skillConfig = await loadSkillConfig({
    project,
    settingsId: options?.settingsId,
  });

  // Resolve skill: explicit turn override -> project lane setting -> env override -> app default.
  let resolvedSkill: ResolvedAreaSkill | null = null;
  const explicitSkillPath = nonEmptyTrimmed(options?.skillPath);
  if (explicitSkillPath) {
    resolvedSkill = {
      name: deriveSkillName(explicitSkillPath),
      path: explicitSkillPath,
      source: 'turn-override',
    };
  } else {
    const projectSkillPath = resolveProjectLaneSkillPath(
      profile.settingsLane,
      skillConfig,
    );
    if (projectSkillPath) {
      resolvedSkill = {
        name: deriveSkillName(projectSkillPath),
        path: projectSkillPath,
        source: 'project-setting',
      };
    } else {
      const envSkillPath = nonEmptyTrimmed(
        readEnv(laneSkillEnvKey(profile.settingsLane)),
      );
      const appSkillPath =
        envSkillPath ??
        nonEmptyTrimmed(await loadAppDefaultSkill(profile.settingsLane));
      if (appSkillPath) {
        resolvedSkill = {
          name: deriveSkillName(appSkillPath),
          path: appSkillPath,
          source: 'app-default',
        };
      }
    }
  }

  if (profile.requiresSkill && !resolvedSkill) {
    throw new HarnessProfileError(
      'missing-skill',
      `No skill is configured for area "${profile.area}" in project "${project}"`,
      'skill',
    );
  }

  // Resolve model: project lane model -> project default model -> env override -> app default.
  const model =
    resolveProjectLaneModel(profile.settingsLane, skillConfig) ??
    nonEmptyTrimmed(skillConfig?.defaultModel) ??
    nonEmptyTrimmed(readEnv(DEFAULT_MODEL_ENV_KEY)) ??
    nonEmptyTrimmed(await loadAppDefaultModel());

  if (!model) {
    throw new HarnessProfileError(
      'missing-model',
      `No model is configured for area "${profile.area}" in project "${project}"`,
      'model',
    );
  }

  const effort = resolveProjectLaneEffort(profile.settingsLane, skillConfig);

  return {
    profile,
    project,
    settingsId: skillConfig?.id ?? null,
    skill: resolvedSkill,
    model,
    effort,
    permission: profile.permission,
    workflowClass: profile.workflowClass,
    toolAllowlist: profile.toolAllowlist,
    disallowedTools: profile.disallowedTools,
    customTools: profile.customTools,
    writeConfirmation: profile.writeConfirmation,
    safety: profile.safety,
    recreationCapChars: profile.recreationCapChars,
    rating: profile.rating,
  };
}

export function toFrozenHarnessSpec(
  resolved: ResolvedAreaProfile,
  options?: { operation?: 'summarize' },
): FrozenHarnessSpec {
  return {
    area: resolved.profile.area,
    version: resolved.profile.version,
    ...(options?.operation ? { operation: options.operation } : {}),
    toolAllowlist: [...resolved.toolAllowlist],
    customTools: resolved.customTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      writes: tool.writes,
      proxyTarget: tool.proxyTarget,
    })),
    writeConfirmation: resolved.writeConfirmation.map(
      ({ tool, writes, mode }) => ({
        tool,
        writes,
        mode,
      }),
    ),
    safety: {
      repositoryCode: resolved.safety.repositoryCode,
      shell: resolved.safety.shell,
      settingSources: [],
    },
  };
}
