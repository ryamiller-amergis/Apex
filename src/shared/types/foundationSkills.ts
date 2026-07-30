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

export type FoundationSkillReleaseStatus = 'draft' | 'published' | 'deprecated';

export type FoundationSkillAuditAction =
  | 'created'
  | 'validated'
  | 'validation_failed'
  | 'published'
  | 'deprecated';

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
  manifestSnapshot: Record<string, unknown> | null; // catalog.json at publish time
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
  project: string;
  repo: string;
  branch: string;
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
  artifactFeed?: string | null;
  integritySha256?: string | null;
  selectedSkills: string[];
  targetProjects?: string[];    // [] or omit = all projects; non-empty = Apex project allowlist
  manifestSnapshot?: Record<string, unknown> | null;
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

// ── Azure Artifacts ───────────────────────────────────────────────────────────

export interface ArtifactCandidate {
  packageName: string;
  version: string;
  publishedAt: string;
  feedUrl: string;
  integrity: string | null;
  manifestUrl: string | null;
}
