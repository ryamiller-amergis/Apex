import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateMcpServerRequest,
  DiscoveredMcpTool,
  McpServerConnectionPublic,
  UpdateMcpServerRequest,
} from '../../shared/types/mcpServers';

interface ConnectionListResponse {
  connections: McpServerConnectionPublic[];
}

interface ConnectionResponse {
  connection: McpServerConnectionPublic;
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

export function useMcpServers(project: string) {
  const queryClient = useQueryClient();
  const queryKey = ['mcp-servers', project] as const;

  const list = useQuery<ConnectionListResponse>({
    queryKey,
    queryFn: async () => {
      const res = await fetch(`/api/projects/${encodeURIComponent(project)}/mcp-servers`, {
        credentials: 'include',
      });
      if (!res.ok) throw new Error(await readError(res));
      return res.json() as Promise<ConnectionListResponse>;
    },
    enabled: Boolean(project),
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey });

  const create = useMutation({
    mutationFn: async (input: CreateMcpServerRequest) => {
      const res = await fetch(`/api/projects/${encodeURIComponent(project)}/mcp-servers`, {
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
    mutationFn: async ({ id, patch }: { id: string; patch: UpdateMcpServerRequest }) => {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(project)}/mcp-servers/${encodeURIComponent(id)}`,
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
        `/api/projects/${encodeURIComponent(project)}/mcp-servers/${encodeURIComponent(id)}`,
        { method: 'DELETE', credentials: 'include' },
      );
      if (!res.ok) throw new Error(await readError(res));
    },
    onSuccess: invalidate,
  });

  const ask = useMutation({
    mutationFn: async (input: { connectionId: string; question: string }) => {
      const res = await fetch(`/api/projects/${encodeURIComponent(project)}/mcp-servers/ask`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(await readError(res));
      return res.json() as Promise<AskResponse>;
    },
  });

  const discover = useMutation({
    mutationFn: async (input: { provider: string; clientId?: string; clientSecret: string }) => {
      const res = await fetch(`/api/projects/${encodeURIComponent(project)}/mcp-servers/discover-tools`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(await readError(res));
      return res.json() as Promise<{ tools: DiscoveredMcpTool[] }>;
    },
  });

  const test = useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(project)}/mcp-servers/${encodeURIComponent(id)}/test`,
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
    discoverTools: discover.mutateAsync,
    updateAccess: (id: string, patch: UpdateMcpServerRequest) => update.mutateAsync({ id, patch }),
    deleteConnection: remove.mutateAsync,
    testConnection: test.mutateAsync,
    startOAuth: async (id: string) => {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(project)}/mcp-servers/${encodeURIComponent(id)}/oauth/start`,
        { method: 'POST', credentials: 'include' },
      );
      if (!res.ok) throw new Error(await readError(res));
      const body = await res.json() as { authorizationUrl: string };
      return body.authorizationUrl;
    },
    ask: ask.mutateAsync,
    answer: ask.data?.answer ?? null,
  };
}
