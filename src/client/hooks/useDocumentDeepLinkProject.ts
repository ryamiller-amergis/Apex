import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  parseDocumentDeepLink,
  type DocumentDeepLink,
} from '../utils/documentProjectDeepLink';

async function fetchDocumentProject(link: DocumentDeepLink): Promise<string> {
  const params = new URLSearchParams({ kind: link.kind, id: link.id });
  const response = await fetch(`/api/links/project?${params}`, { credentials: 'include' });
  if (!response.ok) {
    throw new Error(`Document project lookup failed: ${response.status}`);
  }
  const body = await response.json() as { project?: unknown };
  if (typeof body.project !== 'string' || body.project.trim().length === 0) {
    throw new Error('Document project lookup returned no project');
  }
  return body.project;
}

export function useDocumentDeepLinkProject(pathname: string, search = ''): {
  link: DocumentDeepLink | null;
  project: string | undefined;
  pending: boolean;
  failed: boolean;
} {
  const link = useMemo(() => parseDocumentDeepLink(pathname, search), [pathname, search]);
  const query = useQuery({
    queryKey: ['document-deep-link-project', link?.kind ?? null, link?.id ?? null],
    queryFn: () => fetchDocumentProject(link!),
    enabled: link !== null,
    staleTime: 60_000,
  });

  return {
    link,
    project: query.data,
    pending: link !== null && query.isLoading,
    failed: link !== null && query.isError,
  };
}
