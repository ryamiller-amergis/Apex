import type {
  IncidentTriageAnalysisStatus,
  IncidentTriageConfidence,
  IncidentTriageSeverity,
  IncidentTriageTeamsStatus,
  IncidentTriageVerdict,
} from '../../shared/types/incidentTriage';

export const INCIDENT_VERDICT_LABELS: Record<IncidentTriageVerdict, string> = {
  bug: 'Bug',
  config: 'Config',
  data: 'Data',
  infra: 'Infra',
  not_a_bug: 'Not a bug',
  insufficient_evidence: 'Insufficient evidence',
};

export const INCIDENT_SEVERITY_LABELS: Record<IncidentTriageSeverity, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

export const INCIDENT_CONFIDENCE_LABELS: Record<IncidentTriageConfidence, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

export const INCIDENT_ANALYSIS_STATUS_LABELS: Record<IncidentTriageAnalysisStatus, string> = {
  pending: 'Queued',
  running: 'Analyzing',
  completed: 'Completed',
  failed: 'Failed',
};

export const INCIDENT_TEAMS_STATUS_LABELS: Record<IncidentTriageTeamsStatus, string> = {
  pending: 'Pending',
  posted: 'Posted',
  failed: 'Failed',
  skipped: 'Skipped',
};

export type IncidentBadgeTone = 'neutral' | 'danger' | 'ok';

export function incidentVerdictTone(verdict: IncidentTriageVerdict): IncidentBadgeTone {
  if (verdict === 'bug') return 'danger';
  return verdict === 'not_a_bug' ? 'ok' : 'neutral';
}

export function incidentSeverityTone(severity: IncidentTriageSeverity): IncidentBadgeTone {
  return severity === 'critical' || severity === 'high' ? 'danger' : 'neutral';
}

const EMPTY_VALUE = '—';

export function formatIncidentTime(value: string | null | undefined): string {
  if (!value) return EMPTY_VALUE;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? EMPTY_VALUE : date.toLocaleString();
}

export function incidentText(value: string | null | undefined): string {
  return value && value.trim() ? value : EMPTY_VALUE;
}
