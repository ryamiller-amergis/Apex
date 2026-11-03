import { eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { projectSkillSettings } from '../db/schema';
import { getSkillConfigById, listSkillConfigsForProject } from './projectSettingsService';
import { getAssignmentsForProject } from './userProjectAssignmentService';
import { trackEvent } from './telemetry';
import {
  BUILD_PROFILE_ROLES,
  type BuildProfile,
  type BuildProfileRole,
} from '../../shared/types/build';
import {
  BUILD_CAP_DEFAULTS,
  emptyBuildProfile,
  type BuildModelSource,
  type BuildProfileResolution,
  type BuildProfileResponse,
  type BuildSupportContactSummary,
} from '../../shared/types/buildPreflight';
import type { ProjectSkillConfig } from '../../shared/types/projectSettings';
import { SUPPORT_CONTACT_REQUIRED_MESSAGE } from '../../shared/buildProfileSchema';

export type BuildProfileSettingsRow = Pick<
  ProjectSkillConfig,
  'buildProfile' | 'interviewModel' | 'developmentModel' | 'testCaseModel' | 'defaultModel'
>;

type ModelSetting = Exclude<BuildModelSource, 'profile'>;

/** The closest existing project model for each role, tried before `defaultModel`. */
const ROLE_FALLBACK: Record<BuildProfileRole, ModelSetting | null> = {
  intake: 'interviewModel',
  planner: null,
  implementer: 'developmentModel',
  qa: 'testCaseModel',
  check: null,
};

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function resolveModel(
  role: BuildProfileRole,
  profileModel: string | null,
  row: BuildProfileSettingsRow,
): { model: string | null; modelSource: BuildModelSource | null } {
  const own = clean(profileModel);
  if (own) return { model: own, modelSource: 'profile' };
  const fallback = ROLE_FALLBACK[role];
  const chain: ModelSetting[] = fallback ? [fallback, 'defaultModel'] : ['defaultModel'];
  for (const setting of chain) {
    const value = clean(row[setting]);
    if (value) return { model: value, modelSource: setting };
  }
  return { model: null, modelSource: null };
}

/** Pure and synchronous. Lists every unresolved role instead of inventing a value. */
export function resolveBuildProfile(row: BuildProfileSettingsRow): BuildProfileResolution {
  const profile = row.buildProfile ?? emptyBuildProfile();
  const roles = {} as BuildProfileResolution['roles'];
  const unresolvedRoles: BuildProfileRole[] = [];
  for (const role of BUILD_PROFILE_ROLES) {
    const setting = profile.roles?.[role] ?? { skillPath: null, model: null };
    const skillPath = clean(setting.skillPath);
    const { model, modelSource } = resolveModel(role, setting.model, row);
    const unresolved: Array<'skillPath' | 'model'> = [];
    if (!skillPath) unresolved.push('skillPath');
    if (!model) unresolved.push('model');
    if (unresolved.length > 0) unresolvedRoles.push(role);
    roles[role] = { skillPath, model, modelSource, unresolved };
  }
  const caps = profile.caps ?? emptyBuildProfile().caps;
  const costUsd = caps.costUsd ?? null;
  return {
    roles,
    caps: {
      costUsd,
      elapsedMinutesPerRevision: caps.elapsedMinutesPerRevision ?? BUILD_CAP_DEFAULTS.elapsedMinutesPerRevision,
      maxRevisions: caps.maxRevisions ?? BUILD_CAP_DEFAULTS.maxRevisions,
      maxParallelism: caps.maxParallelism ?? BUILD_CAP_DEFAULTS.maxParallelism,
    },
    unresolvedRoles,
    capsUnresolved: costUsd === null ? ['costUsd'] : [],
  };
}

export class BuildProfileError extends Error {
  constructor(
    readonly kind: 'not_found' | 'invalid_contacts',
    message: string,
    readonly fieldErrors: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'BuildProfileError';
  }
}

function contactSummaries(
  userIds: readonly string[],
  assigned: ReadonlyMap<string, string>,
): BuildSupportContactSummary[] {
  return userIds
    .filter((userId) => assigned.has(userId))
    .map((userId) => ({ userId, displayName: assigned.get(userId) ?? userId }));
}

async function assignedUsers(project: string): Promise<Map<string, string>> {
  const assignments = await getAssignmentsForProject(project);
  return new Map(assignments.map((a) => [a.userId, a.displayName || a.email || a.userId]));
}

function toResponse(
  row: ProjectSkillConfig,
  assigned: ReadonlyMap<string, string>,
): BuildProfileResponse {
  const profile = row.buildProfile ?? emptyBuildProfile();
  return {
    settingsId: row.id,
    project: row.project,
    repository: row.skillRepo,
    profile,
    resolution: resolveBuildProfile(row),
    supportContacts: contactSummaries(profile.supportContactUserIds, assigned),
    updatedAt: row.buildProfileUpdatedAt ?? null,
    updatedBy: row.buildProfileUpdatedBy ?? null,
  };
}

export async function getBuildProfile(settingsId: string): Promise<BuildProfileResponse | null> {
  const row = await getSkillConfigById(settingsId);
  if (!row) return null;
  return toResponse(row, await assignedUsers(row.project));
}

/** Writes only the profile and its audit columns; every other settings column stays as it is. */
export async function saveBuildProfile(input: {
  settingsId: string;
  profile: BuildProfile;
  actorOid: string | null;
}): Promise<BuildProfileResponse> {
  const row = await getSkillConfigById(input.settingsId);
  if (!row) throw new BuildProfileError('not_found', 'Repository configuration not found');

  const assigned = await assignedUsers(row.project);
  if (input.profile.supportContactUserIds.length === 0) {
    throw new BuildProfileError('invalid_contacts', SUPPORT_CONTACT_REQUIRED_MESSAGE, {
      supportContactUserIds: SUPPORT_CONTACT_REQUIRED_MESSAGE,
    });
  }
  const unassigned = input.profile.supportContactUserIds.filter((id) => !assigned.has(id));
  if (unassigned.length > 0) {
    const message = 'Each support contact must be a user assigned to this project.';
    throw new BuildProfileError('invalid_contacts', message, { supportContactUserIds: message });
  }

  const previous = row.buildProfile ?? null;
  const updatedAt = new Date().toISOString();
  await db
    .update(projectSkillSettings)
    .set({
      buildProfile: input.profile,
      buildProfileUpdatedAt: updatedAt,
      buildProfileUpdatedBy: input.actorOid,
    })
    .where(eq(projectSkillSettings.id, input.settingsId));

  trackEvent('BuildProfileSaved', {
    project: row.project,
    settingsId: row.id,
    changedFields: changedFields(previous, input.profile).join(','),
  });

  return toResponse(
    {
      ...row,
      buildProfile: input.profile,
      buildProfileUpdatedAt: updatedAt,
      buildProfileUpdatedBy: input.actorOid,
    },
    assigned,
  );
}

function changedFields(previous: BuildProfile | null, next: BuildProfile): string[] {
  const before = previous ?? emptyBuildProfile();
  const fields: string[] = [];
  for (const role of BUILD_PROFILE_ROLES) {
    if (before.roles[role]?.skillPath !== next.roles[role].skillPath) fields.push(`roles.${role}.skillPath`);
    if (before.roles[role]?.model !== next.roles[role].model) fields.push(`roles.${role}.model`);
  }
  for (const key of Object.keys(next.caps) as Array<keyof BuildProfile['caps']>) {
    if (before.caps[key] !== next.caps[key]) fields.push(`caps.${key}`);
  }
  if (before.qualityManifestPath !== next.qualityManifestPath) fields.push('qualityManifestPath');
  if (before.deployPipelineId !== next.deployPipelineId) fields.push('deployPipelineId');
  if (before.supportContactUserIds.join(',') !== next.supportContactUserIds.join(',')) {
    fields.push('supportContactUserIds');
  }
  return fields;
}

/** The settings row for a project and repository; repository match ignores case, like the allow-list. */
export async function loadSettingsForRepository(
  project: string,
  repository: string,
): Promise<ProjectSkillConfig | null> {
  const wanted = repository.trim().toLowerCase();
  if (!wanted) return null;
  const rows = await listSkillConfigsForProject(project);
  return rows.find((row) => row.skillRepo?.trim().toLowerCase() === wanted) ?? null;
}
