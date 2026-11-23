// ── ServiceNow incident triage — shared types ─────────────────────────────────

export const INCIDENT_TRIAGE_VERDICTS = [
  'bug',
  'config',
  'data',
  'infra',
  'not_a_bug',
  'insufficient_evidence',
] as const;
export type IncidentTriageVerdict = (typeof INCIDENT_TRIAGE_VERDICTS)[number];

export const INCIDENT_TRIAGE_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type IncidentTriageSeverity = (typeof INCIDENT_TRIAGE_SEVERITIES)[number];

export const INCIDENT_TRIAGE_CONFIDENCES = ['low', 'medium', 'high'] as const;
export type IncidentTriageConfidence = (typeof INCIDENT_TRIAGE_CONFIDENCES)[number];

export type IncidentTriageAnalysisStatus = 'pending' | 'running' | 'completed' | 'failed';

export type IncidentTriageTeamsStatus = 'pending' | 'posted' | 'failed' | 'skipped';

export const INCIDENT_TRIAGE_PERMISSIONS = {
  view: 'incident-triage:view',
  run: 'incident-triage:run',
  manage: 'incident-triage:manage',
} as const;

/** The `incident-triage.json` file the document worker writes. */
export interface IncidentTriageResult {
  summary: string;
  teamsSummary: string;
  verdict: IncidentTriageVerdict;
  area: string;
  severity: IncidentTriageSeverity;
  confidence: IncidentTriageConfidence;
  verification: {
    codeEvidence: string[];
    telemetryEvidence: string[];
  };
  suggestedFix?: string;
  nextAction: string;
}

/** API view of the settings row. It never carries the raw webhook URL. */
export interface IncidentTriageSettings {
  project: string;
  enabled: boolean;
  assignmentGroupIds: string[];
  backfillDays: number;
  watermark: string | null;
  lastSweepAt: string | null;
  lastSweepError: string | null;
  teamsWebhookMasked: string | null;
}

export interface IncidentTriageSettingsUpdate {
  enabled?: boolean;
  assignmentGroupIds?: string[];
  backfillDays?: number;
  /** A new URL replaces the stored one; `null` clears it; omitted leaves it unchanged. */
  teamsWebhookUrl?: string | null;
}

export interface IncidentTriageAnalysis {
  runId: string;
  status: IncidentTriageAnalysisStatus;
  requestedBy: string | null;
  model: string | null;
  verdict: IncidentTriageVerdict | null;
  area: string | null;
  severity: IncidentTriageSeverity | null;
  result: IncidentTriageResult | null;
  failureDetail: string | null;
  teamsStatus: IncidentTriageTeamsStatus;
  requestedAt: string;
  completedAt: string | null;
}

/** One stored incident, with personal data already removed from its text. */
export interface IncidentTriageIncident {
  id: string;
  project: string;
  sysId: string;
  number: string;
  shortDescription: string | null;
  description: string | null;
  closeNotes: string | null;
  state: string | null;
  priority: string | null;
  impact: string | null;
  urgency: string | null;
  category: string | null;
  subcategory: string | null;
  assignmentGroupName: string | null;
  openedAt: string | null;
  resolvedAt: string | null;
  sysUpdatedOn: string | null;
  closeCode: string | null;
  serviceNowUrl: string | null;
  latestAnalysis: IncidentTriageAnalysis | null;
}

export interface IncidentTriageListResponse {
  incidents: IncidentTriageIncident[];
}

export interface IncidentTriageDetailResponse {
  incident: IncidentTriageIncident;
  analyses: IncidentTriageAnalysis[];
}
