/**
 * Shared types for the APEX Foundation Skills release management system.
 *
 * These types are used by:
 *   - src/server/services/foundationSkillReleaseService.ts
 *   - src/server/services/azureArtifactsSkillService.ts
 *   - src/server/services/foundationSkillCompatibilityService.ts
 *   - src/client/hooks/useFoundationSkillAdmin.ts
 *   - src/client/hooks/useFoundationSkillUpdateStatus.ts
 */

// ── Release lifecycle ─────────────────────────────────────────────────────────

export type FoundationSkillReleaseStatus =
  | 'draft'
  | 'publishing'
  | 'published'
  | 'deprecated';

export type FoundationSkillAuditAction =
  | 'created'
  | 'validated'
  | 'validation_failed'
  | 'edited'
  | 'published'
  | 'deprecated'
  | 'rollback';

export type FoundationSkillCompatibilityStatus =
  | 'compatible'
  | 'incompatible'
  | 'drift'
  | 'not-installed'
  | 'unknown';

// ── Release record ────────────────────────────────────────────────────────────

export interface FoundationSkillRelease {
  id: string;
  version: string;
  status: FoundationSkillReleaseStatus;
  artifactPackage: string;      // '@apex/skills'
  artifactVersion: string;      // semver published to the feed
  artifactFeed: string | null;  // Azure Artifacts feed URL
  integritySha256: string | null;
  contractApiVersion: number;
  selectedSkills: string[];     // skill names included in this release
  targetProjects: string[];     // [] = all projects; non-empty = allowlist of Apex project names
  /** Per-skill project overrides. skill → string[].
   *  Empty array means "all projects". Absent key inherits targetProjects. */
  skillTargets: Record<string, string[]>;
  manifestSnapshot: FoundationSkillArtifactManifest | null;
  releaseNotes: string | null;
  breakingChanges: string | null;
  publishedBy: string | null;
  publishedAt: string | null;
  deprecatedBy: string | null;
  deprecatedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface FoundationSkillArtifactManifestSkill {
  name: string;
  summary: string;
  tier: FoundationSkillTier;
  alwaysInstall: boolean;
  dependsOn: string[];
  scanScope?: 'targeted' | 'full-repo';
  foundationFiles?: string[];
  adapterFiles?: string[];
  supportingOwners?: Record<string, 'foundation' | 'adapter'>;
}

/** Immutable catalog.json snapshot extracted from the published npm tarball. */
export interface FoundationSkillArtifactManifest {
  suiteVersion: string;
  package: string;
  contractApiVersion: number;
  skills: FoundationSkillArtifactManifestSkill[];
}

// ── Audit log ─────────────────────────────────────────────────────────────────

export interface FoundationSkillReleaseAuditEntry {
  id: string;
  releaseId: string | null;
  releaseVersion: string;
  action: FoundationSkillAuditAction;
  actorId: string | null;
  actorEmail: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

// ── Consumer repo status ──────────────────────────────────────────────────────

export interface FoundationSkillRepoStatus {
  id: string;
  provider: 'ado' | 'github';
  /** ADO/GitHub project that owns the repo. */
  project: string;
  repo: string;
  branch: string;
  /** Apex project name — the identifier release targeting is keyed on. */
  apexProject: string | null;
  installedVersion: string | null;
  selectedSkills: string[];
  lockHash: string | null;
  compatibilityStatus: FoundationSkillCompatibilityStatus;
  compatibilityErrors: string[];
  availableVersion: string | null;
  updateAvailable: boolean;
  compatibilityCheckedAt: string | null;
  lastObservedAt: string;
  observedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

// ── API request / response shapes ────────────────────────────────────────────

export interface CreateFoundationSkillReleaseRequest {
  version: string;
  artifactVersion: string;
  selectedSkills: string[];
  targetProjects?: string[];    // [] or omit = all projects; non-empty = Apex project allowlist
  /** Per-skill project overrides. Absent key inherits targetProjects. */
  skillTargets?: Record<string, string[]>;
  releaseNotes?: string | null;
  breakingChanges?: string | null;
}

export interface PublishFoundationSkillReleaseRequest {
  releaseId: string;
}

export interface DeprecateFoundationSkillReleaseRequest {
  releaseId: string;
  reason?: string | null;
}

export interface FoundationSkillReleasesResponse {
  releases: FoundationSkillRelease[];
}

export interface FoundationSkillReleaseResponse {
  release: FoundationSkillRelease;
}

export interface FoundationSkillAuditResponse {
  entries: FoundationSkillReleaseAuditEntry[];
}

export interface FoundationSkillRepoStatusesResponse {
  statuses: FoundationSkillRepoStatus[];
}

// ── Compatibility report ──────────────────────────────────────────────────────

export interface FoundationSkillCompatibilityReport {
  provider: 'ado' | 'github';
  project: string;
  repo: string;
  branch: string;
  installedVersion: string | null;
  candidateVersion: string;
  status: FoundationSkillCompatibilityStatus;
  /** Status of the release matching `installedVersion`; null when unmatched. */
  installedReleaseStatus: FoundationSkillReleaseStatus | null;
  errors: string[];
  warnings: string[];
  driftedFiles: string[];
  checkedAt: string;
}

export interface CheckCompatibilityRequest {
  provider: 'ado' | 'github';
  project: string;
  repo: string;
  branch?: string;
  candidateVersion?: string; // defaults to latest published visible to apexProject
  apexProject?: string | null; // Apex project name for targeted-release filtering
}

// ── Catalog ───────────────────────────────────────────────────────────────────

/**
 * Whether a skill may be released to consumer projects.
 *   shippable — lands in team repos and is offered in the release picker.
 *   apex-only — executes inside the Apex platform itself; never released to teams.
 * Absent in catalog.json means `shippable`.
 */
export type FoundationSkillTier = 'shippable' | 'apex-only';

/** One entry from foundation-skills/catalog.json, as served to the client. */
export interface FoundationSkillCatalogEntry {
  name: string;
  summary: string;
  tier: FoundationSkillTier;
  /** When true, skill is locked into every draft/published release and install. */
  alwaysInstall?: boolean;
  dependsOn?: string[];
}

export interface FoundationSkillCatalogResponse {
  suiteVersion: string;
  skills: FoundationSkillCatalogEntry[];
}

export type FoundationSkillReleaseValidationIssueType =
  | 'missing_dependency'
  | 'audience_gap';

export interface FoundationSkillReleaseValidationIssue {
  type: FoundationSkillReleaseValidationIssueType;
  dependentSkill: string;
  dependency: string;
  message: string;
  remediation: string;
  dependentProjects: string[];
  dependencyProjects: string[];
}

export interface FoundationSkillReleaseValidationErrorResponse {
  error: string;
  code: 'release_validation_failed';
  issues: FoundationSkillReleaseValidationIssue[];
}

// ── Skills matrix ─────────────────────────────────────────────────────────────

/** One row in the Platform Admin skills matrix. */
export interface SkillMatrixEntry {
  name: string;
  summary: string;
  /** All releases that include this skill, with the resolved effective audience. */
  releases: Array<{
    releaseId: string;
    version: string;
    status: FoundationSkillReleaseStatus;
    /** Resolved audience after applying per-skill override.
     *  [] means "all projects". */
    effectiveTargetProjects: string[];
  }>;
}

export interface FoundationSkillsMatrixResponse {
  skills: SkillMatrixEntry[];
}

/** Skills available to a specific Apex project (for Project Admin read-only view). */
export interface ProjectAvailableSkill {
  name: string;
  summary: string;
  version: string;
  releaseId: string;
  /** Resolved effective audience; [] = all. */
  effectiveTargetProjects: string[];
}

export interface ProjectAvailableSkillsResponse {
  skills: ProjectAvailableSkill[];
}

// ── Active teams grid (Platform Admin) ────────────────────────────────────────

/** One registered consumer repo belonging to an Apex project. */
export interface FoundationSkillTeamRepo {
  provider: 'ado' | 'github';
  /** ADO/GitHub project that owns the repo. */
  project: string;
  repo: string;
  branch: string;
  /** Display label from the project's skill config. */
  friendlyName: string;
  /** False when the repo is registered but has never been scanned. */
  observed: boolean;
  installedVersion: string | null;
  /** Status of the release matching `installedVersion`; null when unmatched. */
  installedReleaseStatus: FoundationSkillReleaseStatus | null;
  /** Skill names recorded in the repo's lockfile. */
  installedSkills: string[];
  /** Skills the installed release shipped to this team, after targeting. */
  releasedSkills: string[];
  availableVersion: string | null;
  updateAvailable: boolean;
  compatibilityStatus: FoundationSkillCompatibilityStatus;
  compatibilityCheckedAt: string | null;
  lastObservedAt: string | null;
}

/** One Apex project ("team") with every repo registered under it. */
export interface FoundationSkillTeam {
  apexProject: string;
  repos: FoundationSkillTeamRepo[];
}

export interface FoundationSkillTeamsResponse {
  teams: FoundationSkillTeam[];
}

// ── Rollback ──────────────────────────────────────────────────────────────────

export interface RollbackFoundationSkillRepoRequest {
  /** ADO/GitHub project that owns the repo. */
  project: string;
  repo: string;
  provider?: 'ado' | 'github';
  defaultBranch?: string;
  /** Apex project name — used for targeting and audit. */
  apexProject: string;
  /** Target published release to roll back to. */
  releaseId: string;
  /** Optional installed version override; defaults to last observed status. */
  fromVersion?: string | null;
}

export interface RollbackFoundationSkillRepoResult {
  status: 'pr_created' | 'no_changes' | 'drift' | 'incompatible' | 'error';
  prUrl: string | null;
  branchName: string | null;
  changedFiles: string[];
  report: string;
  fromVersion: string | null;
  toVersion: string | null;
  errors: string[];
}

// ── Azure Artifacts ───────────────────────────────────────────────────────────

export interface ArtifactCandidate {
  packageName: string;
  version: string;
  publishedAt: string;
  feedUrl: string;
  integrity: string | null;
  manifestUrl: string | null;
}

// ── Pure release-targeting helpers (shared client + server) ──────────────────

/**
 * Returns true if the release is visible to the given Apex project.
 * An empty targetProjects array means the release is visible to all projects.
 */
export function isReleaseVisibleToProject(
  release: Pick<FoundationSkillRelease, 'targetProjects'>,
  apexProject: string | null | undefined,
): boolean {
  if (!release.targetProjects || release.targetProjects.length === 0) return true;
  if (!apexProject) return false;
  return release.targetProjects.includes(apexProject);
}

/**
 * Returns the effective project allowlist for a specific skill in a release.
 * Resolution rule: skillTargets[skill] ?? release.targetProjects.
 * An empty array means "all projects".
 */
export function getEffectiveTargetProjects(
  release: Pick<FoundationSkillRelease, 'targetProjects' | 'skillTargets'>,
  skillName: string,
): string[] {
  const override = release.skillTargets?.[skillName];
  if (override !== undefined) return override;
  return release.targetProjects ?? [];
}

/**
 * Skills every entitled project receives with install/update, even when omitted
 * from a release's selectedSkills. Keep in sync with
 * foundation-skills/lib/alwaysInstall.mjs and catalog.json `alwaysInstall`.
 */
export const ALWAYS_INSTALL_SKILLS = [
  'post-skill-bootstrap',
  'update-changelog',
] as const;

export function isAlwaysInstallCatalogSkill(
  skill: Pick<FoundationSkillCatalogEntry, 'name' | 'alwaysInstall'>,
): boolean {
  return skill.alwaysInstall === true
    || (ALWAYS_INSTALL_SKILLS as readonly string[]).includes(skill.name);
}

/** Always-install skills present in the given catalog (draft UI / release enforce). */
export function alwaysInstallSkillsFromCatalog(
  catalog: Array<Pick<FoundationSkillCatalogEntry, 'name' | 'alwaysInstall'>>,
): string[] {
  return catalog.filter(isAlwaysInstallCatalogSkill).map((skill) => skill.name);
}

/** Append always-install skills (deduped) after the release-visible list. */
export function withAlwaysInstallSkills(skills: string[]): string[] {
  const out = [...skills];
  const seen = new Set(out);
  for (const name of ALWAYS_INSTALL_SKILLS) {
    if (!seen.has(name)) {
      out.push(name);
      seen.add(name);
    }
  }
  return out;
}

/**
 * Ensure a release's selectedSkills includes every always-install skill that
 * exists in the catalog (cannot be omitted from draft create/update).
 */
export function ensureReleaseAlwaysInstallSkills(
  selectedSkills: string[],
  catalog: Array<Pick<FoundationSkillCatalogEntry, 'name' | 'alwaysInstall'>>,
): string[] {
  const out = [...selectedSkills];
  const seen = new Set(out);
  for (const name of alwaysInstallSkillsFromCatalog(catalog)) {
    if (!seen.has(name)) {
      out.push(name);
      seen.add(name);
    }
  }
  return out;
}

/**
 * Returns the skill names from this release that are visible to the given project.
 * Applies per-skill overrides via getEffectiveTargetProjects.
 */
export function getVisibleSkillsForProject(
  release: Pick<FoundationSkillRelease, 'selectedSkills' | 'targetProjects' | 'skillTargets'>,
  apexProject: string | null | undefined,
): string[] {
  return (release.selectedSkills ?? []).filter((skill) => {
    const effective = getEffectiveTargetProjects(release, skill);
    if (effective.length === 0) return true;
    if (!apexProject) return false;
    return effective.includes(apexProject);
  });
}
