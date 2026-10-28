import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateProjectQuickLinkInput,
  CreateUserQuickLinkInput,
  ImportUserQuickLinksResult,
  ProjectQuickLink,
  ProjectQuickLinksListResponse,
  UpdateProjectQuickLinkInput,
  UpdateUserQuickLinkInput,
  UserQuickLink,
  UserQuickLinksListResponse,
} from '../../shared/types/projectQuickLinks';

export class ProjectQuickLinksApiError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ProjectQuickLinksApiError';
    this.status = status;
    this.code = code;
  }
}

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'include', ...init });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string; code?: string };
    throw new ProjectQuickLinksApiError(
      body.error ?? `Request failed: ${response.status}`,
      response.status,
      body.code,
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function linksUrl(project: string, suffix?: string): string {
  const base = `/api/projects/${encodeURIComponent(project)}/quick-links`;
  return suffix ? `${base}/${suffix}` : base;
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export const projectQuickLinksQueryKey = (project: string) => ['project-quick-links', project] as const;

export function useProjectQuickLinks(project: string | null | undefined) {
  return useQuery<ProjectQuickLink[]>({
    queryKey: projectQuickLinksQueryKey(project ?? ''),
    queryFn: async () => {
      const data = await apiFetch<ProjectQuickLinksListResponse>(linksUrl(project!));
      return data.items;
    },
    enabled: Boolean(project),
    staleTime: 60_000,
  });
}

function useInvalidateQuickLinks(project: string | null | undefined) {
  const queryClient = useQueryClient();
  return () => {
    if (!project) return;
    void queryClient.invalidateQueries({ queryKey: projectQuickLinksQueryKey(project) });
  };
}

export function useCreateProjectQuickLink(project: string | null | undefined) {
  const invalidate = useInvalidateQuickLinks(project);
  return useMutation<ProjectQuickLink, ProjectQuickLinksApiError, CreateProjectQuickLinkInput>({
    mutationFn: (input) =>
      apiFetch<ProjectQuickLink>(linksUrl(project!), {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });
}

export function useUpdateProjectQuickLink(project: string | null | undefined) {
  const invalidate = useInvalidateQuickLinks(project);
  return useMutation<
    ProjectQuickLink,
    ProjectQuickLinksApiError,
    { id: string; input: UpdateProjectQuickLinkInput }
  >({
    mutationFn: ({ id, input }) =>
      apiFetch<ProjectQuickLink>(linksUrl(project!, encodeURIComponent(id)), {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });
}

export function useDeleteProjectQuickLink(project: string | null | undefined) {
  const invalidate = useInvalidateQuickLinks(project);
  return useMutation<void, ProjectQuickLinksApiError, { id: string }>({
    mutationFn: ({ id }) =>
      apiFetch<void>(linksUrl(project!, encodeURIComponent(id)), { method: 'DELETE' }),
    onSuccess: invalidate,
  });
}

export function useReorderProjectQuickLinks(project: string | null | undefined) {
  const invalidate = useInvalidateQuickLinks(project);
  return useMutation<ProjectQuickLink[], ProjectQuickLinksApiError, { ids: string[] }>({
    mutationFn: ({ ids }) =>
      apiFetch<ProjectQuickLinksListResponse>(linksUrl(project!, 'order'), {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ ids }),
      }).then((data) => data.items),
    onSuccess: invalidate,
  });
}

function myLinksUrl(project: string, suffix?: string): string {
  const base = `/api/projects/${encodeURIComponent(project)}/my-quick-links`;
  return suffix ? `${base}/${suffix}` : base;
}

export const myQuickLinksQueryKey = (project: string) => ['my-quick-links', project] as const;

/** The signed-in user's personal links for a project. Pass `enabled: false` without `quick-links:personal`. */
export function useMyQuickLinks(project: string | null | undefined, enabled = true) {
  return useQuery<UserQuickLink[]>({
    queryKey: myQuickLinksQueryKey(project ?? ''),
    queryFn: async () => {
      const data = await apiFetch<UserQuickLinksListResponse>(myLinksUrl(project!));
      return data.items;
    },
    enabled: Boolean(project) && enabled,
    staleTime: 60_000,
  });
}

function useInvalidateMyQuickLinks(project: string | null | undefined) {
  const queryClient = useQueryClient();
  return () => {
    if (!project) return;
    void queryClient.invalidateQueries({ queryKey: myQuickLinksQueryKey(project) });
  };
}

export function useCreateMyQuickLink(project: string | null | undefined) {
  const invalidate = useInvalidateMyQuickLinks(project);
  return useMutation<UserQuickLink, ProjectQuickLinksApiError, CreateUserQuickLinkInput>({
    mutationFn: (input) =>
      apiFetch<UserQuickLink>(myLinksUrl(project!), {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });
}

export function useUpdateMyQuickLink(project: string | null | undefined) {
  const invalidate = useInvalidateMyQuickLinks(project);
  return useMutation<
    UserQuickLink,
    ProjectQuickLinksApiError,
    { id: string; input: UpdateUserQuickLinkInput }
  >({
    mutationFn: ({ id, input }) =>
      apiFetch<UserQuickLink>(myLinksUrl(project!, encodeURIComponent(id)), {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  });
}

export function useDeleteMyQuickLink(project: string | null | undefined) {
  const invalidate = useInvalidateMyQuickLinks(project);
  return useMutation<void, ProjectQuickLinksApiError, { id: string }>({
    mutationFn: ({ id }) =>
      apiFetch<void>(myLinksUrl(project!, encodeURIComponent(id)), { method: 'DELETE' }),
    onSuccess: invalidate,
  });
}

export function useImportMyQuickLinks(project: string | null | undefined) {
  const invalidate = useInvalidateMyQuickLinks(project);
  return useMutation<ImportUserQuickLinksResult, ProjectQuickLinksApiError, { items: CreateUserQuickLinkInput[] }>({
    mutationFn: ({ items }) =>
      apiFetch<ImportUserQuickLinksResult>(myLinksUrl(project!, 'import'), {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ items }),
      }),
    onSuccess: invalidate,
  });
}
