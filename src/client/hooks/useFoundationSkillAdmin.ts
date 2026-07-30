import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  FoundationSkillRelease,
  FoundationSkillReleaseAuditEntry,
  FoundationSkillRepoStatus,
  ArtifactCandidate,
  CreateFoundationSkillReleaseRequest,
} from '../../shared/types/foundationSkills';

// ── Fetch helper ──────────────────────────────────────────────────────────────

async function adminFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...init });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  if (res.status === 204 || res.headers.get('content-length') === '0') return undefined as T;
  return res.json() as Promise<T>;
}

// ── Query keys ────────────────────────────────────────────────────────────────

export const foundationSkillAdminKeys = {
  candidates:   ['foundation-skills-admin', 'candidates']   as const,
  releases:     ['foundation-skills-admin', 'releases']     as const,
  release:      (id: string) => ['foundation-skills-admin', 'releases', id] as const,
  audit:        (id: string) => ['foundation-skills-admin', 'audit', id] as const,
  repoStatuses: ['foundation-skills-admin', 'repo-statuses'] as const,
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
  /** Draft-only fields */
  version?:         string;
  artifactVersion?: string;
  artifactFeed?:    string | null;
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
    { project: string; repo: string; provider?: string; defaultBranch?: string; releaseId?: string }
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
