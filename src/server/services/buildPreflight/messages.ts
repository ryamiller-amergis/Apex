/**
 * Fixed refusal templates. No raw error text, host name or token reaches a
 * message: every dynamic value is a path, role, field name or display name.
 */
import type { BuildProfileRole } from '../../../shared/types/build';
import {
  BUILD_AGENT_ENVIRONMENT_PATH,
  BUILD_CODE_MAP_PATH,
  BUILD_CODING_RULES_FOLDER,
  BUILD_INTAKE_OPTION_KEY,
  type PreflightFixer,
  type PreflightRefusal,
  type PreflightRefusalCode,
} from '../../../shared/types/buildPreflight';

export interface RefusalContext {
  project: string;
  supportContactNames: readonly string[];
}

const FIXER: Record<PreflightRefusalCode, PreflightFixer> = {
  repository_not_configured: 'project_admin',
  provider_unsupported: 'platform_admin',
  pair_not_allow_listed: 'platform_admin',
  flag_build_off: 'platform_admin',
  flag_interview_step_off: 'platform_admin',
  role_unresolved: 'project_admin',
  role_skill_missing: 'project_admin',
  intake_profile_missing: 'project_admin',
  caps_unresolved: 'project_admin',
  support_contact_missing: 'project_admin',
  design_system_missing: 'project_admin',
  coding_rules_missing: 'project_admin',
  code_map_missing: 'project_admin',
  agent_environment_missing: 'project_admin',
  pipeline_unusable: 'project_admin',
  quality_manifest_missing: 'project_admin',
  quality_manifest_incomplete: 'project_admin',
  secret_in_snapshot: 'platform_admin',
  check_unavailable: 'platform_admin',
};

export function fixerLabel(fixer: PreflightFixer, ctx: RefusalContext): string {
  switch (fixer) {
    case 'platform_admin':
      return 'a Platform Admin';
    case 'project_admin': {
      const base = `a Project Admin for ${ctx.project}`;
      if (ctx.supportContactNames.length === 0) return base;
      return `${base} (Build support contacts: ${ctx.supportContactNames.join(', ')})`;
    }
    default: {
      const exhaustive: never = fixer;
      return exhaustive;
    }
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function make(code: PreflightRefusalCode, item: string, problem: string, ctx: RefusalContext): PreflightRefusal {
  const fixer = FIXER[code];
  const label = fixerLabel(fixer, ctx);
  return {
    code,
    item,
    message: `${problem} ${capitalize(label)} can fix this.`,
    fixer,
    fixerLabel: label,
  };
}

export type RefusalSpec =
  | { code: 'repository_not_configured'; repository: string }
  | { code: 'provider_unsupported' }
  | { code: 'pair_not_allow_listed'; repository: string }
  | { code: 'flag_build_off' }
  | { code: 'flag_interview_step_off' }
  | { code: 'role_unresolved'; role: BuildProfileRole; missing: Array<'skillPath' | 'model'> }
  | { code: 'role_skill_missing'; role: BuildProfileRole; path: string }
  | { code: 'intake_profile_missing'; reason: 'absent' | 'path_mismatch' }
  | { code: 'caps_unresolved' }
  | { code: 'support_contact_missing' }
  | { code: 'design_system_missing'; paths: readonly string[] }
  | { code: 'coding_rules_missing' }
  | { code: 'code_map_missing' }
  | { code: 'agent_environment_missing'; reason: 'absent' | 'no_install' }
  | { code: 'pipeline_unusable'; reason: 'unset' | 'not_found' | 'disabled' | 'other_repository' | 'no_parameter' }
  | { code: 'quality_manifest_missing'; path: string | null }
  | { code: 'quality_manifest_incomplete'; path: string; missingKeys: readonly string[] }
  | { code: 'secret_in_snapshot'; field: string }
  | { code: 'check_unavailable'; item: string };

const PIPELINE_PROBLEM: Record<Extract<RefusalSpec, { code: 'pipeline_unusable' }>['reason'], [string, string]> = {
  unset: ['deploy pipeline', 'No deploy pipeline is set in the Build profile.'],
  not_found: ['deploy pipeline', 'The deploy pipeline in the Build profile was not found.'],
  disabled: ['deploy pipeline (disabled)', 'The deploy pipeline in the Build profile is disabled.'],
  other_repository: [
    'deploy pipeline (other repository)',
    'The deploy pipeline in the Build profile builds a different repository.',
  ],
  no_parameter: [
    'deploy pipeline parameter',
    'The deploy pipeline does not accept a commitSha or branch parameter.',
  ],
};

export function buildRefusal(spec: RefusalSpec, ctx: RefusalContext): PreflightRefusal {
  switch (spec.code) {
    case 'repository_not_configured':
      return make(spec.code, 'repository configuration', `The repository ${spec.repository} is not configured in Project Settings for ${ctx.project}.`, ctx);
    case 'provider_unsupported':
      return make(spec.code, 'Azure DevOps repository', 'Builds run only on Azure DevOps repositories, and this repository is hosted elsewhere.', ctx);
    case 'pair_not_allow_listed':
      return make(spec.code, 'build allow-list', `${ctx.project} and ${spec.repository} are not on the build allow-list.`, ctx);
    case 'flag_build_off':
      return make(spec.code, 'build-from-prompt', 'Build from prompt is turned off for this project.', ctx);
    case 'flag_interview_step_off':
      return make(spec.code, 'playbook-interview-step', 'The Playbook interview step is turned off for this project, so intake cannot start.', ctx);
    case 'role_unresolved': {
      const parts = spec.missing.map((m) => (m === 'skillPath' ? 'skill' : 'model')).join(' or ');
      return make(spec.code, `${spec.role} ${parts}`, `The ${spec.role} role has no ${parts} in the Build profile.`, ctx);
    }
    case 'role_skill_missing':
      return make(spec.code, `${spec.role} skill`, `The ${spec.role} skill file is missing from the repository (expected at ${spec.path}).`, ctx);
    case 'intake_profile_missing':
      return make(
        spec.code,
        'build intake interview option',
        spec.reason === 'absent'
          ? `No enabled interview option with the key ${BUILD_INTAKE_OPTION_KEY} exists in Project Settings.`
          : `The ${BUILD_INTAKE_OPTION_KEY} interview option uses a different skill from the Build profile's intake role.`,
        ctx,
      );
    case 'caps_unresolved':
      return make(spec.code, 'cost cap', 'No cost cap is set in the Build profile.', ctx);
    case 'support_contact_missing':
      return make(spec.code, 'Build support contact', 'The Build profile has no support contact who is still assigned to this project.', ctx);
    case 'design_system_missing':
      return make(spec.code, 'design-system file', `This repository has no design-system file (expected at ${spec.paths[0] ?? '.cursor/skills/design-system/SKILL.md'}).`, ctx);
    case 'coding_rules_missing':
      return make(spec.code, 'coding rules', `This repository has no coding rules (expected as .mdc files in ${BUILD_CODING_RULES_FOLDER}).`, ctx);
    case 'code_map_missing':
      return make(spec.code, 'code map', `This repository has no code map (expected at ${BUILD_CODE_MAP_PATH}).`, ctx);
    case 'agent_environment_missing':
      return make(
        spec.code,
        'prepared Cloud Agent environment',
        spec.reason === 'absent'
          ? `This repository has no prepared Cloud Agent environment (expected at ${BUILD_AGENT_ENVIRONMENT_PATH}).`
          : `The Cloud Agent environment file ${BUILD_AGENT_ENVIRONMENT_PATH} has no install command.`,
        ctx,
      );
    case 'pipeline_unusable': {
      const [item, problem] = PIPELINE_PROBLEM[spec.reason];
      return make(spec.code, item, problem, ctx);
    }
    case 'quality_manifest_missing':
      return make(
        spec.code,
        'quality manifest',
        spec.path ? `This repository has no quality manifest (expected at ${spec.path}).` : 'No quality manifest path is set in the Build profile.',
        ctx,
      );
    case 'quality_manifest_incomplete':
      return make(spec.code, 'quality manifest commands', `The quality manifest at ${spec.path} does not declare: ${spec.missingKeys.join(', ')}.`, ctx);
    case 'secret_in_snapshot':
      return make(spec.code, `secret in ${spec.field}`, `The build configuration holds a secret value in ${spec.field}.`, ctx);
    case 'check_unavailable': {
      const refusal = make(spec.code, spec.item, '', ctx);
      return {
        ...refusal,
        message: `Apex could not check the ${spec.item} just now. Try again in a minute. If it keeps failing, ask ${refusal.fixerLabel}.`,
      };
    }
    default: {
      const exhaustive: never = spec;
      return exhaustive;
    }
  }
}
