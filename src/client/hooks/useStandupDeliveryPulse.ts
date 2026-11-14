import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  normalizeDeliveryModel,
  synthesizeTeamPulse,
} from '../../shared/utils/standupDeliveryPolicy';
import type {
  MyStandupSessionResponse,
  ParticipantPreparedBrief,
  StandupActionProposal,
  StandupActionProposalInput,
  StandupDeliveryModel,
  StandupDeliveryPolicy,
  StandupGoalSource,
  StandupRosterMember,
  StandupRosterMode,
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
    rosterMode?: StandupRosterMode;
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
      const synthesized = synthesizeTeamPulse({
        deliveryModel,
        teamGoal: raw.config?.teamGoal ?? null,
        participants: raw.participants ?? [],
        proposals: raw.proposals ?? [],
        decisionsNeeded: raw.teamPulse?.decisionsNeeded,
      });

      const teamPulse: StandupTeamPulse = raw.teamPulse
        ? {
            ...synthesized,
            ...raw.teamPulse,
            sdlcCallouts:
              raw.teamPulse.sdlcCallouts ?? synthesized.sdlcCallouts,
            areaBreakdown:
              raw.teamPulse.areaBreakdown ?? synthesized.areaBreakdown,
            individualNarratives:
              raw.teamPulse.individualNarratives ??
              synthesized.individualNarratives,
          }
        : synthesized;

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

export function useStandupRosterPreview(params: {
  project: string;
  areaPath?: string;
  rosterMode: StandupRosterMode;
  groupIds: string[];
  enabled?: boolean;
}) {
  const { project, areaPath, rosterMode, groupIds, enabled = true } = params;
  const groupKey = groupIds.join(',');

  return useQuery<{
    project: string;
    rosterMode: StandupRosterMode;
    participants: StandupRosterMember[];
  } | null>({
    queryKey: [
      'standup-roster-preview',
      project,
      areaPath ?? '',
      rosterMode,
      groupKey,
    ],
    queryFn: async () => {
      const qs = new URLSearchParams({ project, rosterMode });
      if (areaPath) qs.set('areaPath', areaPath);
      if (groupIds.length > 0) qs.set('groupIds', groupKey);
      const res = await fetch(`/api/standup/roster-preview?${qs}`, {
        credentials: 'include',
      });
      if (!res.ok) return null;
      return res.json();
    },
    enabled: Boolean(enabled && project),
    staleTime: 20_000,
  });
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
    onSuccess: () => {
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
      void qc.invalidateQueries({ queryKey: ['standup-session'] });
      void qc.invalidateQueries({ queryKey: ['my-standup-session'] });
    },
  });
}
