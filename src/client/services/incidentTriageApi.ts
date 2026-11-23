import type {
  IncidentTriageDetailResponse,
  IncidentTriageListResponse,
  IncidentTriageSettings,
  IncidentTriageSettingsUpdate,
  IncidentTriageVerdict,
} from '../../shared/types/incidentTriage';

export interface IncidentTriageFilters {
  verdict?: IncidentTriageVerdict;
  state?: string;
  q?: string;
}

export interface IncidentTriageSweepResult {
  fetched: number;
  upserted: number;
  newAnalyses: number;
}

export class IncidentTriageApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'IncidentTriageApiError';
  }
}

const BASE_PATH = '/api/incident-triage';

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: 'include',
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new IncidentTriageApiError(body.error ?? `Request failed: ${response.status}`, response.status);
  }
  return response.json() as Promise<T>;
}

function projectQuery(project: string, filters: IncidentTriageFilters = {}): string {
  const params = new URLSearchParams({ project });
  if (filters.verdict) params.set('verdict', filters.verdict);
  if (filters.state) params.set('state', filters.state);
  if (filters.q) params.set('q', filters.q);
  return params.toString();
}

export function listIncidents(
  project: string,
  filters: IncidentTriageFilters = {},
): Promise<IncidentTriageListResponse> {
  return apiFetch<IncidentTriageListResponse>(`${BASE_PATH}/incidents?${projectQuery(project, filters)}`);
}

export function getIncident(project: string, id: string): Promise<IncidentTriageDetailResponse> {
  return apiFetch<IncidentTriageDetailResponse>(
    `${BASE_PATH}/incidents/${encodeURIComponent(id)}?${projectQuery(project)}`,
  );
}

export function runSweep(project: string): Promise<IncidentTriageSweepResult> {
  return apiFetch<IncidentTriageSweepResult>(`${BASE_PATH}/sweep`, {
    method: 'POST',
    body: JSON.stringify({ project }),
  });
}

export function analyzeIncident(project: string, id: string): Promise<{ runId: string }> {
  return apiFetch<{ runId: string }>(`${BASE_PATH}/incidents/${encodeURIComponent(id)}/analyze`, {
    method: 'POST',
    body: JSON.stringify({ project }),
  });
}

export function sendIncidentTriageTestPost(project: string): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>(`${BASE_PATH}/settings/test-post`, {
    method: 'POST',
    body: JSON.stringify({ project }),
  });
}

export function getSettings(project: string): Promise<IncidentTriageSettings> {
  return apiFetch<IncidentTriageSettings>(`${BASE_PATH}/settings?${projectQuery(project)}`);
}

export function updateSettings(
  project: string,
  update: IncidentTriageSettingsUpdate,
): Promise<IncidentTriageSettings> {
  return apiFetch<IncidentTriageSettings>(`${BASE_PATH}/settings`, {
    method: 'PUT',
    body: JSON.stringify({ project, ...update }),
  });
}
