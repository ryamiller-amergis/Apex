import { useCallback, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useChatStream } from './useChatStream';
import type {
  WorkItemHierarchyNode,
  WorkItemAssistantSession,
  WorkItemChangeProposal,
  ApplyWorkItemChangesResponse,
} from '../../shared/types/calendarWorkItemAssistant';

// ── API helpers ───────────────────────────────────────────────────────────────

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { credentials: 'include', ...init });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return body as T;
}

// ── Context (hierarchy) ───────────────────────────────────────────────────────

export function useWorkItemHierarchy(params: {
  project: string;
  areaPath: string;
  anchorWorkItemId: number | null;
  enabled: boolean;
}) {
  const { project, areaPath, anchorWorkItemId, enabled } = params;
  return useQuery<{ nodes: WorkItemHierarchyNode[] }>({
    queryKey: ['calendar-assistant-context', project, areaPath, anchorWorkItemId],
    queryFn: () =>
      fetchJson('/api/calendar-assistant/context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project, areaPath, anchorWorkItemId }),
      }),
    enabled: enabled && !!anchorWorkItemId,
    staleTime: 60_000,
    retry: 1,
  });
}

// ── Sessions ──────────────────────────────────────────────────────────────────

export interface CreateSessionResult {
  sessionId: string;
  threadId: string;
  isNew: boolean;
  anchorWorkItemId: number;
  selectedWorkItemIds: number[];
  status: string;
}

export function useCreateSession() {
  return useMutation<
    CreateSessionResult,
    Error,
    { project: string; areaPath: string; anchorWorkItemId: number; selectedWorkItemIds: number[]; forceNew?: boolean }
  >({
    mutationFn: (payload) =>
      fetchJson('/api/calendar-assistant/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
  });
}

export function useSessionWithProposal(sessionId: string | null) {
  return useQuery<{ session: WorkItemAssistantSession; latestProposal: WorkItemChangeProposal | null }>({
    queryKey: ['calendar-assistant-session', sessionId],
    queryFn: () => fetchJson(`/api/calendar-assistant/sessions/${sessionId}`),
    enabled: !!sessionId,
    staleTime: 10_000,
    refetchInterval: (q) => {
      const proposal = q.state.data?.latestProposal;
      // Poll faster while a proposal is being generated
      return proposal?.status === 'applying' ? 2_000 : 10_000;
    },
  });
}

export function useProposal(sessionId: string | null) {
  return useQuery<{ proposal: WorkItemChangeProposal | null }>({
    queryKey: ['calendar-assistant-proposal', sessionId],
    queryFn: () => fetchJson(`/api/calendar-assistant/sessions/${sessionId}/proposals`),
    enabled: !!sessionId,
    staleTime: 5_000,
  });
}

// ── Apply / Reject ────────────────────────────────────────────────────────────

export function useApplyProposal() {
  const qc = useQueryClient();
  return useMutation<
    ApplyWorkItemChangesResponse,
    Error,
    {
      proposalId: string;
      sessionId: string;
      approvedWorkItemIds: number[];
      acknowledgeTerminalStates?: boolean;
      acknowledgeContentCleared?: boolean;
    }
  >({
    mutationFn: ({ proposalId, approvedWorkItemIds, acknowledgeTerminalStates, acknowledgeContentCleared }) =>
      fetchJson(`/api/calendar-assistant/proposals/${proposalId}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvedWorkItemIds, acknowledgeTerminalStates, acknowledgeContentCleared }),
      }),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ['calendar-assistant-session', vars.sessionId] });
      void qc.invalidateQueries({ queryKey: ['calendar-assistant-proposal', vars.sessionId] });
      // Invalidate the calendar work-items so updates appear immediately
      void qc.invalidateQueries({ queryKey: ['workItems'] });
    },
  });
}

export function useUpdateProposalField() {
  const qc = useQueryClient();
  return useMutation<
    { ok: boolean },
    Error,
    { proposalId: string; sessionId: string; workItemId: number; field: 'description' | 'acceptanceCriteria'; after: string }
  >({
    mutationFn: ({ proposalId, workItemId, field, after }) =>
      fetchJson(`/api/calendar-assistant/proposals/${proposalId}/field`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workItemId, field, after }),
      }),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ['calendar-assistant-session', vars.sessionId] });
      void qc.invalidateQueries({ queryKey: ['calendar-assistant-proposal', vars.sessionId] });
    },
  });
}

export function useRejectProposal() {
  const qc = useQueryClient();
  return useMutation<
    { ok: boolean },
    Error,
    { proposalId: string; sessionId: string; reason?: string }
  >({
    mutationFn: ({ proposalId, reason }) =>
      fetchJson(`/api/calendar-assistant/proposals/${proposalId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      }),
    onSuccess: (_data, vars) => {
      void qc.invalidateQueries({ queryKey: ['calendar-assistant-session', vars.sessionId] });
      void qc.invalidateQueries({ queryKey: ['calendar-assistant-proposal', vars.sessionId] });
    },
  });
}

// ── Chat integration ──────────────────────────────────────────────────────────

export function useCalendarAssistantChat(threadId: string | null) {
  const stream = useChatStream(threadId);

  const sendMessage = useCallback(async (text: string) => {
    if (!threadId) return;
    await fetch(`/api/chat/threads/${threadId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ text }),
    });
  }, [threadId]);

  const cancelRun = useCallback(async () => {
    if (!threadId) return;
    await fetch(`/api/chat/threads/${threadId}/cancel`, {
      method: 'POST',
      credentials: 'include',
    });
  }, [threadId]);

  return { ...stream, sendMessage, cancelRun };
}

// ── Scope selection state ─────────────────────────────────────────────────────

export function useScopeSelection(nodes: WorkItemHierarchyNode[], anchorId: number) {
  const [selected, setSelected] = useState<Set<number>>(() => new Set([anchorId]));

  const toggle = useCallback((id: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        if (id === anchorId) return prev; // anchor cannot be deselected
        next.delete(id);
      } else {
        if (next.size >= 50) return prev; // hard cap
        next.add(id);
      }
      return next;
    });
  }, [anchorId]);

  const selectAll = useCallback(() => {
    const ids = nodes.slice(0, 50).map(n => n.id);
    setSelected(new Set(ids));
  }, [nodes]);

  const clearAll = useCallback(() => {
    setSelected(new Set([anchorId]));
  }, [anchorId]);

  const selectedArray = Array.from(selected);
  const isAtLimit = selected.size >= 50;

  return { selected, selectedArray, toggle, selectAll, clearAll, isAtLimit };
}
