import { useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkItem } from '../types/workitem';
import {
  evaluateCalendarItemHealth,
  normalizeDeliveryModel,
  normalizeGoalSource,
  resolveStandupPolicy,
  synthesizeTeamPulse,
} from '../../shared/utils/standupDeliveryPolicy';
import type {
  CalendarDeliveryPulseResponse,
  MyStandupSessionResponse,
  ParticipantPreparedBrief,
  StandupActionProposal,
  StandupActionProposalInput,
  StandupDeliveryModel,
  StandupDeliveryPolicy,
  StandupGoalSource,
  StandupStructuredUpdate,
  StandupTeamPulse,
} from '../../shared/types/standup';

export interface StandupSessionDetail {
  id: string;
  sessionDate: string;
  status: string;
  summaryMarkdown: string | null;
  teamPulse?: StandupTeamPulse | null;
  config: {
    id?: string;
    project: string;
    areaPath: string | null;
    deliveryModel?: StandupDeliveryModel;
    goalSource?: StandupGoalSource;
    teamGoal?: string | null;
    policy?: StandupDeliveryPolicy;
  };
  participants: Array<{
    id: string;
    userId: string;
    displayName?: string | null;
    status: string;
    structuredUpdate: StandupStructuredUpdate | null;
    preparedBrief?: ParticipantPreparedBrief | null;
    submittedAt: string | null;
  }>;
  followups: Array<{
    id: string;
    title: string;
    description: string | null;
    status: string;
    participantUserIds: string[];
  }>;
  proposals?: StandupActionProposal[];
}

export interface StandupSessionSummaryItem {
  id: string;
  sessionDate: string;
  status: string;
  config?: {
    project: string;
    deliveryModel?: StandupDeliveryModel;
    teamGoal?: string | null;
  };
}

async function fetchJsonOrNull<T>(url: string): Promise<T | null> {
  const res = await fetch(url, { credentials: 'include' });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      (body as { error?: string }).error ?? `Request failed: ${res.status}`,
    );
  }
  const data = (await res.json()) as T | null;
  return data ?? null;
}

export function useMyStandupSession(project?: string | null) {
  const url = project
    ? `/api/standup/my-session?project=${encodeURIComponent(project)}`
    : '/api/standup/my-session';

  return useQuery<MyStandupSessionResponse | null>({
    queryKey: ['my-standup-session', project ?? ''],
    queryFn: () => fetchJsonOrNull<MyStandupSessionResponse>(url),
    staleTime: 10_000,
  });
}

export function useRefreshParticipantBrief() {
  const qc = useQueryClient();
  return useMutation<
    { ok: boolean; preparedBrief: ParticipantPreparedBrief },
    Error,
    { participantId: string }
  >({
    mutationFn: async ({ participantId }) => {
      const res = await fetch(
        `/api/standup/participants/${encodeURIComponent(participantId)}/refresh-brief`,
        { method: 'POST', credentials: 'include' },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? 'Failed to refresh brief',
        );
      }
      return res.json();
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['my-standup-session'] });
    },
  });
}

export function useSubmitStandupParticipant() {
  const qc = useQueryClient();
  return useMutation<
    { ok: boolean },
    Error,
    {
      participantId: string;
      structuredUpdate?: StandupStructuredUpdate;
      proposals?: StandupActionProposalInput[];
    }
  >({
    mutationFn: async ({ participantId, structuredUpdate, proposals }) => {
      const hasBody =
        structuredUpdate !== undefined ||
        (Array.isArray(proposals) && proposals.length > 0);
      const res = await fetch(
        `/api/standup/participants/${encodeURIComponent(participantId)}/submit`,
        {
          method: 'POST',
          credentials: 'include',
          ...(hasBody
            ? {
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ structuredUpdate, proposals }),
              }
            : {}),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? 'Failed to submit standup',
        );
      }
      return res.json();
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['my-standup-session'] });
      void qc.invalidateQueries({ queryKey: ['standup-session'] });
      void qc.invalidateQueries({ queryKey: ['standup-sessions'] });
      void qc.invalidateQueries({ queryKey: ['standup-delivery-pulse'] });
    },
  });
}

export function useStandupSessionDetail(
  sessionId: string | null,
  project?: string | null,
) {
  return useQuery<StandupSessionDetail | null>({
    queryKey: ['standup-session', sessionId ?? 'latest', project ?? ''],
    queryFn: async () => {
      const url = sessionId
        ? `/api/standup/sessions/${encodeURIComponent(sessionId)}`
        : `/api/standup/sessions/latest${
            project ? `?project=${encodeURIComponent(project)}` : ''
          }`;
      const raw = await fetchJsonOrNull<StandupSessionDetail>(url);
      if (!raw) return null;

      const deliveryModel = normalizeDeliveryModel(raw.config?.deliveryModel);
      const teamPulse =
        raw.teamPulse ??
        synthesizeTeamPulse({
          deliveryModel,
          teamGoal: raw.config?.teamGoal ?? null,
          participants: raw.participants ?? [],
          proposals: raw.proposals ?? [],
        });

      return {
        ...raw,
        teamPulse,
        proposals: raw.proposals ?? [],
      };
    },
    staleTime: 10_000,
  });
}

export function useStandupSessionsList(project?: string | null) {
  return useQuery<StandupSessionSummaryItem[]>({
    queryKey: ['standup-sessions', project ?? ''],
    queryFn: async () => {
      const url = project
        ? `/api/standup/sessions?project=${encodeURIComponent(project)}`
        : '/api/standup/sessions';
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) return [];
      const rows = (await res.json()) as StandupSessionSummaryItem[];
      return Array.isArray(rows) ? rows : [];
    },
    staleTime: 15_000,
  });
}

export function useCalendarDeliveryPulse(
  project: string | null | undefined,
  workItems: WorkItem[],
) {
  const serverQuery = useQuery<CalendarDeliveryPulseResponse | null>({
    queryKey: ['standup-delivery-pulse', project ?? ''],
    queryFn: () =>
      project
        ? fetchJsonOrNull<CalendarDeliveryPulseResponse>(
            `/api/standup/delivery-pulse?project=${encodeURIComponent(project)}`,
          )
        : Promise.resolve(null),
    enabled: Boolean(project),
    staleTime: 15_000,
    retry: 1,
  });

  const pulse = useMemo<CalendarDeliveryPulseResponse>(() => {
    const base = serverQuery.data;
    const deliveryModel = normalizeDeliveryModel(base?.deliveryModel);
    const goalSource = normalizeGoalSource(base?.goalSource);
    const policy = resolveStandupPolicy(deliveryModel, {
      enableTargetDateChecks: base?.enableTargetDateChecks,
      staleDaysThreshold: base?.staleDaysThreshold,
      wipLimitPerPerson: base?.wipLimitPerPerson,
      slaHoursHighPriority: base?.slaHoursHighPriority,
    });
    const proposals = base?.proposals ?? [];
    const teamPulse = base?.teamPulse ?? null;

    const evaluated = evaluateCalendarItemHealth(workItems, {
      deliveryModel,
      policy,
      teamPulse,
      proposals,
    });

    return {
      project: project ?? '',
      deliveryModel,
      teamGoal: base?.teamGoal ?? null,
      goalSource,
      enableTargetDateChecks: policy.enableTargetDateChecks,
      staleDaysThreshold: policy.staleDaysThreshold,
      wipLimitPerPerson: policy.wipLimitPerPerson,
      slaHoursHighPriority: policy.slaHoursHighPriority,
      latestSessionId: base?.latestSessionId ?? null,
      latestSessionDate: base?.latestSessionDate ?? null,
      overallHealth: evaluated.overallHealth,
      counts: evaluated.counts,
      itemHealthById: evaluated.itemHealthById,
      proposals,
      teamPulse,
    };
  }, [project, serverQuery.data, workItems]);

  return {
    pulse,
    isLoading: serverQuery.isLoading,
    error: serverQuery.error,
    refetch: serverQuery.refetch,
  };
}

export function useApplyStandupProposal() {
  const qc = useQueryClient();
  return useMutation<
    { ok: boolean; proposal: StandupActionProposal },
    Error,
    { proposal: StandupActionProposal }
  >({
    mutationFn: async ({ proposal }) => {
      const res = await fetch(
        `/api/standup/proposals/${encodeURIComponent(proposal.id)}/apply`,
        {
          method: 'POST',
          credentials: 'include',
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? 'Failed to apply proposal',
        );
      }
      return res.json();
    },
    onSuccess: ({ proposal }) => {
      // Optimistically update loaded workItems caches so stubbed and live views stay in sync
      qc.setQueriesData<WorkItem[]>({ queryKey: ['workItems'] }, (existing) => {
        if (!Array.isArray(existing)) return existing;
        return existing.map((item) => {
          if (item.id !== proposal.workItemId) return item;
          if (proposal.proposalType === 'target_date') {
            if (proposal.fieldName === 'targetDate') {
              return { ...item, targetDate: proposal.proposedValue };
            }
            return { ...item, dueDate: proposal.proposedValue };
          }
          if (proposal.proposalType === 'state') {
            return { ...item, state: proposal.proposedValue };
          }
          if (proposal.proposalType === 'assigned_to') {
            return { ...item, assignedTo: proposal.proposedValue };
          }
          return item;
        });
      });

      void qc.invalidateQueries({ queryKey: ['standup-delivery-pulse'] });
      void qc.invalidateQueries({ queryKey: ['standup-session'] });
      void qc.invalidateQueries({ queryKey: ['my-standup-session'] });
      void qc.invalidateQueries({ queryKey: ['workItems'] });
    },
  });
}

export function useDismissStandupProposal() {
  const qc = useQueryClient();
  return useMutation<
    { ok: boolean; proposal: StandupActionProposal },
    Error,
    { proposalId: string }
  >({
    mutationFn: async ({ proposalId }) => {
      const res = await fetch(
        `/api/standup/proposals/${encodeURIComponent(proposalId)}/dismiss`,
        {
          method: 'POST',
          credentials: 'include',
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { error?: string }).error ?? 'Failed to dismiss proposal',
        );
      }
      return res.json();
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['standup-delivery-pulse'] });
      void qc.invalidateQueries({ queryKey: ['standup-session'] });
      void qc.invalidateQueries({ queryKey: ['my-standup-session'] });
    },
  });
}
