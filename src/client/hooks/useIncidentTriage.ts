import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  IncidentTriageAnalysis,
  IncidentTriageDetailResponse,
  IncidentTriageListResponse,
  IncidentTriageSettings,
  IncidentTriageSettingsUpdate,
} from '../../shared/types/incidentTriage';
import {
  IncidentTriageApiError,
  analyzeIncident,
  getIncident,
  getSettings,
  listIncidents,
  runSweep,
  sendIncidentTriageTestPost,
  updateSettings,
  type IncidentTriageFilters,
  type IncidentTriageSweepResult,
} from '../services/incidentTriageApi';

export const incidentTriageKeys = {
  all: (project: string) => ['incident-triage', project] as const,
  lists: (project: string) => ['incident-triage', project, 'incidents'] as const,
  list: (project: string, filters: IncidentTriageFilters) =>
    ['incident-triage', project, 'incidents', filters] as const,
  detail: (project: string, id: string) => ['incident-triage', project, 'incident', id] as const,
  settings: (project: string) => ['incident-triage', project, 'settings'] as const,
};

const DETAIL_POLL_MS = 10_000;

export function isAnalysisInFlight(analysis: IncidentTriageAnalysis | null | undefined): boolean {
  return analysis?.status === 'pending' || analysis?.status === 'running';
}

function retryUnlessClientError(failureCount: number, error: unknown): boolean {
  if (error instanceof IncidentTriageApiError && error.status >= 400 && error.status < 500) return false;
  return failureCount < 2;
}

export function useIncidentTriageIncidents(
  project: string,
  filters: IncidentTriageFilters,
  enabled = true,
) {
  return useQuery<IncidentTriageListResponse, Error>({
    queryKey: incidentTriageKeys.list(project, filters),
    enabled: enabled && Boolean(project),
    queryFn: () => listIncidents(project, filters),
    retry: retryUnlessClientError,
  });
}

/** Polls every 10 seconds while the latest analysis is queued or running, then refreshes the list once it settles. */
export function useIncidentTriageIncident(project: string, id: string | null) {
  const client = useQueryClient();
  const wasInFlight = useRef(false);
  const query = useQuery<IncidentTriageDetailResponse, Error>({
    queryKey: incidentTriageKeys.detail(project, id ?? ''),
    enabled: Boolean(project && id),
    queryFn: () => getIncident(project, id as string),
    retry: retryUnlessClientError,
    refetchInterval: (current) =>
      isAnalysisInFlight(current.state.data?.incident.latestAnalysis) ? DETAIL_POLL_MS : false,
  });
  const inFlight = isAnalysisInFlight(query.data?.incident.latestAnalysis);

  useEffect(() => {
    if (wasInFlight.current && !inFlight) {
      void client.invalidateQueries({ queryKey: incidentTriageKeys.lists(project) });
    }
    wasInFlight.current = inFlight;
  }, [client, inFlight, project]);

  return query;
}

export function useIncidentTriageSettings(project: string, enabled = true) {
  return useQuery<IncidentTriageSettings, Error>({
    queryKey: incidentTriageKeys.settings(project),
    enabled: enabled && Boolean(project),
    queryFn: () => getSettings(project),
    retry: retryUnlessClientError,
  });
}

/** Mutation variable is the project to sweep. A sweep can add rows and analyses, so every query for the project refetches. */
export function useRunIncidentTriageSweep() {
  const client = useQueryClient();
  return useMutation<IncidentTriageSweepResult, Error, string>({
    mutationFn: (project) => runSweep(project),
    onSettled: (_data, _error, project) =>
      client.invalidateQueries({ queryKey: incidentTriageKeys.all(project) }),
  });
}

/** A 409 means a run is already going, so the refetch still runs to show it. */
export function useAnalyzeIncident() {
  const client = useQueryClient();
  return useMutation<{ runId: string }, Error, { project: string; id: string }>({
    mutationFn: ({ project, id }) => analyzeIncident(project, id),
    onSettled: (_data, _error, { project }) =>
      client.invalidateQueries({ queryKey: incidentTriageKeys.all(project) }),
  });
}

export function useUpdateIncidentTriageSettings() {
  const client = useQueryClient();
  return useMutation<
    IncidentTriageSettings,
    Error,
    { project: string; update: IncidentTriageSettingsUpdate }
  >({
    mutationFn: ({ project, update }) => updateSettings(project, update),
    onSuccess: (settings, { project }) => {
      client.setQueryData(incidentTriageKeys.settings(project), settings);
    },
  });
}

/**
 * The variable carries the raw webhook URL, so the mutation leaves the cache as soon as nothing observes it.
 * Only the masked settings in the response are cached.
 */
export function useUpdateIncidentTriageWebhook() {
  const client = useQueryClient();
  return useMutation<
    IncidentTriageSettings,
    Error,
    { project: string; teamsWebhookUrl: string | null }
  >({
    gcTime: 0,
    mutationFn: ({ project, teamsWebhookUrl }) => updateSettings(project, { teamsWebhookUrl }),
    onSuccess: (settings, { project }) => {
      client.setQueryData(incidentTriageKeys.settings(project), settings);
    },
  });
}

export function useSendIncidentTriageTestPost() {
  return useMutation<{ ok: true }, Error, string>({
    mutationFn: (project) => sendIncidentTriageTestPost(project),
  });
}
