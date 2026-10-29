import type {
  BuildProfile,
  BuildProfileRole,
  BuildQualityManifestSnapshot,
} from './build';
import { BUILD_PROFILE_ROLES } from './build';

/** Defaults the resolver applies when a cap is unset. The cost cap has no default. */
export const BUILD_CAP_DEFAULTS = {
  elapsedMinutesPerRevision: 240,
  maxRevisions: 5,
  maxParallelism: 4,
} as const;

export const BUILD_CAP_LIMITS = {
  elapsedMinutesPerRevision: { min: 60, max: 1440 },
  maxRevisions: { min: 1, max: 5 },
  maxParallelism: { min: 1, max: 6 },
} as const;

/** Fixed by the ADR; not part of the profile. */
export const BUILD_REPAIR_ATTEMPTS = 2;

export const BUILD_INTAKE_OPTION_KEY = 'build-intake';
export const BUILD_CODING_RULES_FOLDER = '.cursor/rules';
export const BUILD_CODE_MAP_PATH = '.cursor/CODEMAP.md';
export const BUILD_AGENT_ENVIRONMENT_PATH = '.cursor/environment.json';
export const BUILD_PIPELINE_PARAMETER_NAMES = ['commitSha', 'branch'] as const;
export const BUILD_QUALITY_MANIFEST_KEYS = ['typeCheck', 'lint', 'relatedTests', 'unitSuite'] as const;

/** The project setting that supplied a role's model. */
export type BuildModelSource =
  | 'profile'
  | 'interviewModel'
  | 'developmentModel'
  | 'testCaseModel'
  | 'defaultModel';

export interface BuildProfileRoleResolution {
  skillPath: string | null;
  model: string | null;
  modelSource: BuildModelSource | null;
  unresolved: Array<'skillPath' | 'model'>;
}

export interface BuildProfileResolution {
  roles: Record<BuildProfileRole, BuildProfileRoleResolution>;
  caps: {
    costUsd: number | null;
    elapsedMinutesPerRevision: number;
    maxRevisions: number;
    maxParallelism: number;
  };
  unresolvedRoles: BuildProfileRole[];
  capsUnresolved: Array<'costUsd'>;
}

export type BuildProfileInput = BuildProfile;

export interface BuildSupportContactSummary {
  userId: string;
  displayName: string;
}

export interface BuildProfileResponse {
  settingsId: string;
  project: string;
  repository: string;
  profile: BuildProfile;
  resolution: BuildProfileResolution;
  supportContacts: BuildSupportContactSummary[];
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface BuildProfileValidationErrorResponse {
  error: 'validation_failed';
  fieldErrors: Record<string, string>;
}

export const BUILD_FROM_PROMPT_DISABLED_ERROR = 'build_from_prompt_disabled';

export const PREFLIGHT_REFUSAL_CODES = [
  'repository_not_configured',
  'provider_unsupported',
  'pair_not_allow_listed',
  'flag_build_off',
  'flag_interview_step_off',
  'role_unresolved',
  'role_skill_missing',
  'intake_profile_missing',
  'caps_unresolved',
  'support_contact_missing',
  'design_system_missing',
  'coding_rules_missing',
  'code_map_missing',
  'agent_environment_missing',
  'pipeline_unusable',
  'quality_manifest_missing',
  'quality_manifest_incomplete',
  'secret_in_snapshot',
  'check_unavailable',
] as const;

export type PreflightRefusalCode = (typeof PREFLIGHT_REFUSAL_CODES)[number];

export const PREFLIGHT_FIXERS = ['platform_admin', 'project_admin'] as const;
export type PreflightFixer = (typeof PREFLIGHT_FIXERS)[number];

export interface PreflightRefusal {
  code: PreflightRefusalCode;
  /** Short name of the missing item, e.g. "code map", "planner skill". */
  item: string;
  /** Plain sentence, safe to show. */
  message: string;
  fixer: PreflightFixer;
  /** Who can fix it, as shown to the requester. */
  fixerLabel: string;
}

export interface FrozenFileRef {
  path: string;
  sha256: string;
}

export interface FrozenBuildRunConfig {
  schemaVersion: 1;
  project: string;
  repository: { provider: 'ado'; adoProject: string; repo: string; branch: string };
  resolvedAt: string;
  roles: Record<
    BuildProfileRole,
    { skillPath: string; skillSha256: string; model: string; modelSource: BuildModelSource }
  >;
  caps: {
    costUsd: number;
    elapsedMinutesPerRevision: number;
    maxRevisions: number;
    maxParallelism: number;
    repairAttempts: typeof BUILD_REPAIR_ATTEMPTS;
  };
  supportContacts: BuildSupportContactSummary[];
  standards: {
    designSystem: FrozenFileRef;
    codingRules: FrozenFileRef[];
    codeMap: FrozenFileRef;
  };
  qualityManifest: FrozenFileRef & { commands: BuildQualityManifestSnapshot };
  agentEnvironment: FrozenFileRef;
  pipeline: { definitionId: number };
}

export type PreflightResult =
  | { ok: true; config: FrozenBuildRunConfig }
  | { ok: false; refusals: PreflightRefusal[] };

export const PREFLIGHT_REFUSED_ERROR = 'preflight_refused';

/** Body of the 422 that `POST /api/builds` returns when preflight refuses. */
export interface PreflightRefusalResponse {
  error: typeof PREFLIGHT_REFUSED_ERROR;
  summary: string;
  refusals: PreflightRefusal[];
}

export function preflightRefusalSummary(count: number): string {
  if (count === 1) return '1 thing needs fixing before this build can start.';
  return `${count} things need fixing before this build can start.`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isPreflightRefusal(value: unknown): value is PreflightRefusal {
  if (!isRecord(value)) return false;
  return (
    (PREFLIGHT_REFUSAL_CODES as readonly unknown[]).includes(value.code) &&
    (PREFLIGHT_FIXERS as readonly unknown[]).includes(value.fixer) &&
    typeof value.item === 'string' &&
    typeof value.message === 'string' &&
    typeof value.fixerLabel === 'string'
  );
}

export function isPreflightRefusalResponse(value: unknown): value is PreflightRefusalResponse {
  if (!isRecord(value)) return false;
  return (
    value.error === PREFLIGHT_REFUSED_ERROR &&
    typeof value.summary === 'string' &&
    Array.isArray(value.refusals) &&
    value.refusals.length > 0 &&
    value.refusals.every(isPreflightRefusal)
  );
}

export function emptyBuildProfile(): BuildProfile {
  const roles = {} as BuildProfile['roles'];
  for (const role of BUILD_PROFILE_ROLES) roles[role] = { skillPath: null, model: null };
  return {
    roles,
    caps: {
      costUsd: null,
      elapsedMinutesPerRevision: BUILD_CAP_DEFAULTS.elapsedMinutesPerRevision,
      maxRevisions: BUILD_CAP_DEFAULTS.maxRevisions,
      maxParallelism: BUILD_CAP_DEFAULTS.maxParallelism,
    },
    qualityManifestPath: null,
    deployPipelineId: null,
    supportContactUserIds: [],
  };
}
