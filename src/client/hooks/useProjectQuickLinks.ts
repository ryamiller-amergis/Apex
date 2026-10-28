import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateProjectQuickLinkInput,
  ProjectQuickLink,
  ProjectQuickLinksListResponse,
  UpdateProjectQuickLinkInput,
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
