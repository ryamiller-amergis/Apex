import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateIntegrationConnectionRequest,
  IntegrationConnectionPublic,
  UpdateIntegrationConnectionRequest,
} from '../../shared/types/integrations';

interface ConnectionListResponse {
  connections: IntegrationConnectionPublic[];
}

interface ConnectionResponse {
  connection: IntegrationConnectionPublic;
}

interface AskResponse {
  threadId: string;
  connectionId: string;
  operationId: string;
  answer: string;
}

async function readError(res: Response): Promise<string> {
  const body = await res.json().catch(() => ({})) as { error?: string };
  return body.error ?? `HTTP ${res.status}`;
}

export function useIntegrations(project: string) {
  const queryClient = useQueryClient();
  const queryKey = ['integrations', project] as const;

  const list = useQuery<ConnectionListResponse>({
    queryKey,
    queryFn: async () => {
      const res = await fetch(`/api/projects/${encodeURIComponent(project)}/integrations`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error(await readError(res));
      return res.json() as Promise<ConnectionListResponse>;
    },
    enabled: Boolean(project),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey });

  const create = useMutation({
    mutationFn: async (input: CreateIntegrationConnectionRequest) => {
      const res = await fetch(`/api/projects/${encodeURIComponent(project)}/integrations`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(await readError(res));
      return res.json() as Promise<ConnectionResponse>;
    },
    onSuccess: invalidate,
  });

  const update = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: UpdateIntegrationConnectionRequest }) => {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(project)}/integrations/${encodeURIComponent(id)}`,
        {
          method: 'PATCH',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        },
      );
      if (!res.ok) throw new Error(await readError(res));
      return res.json() as Promise<ConnectionResponse>;
    },
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(project)}/integrations/${encodeURIComponent(id)}`,
        { method: 'DELETE', credentials: 'include' },
      );
      if (!res.ok) throw new Error(await readError(res));
    },
    onSuccess: invalidate,
  });

  const ask = useMutation({
    mutationFn: async (input: { connectionId: string; question: string }) => {
      const res = await fetch(`/api/projects/${encodeURIComponent(project)}/integrations/ask`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(await readError(res));
      return res.json() as Promise<AskResponse>;
    },
  });

  const test = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(project)}/integrations/${encodeURIComponent(id)}/test`,
        { method: 'POST', credentials: 'include' },
      );
      if (!res.ok) throw new Error(await readError(res));
      return res.json() as Promise<ConnectionResponse>;
    },
    onSuccess: invalidate,
  });

  return {
    connections: list.data?.connections ?? [],
    isLoading: list.isLoading,
    error: list.error instanceof Error ? list.error.message : null,
    createConnection: create.mutateAsync,
    updateAccess: (id: string, patch: UpdateIntegrationConnectionRequest) => update.mutateAsync({ id, patch }),
    deleteConnection: remove.mutateAsync,
    testConnection: test.mutateAsync,
    ask: ask.mutateAsync,
    answer: ask.data?.answer ?? null,
  };
}
