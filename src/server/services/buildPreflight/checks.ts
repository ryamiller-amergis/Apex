/**
 * One function per row of the preflight check table. Each returns zero or more
 * refusals and records what it read into `collected` for the frozen config.
 */
import { BUILD_FROM_PROMPT_FLAG } from '../../../shared/types/featureFlags';
import { BUILD_PROFILE_ROLES, type BuildProfileRole, type BuildQualityManifestSnapshot } from '../../../shared/types/build';
import {
  BUILD_AGENT_ENVIRONMENT_PATH,
  BUILD_CODE_MAP_PATH,
  BUILD_CODING_RULES_FOLDER,
  BUILD_INTAKE_OPTION_KEY,
  BUILD_PIPELINE_PARAMETER_NAMES,
  BUILD_QUALITY_MANIFEST_KEYS,
  type BuildProfileResolution,
  type BuildSupportContactSummary,
  type FrozenFileRef,
} from '../../../shared/types/buildPreflight';
import type { ProjectSkillConfig } from '../../../shared/types/projectSettings';
import { normalizeRepoRelativePath } from '../../../shared/skillPaths';
import { designSystemPathCandidates } from '../prototypeContextService';
import { sha256Hex } from './hash';
import type { RefusalSpec } from './messages';
import type { AdoRepoCoords, PreflightPorts } from './ports';

export const PLAYBOOK_INTERVIEW_STEP_FLAG = 'playbook-interview-step';

export interface Collected {
  roleSkills: Partial<Record<BuildProfileRole, FrozenFileRef>>;
  supportContacts?: BuildSupportContactSummary[];
  designSystem?: FrozenFileRef;
  codingRules?: FrozenFileRef[];
  codeMap?: FrozenFileRef;
  agentEnvironment?: FrozenFileRef;
  pipelineId?: number;
  qualityManifest?: FrozenFileRef & { commands: BuildQualityManifestSnapshot };
}

export interface CheckContext {
  project: string;
  repository: string;
  userId: string;
  /** Null when no settings row matches; repository checks are then skipped. */
  row: ProjectSkillConfig | null;
  /** Null when the row is missing or is not an Azure DevOps repository. */
  coords: AdoRepoCoords | null;
  resolution: BuildProfileResolution | null;
  ports: PreflightPorts;
  collected: Collected;
}

export interface PreflightCheck {
  /** Position in the check table; refusals are reported in this order. */
  order: number;
  /** What a `check_unavailable` refusal names when this check cannot finish. */
  item: string;
  run(ctx: CheckContext): Promise<RefusalSpec[]>;
}

export function repoCoordsFor(row: ProjectSkillConfig, project: string): AdoRepoCoords {
  const repoSetting = row.skillRepo.trim();
  const [adoProject, repo] = repoSetting.includes('/')
    ? (repoSetting.split('/', 2) as [string, string])
    : [project, repoSetting];
  return { adoProject, repo, branch: row.skillBranch?.trim() || 'main' };
}

async function hashedFile(ports: PreflightPorts, coords: AdoRepoCoords, path: string): Promise<FrozenFileRef | null> {
  const text = await ports.readFile(coords, path);
  if (text === null || !text.trim()) return null;
  return { path, sha256: sha256Hex(text) };
}

const repositoryConfigured: PreflightCheck = {
  order: 1,
  item: 'repository configuration',
  async run(ctx) {
    return ctx.row ? [] : [{ code: 'repository_not_configured', repository: ctx.repository }];
  },
};

const providerSupported: PreflightCheck = {
  order: 2,
  item: 'repository provider',
  async run(ctx) {
    if (!ctx.row) return [];
    return (ctx.row.skillProvider ?? 'ado') === 'ado' ? [] : [{ code: 'provider_unsupported' }];
  },
};

const pairAllowListed: PreflightCheck = {
  order: 3,
  item: 'build allow-list',
  async run(ctx) {
    const allowed = await ctx.ports.isPairAllowed(ctx.project, ctx.repository);
    return allowed ? [] : [{ code: 'pair_not_allow_listed', repository: ctx.repository }];
  },
};

const buildFlagOn: PreflightCheck = {
  order: 4,
  item: 'build-from-prompt setting',
  async run(ctx) {
    const on = await ctx.ports.isFlagEnabled(BUILD_FROM_PROMPT_FLAG, { userId: ctx.userId, project: ctx.project });
    return on ? [] : [{ code: 'flag_build_off' }];
  },
};

const interviewStepFlagOn: PreflightCheck = {
  order: 5,
  item: 'Playbook interview step setting',
  async run(ctx) {
    const on = await ctx.ports.isFlagEnabled(PLAYBOOK_INTERVIEW_STEP_FLAG, { userId: ctx.userId, project: ctx.project });
    return on ? [] : [{ code: 'flag_interview_step_off' }];
  },
};

const rolesResolved: PreflightCheck = {
  order: 6,
  item: 'build roles',
  async run(ctx) {
    if (!ctx.resolution) return [];
    return BUILD_PROFILE_ROLES.flatMap((role): RefusalSpec[] => {
      const missing = ctx.resolution!.roles[role].unresolved;
      return missing.length > 0 ? [{ code: 'role_unresolved', role, missing }] : [];
    });
  },
};

const roleSkillsPresent: PreflightCheck = {
  order: 7,
  item: 'role skill files',
  async run(ctx) {
    if (!ctx.resolution || !ctx.coords) return [];
    const coords = ctx.coords;
    const reads = new Map<string, Promise<FrozenFileRef | null>>();
    const results = await Promise.all(
      BUILD_PROFILE_ROLES.map(async (role) => {
        const path = ctx.resolution!.roles[role].skillPath;
        if (!path) return null;
        if (!reads.has(path)) reads.set(path, hashedFile(ctx.ports, coords, path));
        const file = await reads.get(path)!;
        if (file) {
          ctx.collected.roleSkills[role] = file;
          return null;
        }
        return { code: 'role_skill_missing', role, path } satisfies RefusalSpec;
      }),
    );
    return results.filter((r): r is NonNullable<typeof r> => r !== null);
  },
};

const intakeOptionMatches: PreflightCheck = {
  order: 8,
  item: 'build intake interview option',
  async run(ctx) {
    if (!ctx.row) return [];
    const option = (ctx.row.interviewSkillOptions ?? []).find(
      (o) => o.key?.trim() === BUILD_INTAKE_OPTION_KEY && o.enabled !== false,
    );
    if (!option) return [{ code: 'intake_profile_missing', reason: 'absent' }];
    const intakePath = ctx.resolution?.roles.intake.skillPath;
    if (intakePath && normalizeRepoRelativePath(option.path) !== normalizeRepoRelativePath(intakePath)) {
      return [{ code: 'intake_profile_missing', reason: 'path_mismatch' }];
    }
    return [];
  },
};

const capsResolved: PreflightCheck = {
  order: 9,
  item: 'build caps',
  async run(ctx) {
    if (!ctx.resolution) return [];
    return ctx.resolution.capsUnresolved.length > 0 ? [{ code: 'caps_unresolved' }] : [];
  },
};

const supportContactAssigned: PreflightCheck = {
  order: 10,
  item: 'Build support contacts',
  async run(ctx) {
    if (!ctx.row) return [];
    const saved = ctx.row.buildProfile?.supportContactUserIds ?? [];
    const assigned = saved.length > 0 ? await ctx.ports.listAssignedUsers(ctx.project) : new Map<string, string>();
    const contacts = saved
      .filter((userId) => assigned.has(userId))
      .map((userId) => ({ userId, displayName: assigned.get(userId) ?? userId }));
    if (contacts.length === 0) return [{ code: 'support_contact_missing' }];
    ctx.collected.supportContacts = contacts;
    return [];
  },
};

const designSystemPresent: PreflightCheck = {
  order: 11,
  item: 'design-system file',
  async run(ctx) {
    if (!ctx.row || !ctx.coords) return [];
    const candidates = designSystemPathCandidates(ctx.row.prototypeDesignSystemPath?.trim() || null);
    for (const candidate of candidates) {
      const file = await hashedFile(ctx.ports, ctx.coords, candidate);
      if (file) {
        ctx.collected.designSystem = file;
        return [];
      }
    }
    return [{ code: 'design_system_missing', paths: candidates }];
  },
};

const codingRulesPresent: PreflightCheck = {
  order: 12,
  item: 'coding rules',
  async run(ctx) {
    if (!ctx.coords) return [];
    const coords = ctx.coords;
    const listing = await ctx.ports.listFolder(coords, BUILD_CODING_RULES_FOLDER);
    const paths = (listing ?? [])
      .map((p) => normalizeRepoRelativePath(p))
      .filter((p) => p.startsWith(`${BUILD_CODING_RULES_FOLDER}/`) && p.toLowerCase().endsWith('.mdc'))
      .sort();
    const files = (await Promise.all(paths.map((p) => hashedFile(ctx.ports, coords, p)))).filter(
      (f): f is FrozenFileRef => f !== null,
    );
    if (files.length === 0) return [{ code: 'coding_rules_missing' }];
    ctx.collected.codingRules = files;
    return [];
  },
};

const codeMapPresent: PreflightCheck = {
  order: 13,
  item: 'code map',
  async run(ctx) {
    if (!ctx.coords) return [];
    const file = await hashedFile(ctx.ports, ctx.coords, BUILD_CODE_MAP_PATH);
    if (!file) return [{ code: 'code_map_missing' }];
    ctx.collected.codeMap = file;
    return [];
  },
};

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const agentEnvironmentPrepared: PreflightCheck = {
  order: 14,
  item: 'Cloud Agent environment',
  async run(ctx) {
    if (!ctx.coords) return [];
    const text = await ctx.ports.readFile(ctx.coords, BUILD_AGENT_ENVIRONMENT_PATH);
    if (text === null) return [{ code: 'agent_environment_missing', reason: 'absent' }];
    const install = parseJsonObject(text)?.install;
    if (typeof install !== 'string' || !install.trim()) {
      return [{ code: 'agent_environment_missing', reason: 'no_install' }];
    }
    ctx.collected.agentEnvironment = { path: BUILD_AGENT_ENVIRONMENT_PATH, sha256: sha256Hex(text) };
    return [];
  },
};

const pipelineUsable: PreflightCheck = {
  order: 15,
  item: 'deploy pipeline',
  async run(ctx) {
    if (!ctx.row || !ctx.coords) return [];
    const definitionId = ctx.row.buildProfile?.deployPipelineId ?? null;
    if (definitionId === null) return [{ code: 'pipeline_unusable', reason: 'unset' }];
    const definition = await ctx.ports.readPipeline(ctx.coords, definitionId);
    if (!definition) return [{ code: 'pipeline_unusable', reason: 'not_found' }];
    if (!definition.enabled) return [{ code: 'pipeline_unusable', reason: 'disabled' }];
    const repo = ctx.coords.repo.toLowerCase();
    const boundName = definition.repositoryName?.toLowerCase() ?? null;
    const boundId = definition.repositoryId?.toLowerCase() ?? null;
    if (boundName !== repo && boundId !== repo) return [{ code: 'pipeline_unusable', reason: 'other_repository' }];
    const declared = new Set(definition.parameterNames);
    if (!BUILD_PIPELINE_PARAMETER_NAMES.some((name) => declared.has(name))) {
      return [{ code: 'pipeline_unusable', reason: 'no_parameter' }];
    }
    ctx.collected.pipelineId = definitionId;
    return [];
  },
};

const qualityManifestDeclared: PreflightCheck = {
  order: 16,
  item: 'quality manifest',
  async run(ctx) {
    if (!ctx.row || !ctx.coords) return [];
    const path = ctx.row.buildProfile?.qualityManifestPath?.trim() || null;
    if (!path) return [{ code: 'quality_manifest_missing', path: null }];
    const text = await ctx.ports.readFile(ctx.coords, path);
    if (text === null) return [{ code: 'quality_manifest_missing', path }];
    const json = parseJsonObject(text);
    const missingKeys = BUILD_QUALITY_MANIFEST_KEYS.filter((key) => {
      const value = json?.[key];
      return typeof value !== 'string' || !value.trim();
    });
    if (missingKeys.length > 0) return [{ code: 'quality_manifest_incomplete', path, missingKeys }];
    const commands = Object.fromEntries(
      BUILD_QUALITY_MANIFEST_KEYS.map((key) => [key, String(json![key]).trim()]),
    ) as unknown as BuildQualityManifestSnapshot;
    ctx.collected.qualityManifest = { path, sha256: sha256Hex(text), commands };
    return [];
  },
};

/** Checks 1–16. Check 17 (secret scan) runs over the assembled config in index.ts. */
export const PREFLIGHT_CHECKS: readonly PreflightCheck[] = [
  repositoryConfigured,
  providerSupported,
  pairAllowListed,
  buildFlagOn,
  interviewStepFlagOn,
  rolesResolved,
  roleSkillsPresent,
  intakeOptionMatches,
  capsResolved,
  supportContactAssigned,
  designSystemPresent,
  codingRulesPresent,
  codeMapPresent,
  agentEnvironmentPrepared,
  pipelineUsable,
  qualityManifestDeclared,
];

export const SECRET_SCAN_ORDER = 17;
