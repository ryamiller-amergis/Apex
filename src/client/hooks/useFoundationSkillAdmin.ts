import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  FoundationSkillRelease,
  FoundationSkillReleaseAuditEntry,
  FoundationSkillRepoStatus,
  ArtifactCandidate,
  CreateFoundationSkillReleaseRequest,
  SkillMatrixEntry,
  FoundationSkillTeam,
  RollbackFoundationSkillRepoResult,
  ProjectAvailableSkill,
  FoundationSkillCatalogEntry,
  FoundationSkillCatalogResponse,
  FoundationSkillReleaseValidationErrorResponse,
  FoundationSkillReleaseValidationIssue,
} from '../../shared/types/foundationSkills';

// ── Fetch helper ──────────────────────────────────────────────────────────────

export class FoundationSkillReleaseValidationClientError extends Error {
  readonly code = 'release_validation_failed' as const;
  readonly issues: FoundationSkillReleaseValidationIssue[];
  readonly status: number;

  constructor(
    message: string,
    issues: FoundationSkillReleaseValidationIssue[],
    status: number,
  ) {
    super(message);
    this.name = 'FoundationSkillReleaseValidationClientError';
    this.issues = issues;
    this.status = status;
  }
}

export async function adminFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...init });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    if (
      res.status === 422 &&
      (body as FoundationSkillReleaseValidationErrorResponse).code === 'release_validation_failed' &&
      Array.isArray((body as FoundationSkillReleaseValidationErrorResponse).issues)
    ) {
      throw new FoundationSkillReleaseValidationClientError(
        (body as FoundationSkillReleaseValidationErrorResponse).error ?? 'Release validation failed',
        (body as FoundationSkillReleaseValidationErrorResponse).issues,
        res.status,
      );
    }
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  if (res.status === 204 || res.headers.get('content-length') === '0') return undefined as T;
  return res.json() as Promise<T>;
}

// ── Query keys ────────────────────────────────────────────────────────────────

export const foundationSkillAdminKeys = {
  candidates:     ['foundation-skills-admin', 'candidates']     as const,
  releases:       ['foundation-skills-admin', 'releases']       as const,
  release:        (id: string) => ['foundation-skills-admin', 'releases', id] as const,
  audit:          (id: string) => ['foundation-skills-admin', 'audit', id] as const,
  repoStatuses:   ['foundation-skills-admin', 'repo-statuses']  as const,
  teams:          ['foundation-skills-admin', 'teams']          as const,
  rollbackTargets:(apexProject: string, installedVersion: string) =>
    ['foundation-skills-admin', 'rollback-targets', apexProject, installedVersion] as const,
  catalog:        ['foundation-skills-admin', 'catalog']        as const,
  skillsMatrix:   ['foundation-skills-admin', 'skills-matrix']  as const,
  projectSkills:  (project: string) => ['foundation-skills-admin', 'project-skills', project] as const,
};

// ── Candidates ────────────────────────────────────────────────────────────────

export function useFoundationSkillCandidates() {
  return useQuery<ArtifactCandidate[]>({
    queryKey: foundationSkillAdminKeys.candidates,
    queryFn: async () => {
      const data = await adminFetch<{ candidates: ArtifactCandidate[] }>(
        '/api/platform-admin/foundation-skills/candidates',
      );
      return data.candidates;
    },
    staleTime: 60_000,
  });
}

// ── Releases ──────────────────────────────────────────────────────────────────

export function useFoundationSkillReleases() {
  return useQuery<FoundationSkillRelease[]>({
    queryKey: foundationSkillAdminKeys.releases,
    queryFn: async () => {
      const data = await adminFetch<{ releases: FoundationSkillRelease[] }>(
        '/api/platform-admin/foundation-skills/releases',
      );
      return data.releases;
    },
    staleTime: 30_000,
  });
}

export function useCreateFoundationSkillRelease() {
  const qc = useQueryClient();
  return useMutation<FoundationSkillRelease, Error, CreateFoundationSkillReleaseRequest>({
    mutationFn: (body) =>
      adminFetch<{ release: FoundationSkillRelease }>(
        '/api/platform-admin/foundation-skills/releases',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      ).then((d) => d.release),
    onSuccess: () => { qc.invalidateQueries({ queryKey: foundationSkillAdminKeys.releases }); },
  });
}

export function usePublishFoundationSkillRelease() {
  const qc = useQueryClient();
  return useMutation<FoundationSkillRelease, Error, string>({
    mutationFn: (id) =>
      adminFetch<{ release: FoundationSkillRelease }>(
        `/api/platform-admin/foundation-skills/releases/${id}/publish`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
      ).then((d) => d.release),
    onSuccess: (release) => {
      qc.invalidateQueries({ queryKey: foundationSkillAdminKeys.releases });
      qc.invalidateQueries({ queryKey: foundationSkillAdminKeys.release(release.id) });
    },
  });
}

export function useDeprecateFoundationSkillRelease() {
  const qc = useQueryClient();
  return useMutation<FoundationSkillRelease, Error, { id: string; reason?: string }>({
    mutationFn: ({ id, reason }) =>
      adminFetch<{ release: FoundationSkillRelease }>(
        `/api/platform-admin/foundation-skills/releases/${id}/deprecate`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }) },
      ).then((d) => d.release),
    onSuccess: (release) => {
      qc.invalidateQueries({ queryKey: foundationSkillAdminKeys.releases });
      qc.invalidateQueries({ queryKey: foundationSkillAdminKeys.release(release.id) });
    },
  });
}

export function useDeleteDraftFoundationSkillRelease() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) =>
      adminFetch<void>(`/api/platform-admin/foundation-skills/releases/${id}`, { method: 'DELETE' }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: foundationSkillAdminKeys.releases }); },
  });
}

export interface UpdateReleasePayload {
  id: string;
  releaseNotes?:    string | null;
  breakingChanges?: string | null;
  targetProjects?:  string[];
  /** Per-skill project targeting overrides. */
  skillTargets?:    Record<string, string[]>;
  selectedSkills?:  string[];
  /** Draft-only fields */
  version?:         string;
  artifactVersion?: string;
}

export function useUpdateFoundationSkillRelease() {
  const qc = useQueryClient();
  return useMutation<{ release: FoundationSkillRelease }, Error, UpdateReleasePayload>({
    mutationFn: ({ id, ...body }) =>
      adminFetch(`/api/platform-admin/foundation-skills/releases/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: foundationSkillAdminKeys.releases });
      qc.invalidateQueries({ queryKey: ['foundation-skill-release', 'latest'] });
    },
  });
}

export function useFoundationSkillReleaseAudit(releaseId: string | null) {
  return useQuery<FoundationSkillReleaseAuditEntry[]>({
    queryKey: foundationSkillAdminKeys.audit(releaseId ?? ''),
    queryFn: async () => {
      const data = await adminFetch<{ entries: FoundationSkillReleaseAuditEntry[] }>(
        `/api/platform-admin/foundation-skills/releases/${releaseId}/audit`,
      );
      return data.entries;
    },
    enabled: !!releaseId,
    staleTime: 30_000,
  });
}

// ── Repo statuses ─────────────────────────────────────────────────────────────

export function useFoundationSkillRepoStatuses() {
  return useQuery<FoundationSkillRepoStatus[]>({
    queryKey: foundationSkillAdminKeys.repoStatuses,
    queryFn: async () => {
      const data = await adminFetch<{ statuses: FoundationSkillRepoStatus[] }>(
        '/api/platform-admin/foundation-skills/repo-statuses',
      );
      return data.statuses;
    },
    staleTime: 60_000,
  });
}

export function useUpdateRepoWithFoundationSkills() {
  const qc = useQueryClient();
  return useMutation<
    { status: string; prUrl: string | null; report: string; errors: string[] },
    Error,
    {
      project: string;
      repo: string;
      provider?: 'ado' | 'github';
      defaultBranch?: string;
      releaseId?: string;
      apexProject: string;
      skillRoot?: string;
    }
  >({
    mutationFn: (body) =>
      adminFetch('/api/platform-admin/foundation-skills/update-repo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: foundationSkillAdminKeys.repoStatuses });
    },
  });
}

// ── Active teams ──────────────────────────────────────────────────────────────

/**
 * Every Apex project with a registered skills repo, its installed version, that
 * version's release status, and the skills shipped to it.
 */
export function useFoundationSkillTeams() {
  return useQuery<FoundationSkillTeam[]>({
    queryKey: foundationSkillAdminKeys.teams,
    queryFn: async () => {
      const data = await adminFetch<{ teams: FoundationSkillTeam[] }>(
        '/api/platform-admin/foundation-skills/teams',
      );
      return data.teams;
    },
    staleTime: 60_000,
  });
}

/** Re-scan every registered repo so the teams grid reflects current state. */
export function useScanAllFoundationSkillRepos() {
  const qc = useQueryClient();
  return useMutation<{ scanned: number; failed: number; errors: string[] }, Error, void>({
    mutationFn: () =>
      adminFetch('/api/platform-admin/foundation-skills/repos/scan-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: foundationSkillAdminKeys.teams });
      qc.invalidateQueries({ queryKey: foundationSkillAdminKeys.repoStatuses });
    },
  });
}

/** Published releases older than the installed version for a given Apex project. */
export function useFoundationSkillRollbackTargets(
  apexProject: string | null | undefined,
  installedVersion: string | null | undefined,
) {
  return useQuery<FoundationSkillRelease[]>({
    queryKey: foundationSkillAdminKeys.rollbackTargets(apexProject ?? '', installedVersion ?? ''),
    queryFn: async () => {
      const params = new URLSearchParams({
        apexProject: apexProject!,
        installedVersion: installedVersion!,
      });
      const data = await adminFetch<{ releases: FoundationSkillRelease[] }>(
        `/api/platform-admin/foundation-skills/rollback-targets?${params.toString()}`,
      );
      return data.releases;
    },
    enabled: !!(apexProject && installedVersion),
    staleTime: 60_000,
  });
}

/** Open a rollback PR that re-vendors an older published release into a consumer repo. */
export function useRollbackFoundationSkillRepo() {
  const qc = useQueryClient();
  return useMutation<
    RollbackFoundationSkillRepoResult,
    Error,
    {
      project: string;
      repo: string;
      apexProject: string;
      releaseId: string;
      provider?: string;
      defaultBranch?: string;
      fromVersion?: string | null;
    }
  >({
    mutationFn: (body) =>
      adminFetch('/api/platform-admin/foundation-skills/rollback-repo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: foundationSkillAdminKeys.teams });
      qc.invalidateQueries({ queryKey: foundationSkillAdminKeys.repoStatuses });
    },
  });
}

export function useCheckFoundationSkillCompatibility() {
  const qc = useQueryClient();
  return useMutation<
    { report: { status: string; errors: string[]; warnings: string[] } },
    Error,
    { project: string; repo: string; provider?: string; branch?: string; apexProject?: string | null }
  >({
    mutationFn: (body) =>
      adminFetch('/api/platform-admin/foundation-skills/check-compatibility', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: foundationSkillAdminKeys.repoStatuses });
    },
  });
}

// ── Catalog ───────────────────────────────────────────────────────────────────

/**
 * The catalog of known foundation skills, served from catalog.json. This is the
 * only place the UI learns which skills exist — adding one to catalog.json makes
 * it appear here with no client change.
 */
export function useFoundationSkillCatalog() {
  return useQuery<FoundationSkillCatalogResponse>({
    queryKey: foundationSkillAdminKeys.catalog,
    queryFn: () =>
      adminFetch<FoundationSkillCatalogResponse>('/api/platform-admin/foundation-skills/catalog'),
    staleTime: 5 * 60_000,
  });
}

/** Catalog entries that may actually be released to projects. */
export function useShippableFoundationSkills(): {
  skills: FoundationSkillCatalogEntry[];
  isLoading: boolean;
} {
  const { data, isLoading } = useFoundationSkillCatalog();
  return {
    skills: (data?.skills ?? []).filter((s) => s.tier !== 'apex-only'),
    isLoading,
  };
}

// ── Skills matrix ─────────────────────────────────────────────────────────────

/** Platform Admin: full skills × releases matrix with effective audience per entry. */
export function useFoundationSkillMatrix() {
  return useQuery<SkillMatrixEntry[]>({
    queryKey: foundationSkillAdminKeys.skillsMatrix,
    queryFn: async () => {
      const data = await adminFetch<{ skills: SkillMatrixEntry[] }>(
        '/api/platform-admin/foundation-skills/skills/matrix',
      );
      return data.skills;
    },
    staleTime: 60_000,
  });
}

/** Project Admin / consumer: skills available to a specific Apex project. */
export function useProjectAvailableSkills(project: string) {
  return useQuery<ProjectAvailableSkill[]>({
    queryKey: foundationSkillAdminKeys.projectSkills(project),
    queryFn: async () => {
      const data = await adminFetch<{ skills: ProjectAvailableSkill[] }>(
        `/api/platform-admin/foundation-skills/project-skills?project=${encodeURIComponent(project)}`,
      );
      return data.skills;
    },
    enabled: !!project,
    staleTime: 60_000,
  });
}
