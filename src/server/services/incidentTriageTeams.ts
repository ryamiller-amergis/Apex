/**
 * Posts an incident analysis to the project's Teams Workflows webhook as an Adaptive Card. The
 * card holds AI fields and links, never the incident text. A failed post is recorded and the
 * sweep retries it. The webhook URL is a secret: only status codes are logged.
 */
import type {
  IncidentTriageAnalysis,
  IncidentTriageConfidence,
  IncidentTriageIncident,
  IncidentTriageResult,
  IncidentTriageSeverity,
  IncidentTriageVerdict,
} from '../../shared/types/incidentTriage';
import { redactForTeams } from './incidentRedaction';
import {
  getAnalysisForPost,
  getLastPostedAnalysis,
  getTeamsWebhook,
  listFailedTeamsPosts,
  markTeamsFailed,
  markTeamsPosted,
  markTeamsSkipped,
  MAX_TEAMS_ATTEMPTS,
} from './incidentTriageStore';
import { decryptWebhookUrl } from './incidentTriageWebhookCrypto';

const POST_TIMEOUT_MS = 10_000;
const SUMMARY_MAX_LENGTH = 400;
const SUGGESTED_FIX_MAX_LENGTH = 300;
const AREA_MAX_LENGTH = 100;
const NUMBER_MAX_LENGTH = 40;
const DEFAULT_APEX_BASE_URL = 'https://app-scrum-dev.azurewebsites.net';

const VERDICT_LABELS: Record<IncidentTriageVerdict, string> = {
  bug: 'Bug',
  config: 'Config',
  data: 'Data',
  infra: 'Infra',
  not_a_bug: 'Not a bug',
  insufficient_evidence: 'Insufficient evidence',
};

const SEVERITY_LABELS: Record<IncidentTriageSeverity, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  critical: 'Critical',
};

const CONFIDENCE_LABELS: Record<IncidentTriageConfidence, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

export interface IncidentTriageTeamsDeps {
  fetchImpl?: typeof fetch;
}

interface TextBlock {
  type: 'TextBlock';
  text: string;
  wrap: true;
  weight?: 'Bolder';
  size?: 'Medium';
  isSubtle?: true;
}

interface FactSet {
  type: 'FactSet';
  facts: Array<{ title: string; value: string }>;
}

interface OpenUrlAction {
  type: 'Action.OpenUrl';
  title: string;
  url: string;
}

export interface IncidentTriageCardMessage {
  type: 'message';
  attachments: Array<{
    contentType: 'application/vnd.microsoft.card.adaptive';
    content: {
      type: 'AdaptiveCard';
      $schema: string;
      version: '1.4';
      body: Array<TextBlock | FactSet>;
      actions: OpenUrlAction[];
    };
  }>;
}

export interface IncidentTriageCardInput {
  incident: Pick<IncidentTriageIncident, 'id' | 'number' | 'project'>;
  analysis: { result: IncidentTriageResult };
  apexBaseUrl: string;
  serviceNowUrl: string | null;
}

export type IncidentTriagePostOutcome = 'posted' | 'skipped' | 'failed';

/** Same rule as the Teams bot notification links. */
export function resolveApexBaseUrl(): string {
  const base = process.env.AZURE_REDIRECT_URL?.replace('/auth/callback', '') || DEFAULT_APEX_BASE_URL;
  return base.replace(/\/+$/, '');
}

function cardMessage(body: Array<TextBlock | FactSet>, actions: OpenUrlAction[]): IncidentTriageCardMessage {
  return {
    type: 'message',
    attachments: [
      {
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          type: 'AdaptiveCard',
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          version: '1.4',
          body,
          actions,
        },
      },
    ],
  };
}

/** Every free-text field is cut to a fixed length, so the payload stays far below Teams' 28 KB limit. */
export function buildIncidentTriageCard(input: IncidentTriageCardInput): IncidentTriageCardMessage {
  const { incident, analysis, apexBaseUrl, serviceNowUrl } = input;
  const { result } = analysis;
  const body: Array<TextBlock | FactSet> = [
    {
      type: 'TextBlock',
      text: `Incident ${redactForTeams(incident.number, NUMBER_MAX_LENGTH)}`,
      weight: 'Bolder',
      size: 'Medium',
      wrap: true,
    },
    { type: 'TextBlock', text: redactForTeams(result.teamsSummary, SUMMARY_MAX_LENGTH), wrap: true },
    {
      type: 'FactSet',
      facts: [
        { title: 'Verdict', value: VERDICT_LABELS[result.verdict] },
        { title: 'Area', value: redactForTeams(result.area, AREA_MAX_LENGTH) },
        { title: 'Severity', value: SEVERITY_LABELS[result.severity] },
        { title: 'Confidence', value: CONFIDENCE_LABELS[result.confidence] },
      ],
    },
  ];
  if (result.verdict === 'bug' && result.suggestedFix) {
    body.push(
      { type: 'TextBlock', text: 'Suggested fix', weight: 'Bolder', wrap: true },
      { type: 'TextBlock', text: redactForTeams(result.suggestedFix, SUGGESTED_FIX_MAX_LENGTH), wrap: true },
    );
  }

  const actions: OpenUrlAction[] = [];
  if (serviceNowUrl) actions.push({ type: 'Action.OpenUrl', title: 'Open in ServiceNow', url: serviceNowUrl });
  actions.push({
    type: 'Action.OpenUrl',
    title: 'Open in Apex',
    url: `${apexBaseUrl}/incident-triage?project=${encodeURIComponent(incident.project)}&incident=${encodeURIComponent(incident.id)}`,
  });
  return cardMessage(body, actions);
}

function buildTestCard(apexBaseUrl: string): IncidentTriageCardMessage {
  return cardMessage(
    [
      { type: 'TextBlock', text: 'Apex incident triage test', weight: 'Bolder', size: 'Medium', wrap: true },
      {
        type: 'TextBlock',
        text: 'This is a test card. Apex posts incident analyses to this channel.',
        wrap: true,
      },
    ],
    [{ type: 'Action.OpenUrl', title: 'Open in Apex', url: `${apexBaseUrl}/incident-triage` }],
  );
}

/** The HTTP status, or null when the request did not complete. Never logs the URL or the response. */
async function deliver(
  webhookUrl: string,
  payload: IncidentTriageCardMessage,
  fetchImpl: typeof fetch,
): Promise<number | null> {
  try {
    const response = await fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(POST_TIMEOUT_MS),
      redirect: 'error',
    });
    void response.body?.cancel().catch(() => undefined);
    return response.status;
  } catch {
    return null;
  }
}

function isSuccess(status: number | null): boolean {
  return status !== null && status >= 200 && status < 300;
}

async function recordFailure(runId: string, status: number | null): Promise<IncidentTriagePostOutcome> {
  await markTeamsFailed(runId);
  console.warn(
    `[IncidentTriageTeams] Post for run ${runId} failed (${status === null ? 'no response' : `HTTP ${status}`})`,
  );
  return 'failed';
}

function hasAttemptsLeft(analysis: IncidentTriageAnalysis, attempts: number): boolean {
  if (analysis.teamsStatus === 'pending') return true;
  return analysis.teamsStatus === 'failed' && attempts < MAX_TEAMS_ATTEMPTS;
}

/**
 * Posts the card for a completed analysis. The first analysis of an incident posts; a later one
 * posts only when its verdict or severity differs from the last posted analysis. Returns null when
 * the row has nothing to post.
 */
export async function postIncidentTriageCard(
  analysisRunId: string,
  deps: IncidentTriageTeamsDeps = {},
): Promise<IncidentTriagePostOutcome | null> {
  const target = await getAnalysisForPost(analysisRunId);
  if (!target) return null;
  const { project, incident, analysis, teamsAttempts } = target;
  if (analysis.status !== 'completed' || !analysis.result || !hasAttemptsLeft(analysis, teamsAttempts)) return null;

  const webhook = await getTeamsWebhook(project);
  if (!webhook) {
    await markTeamsSkipped(analysisRunId);
    return 'skipped';
  }

  const lastPosted = await getLastPostedAnalysis(incident.id, analysisRunId);
  if (lastPosted && lastPosted.verdict === analysis.verdict && lastPosted.severity === analysis.severity) {
    await markTeamsSkipped(analysisRunId);
    return 'skipped';
  }

  let webhookUrl: string;
  try {
    webhookUrl = decryptWebhookUrl(project, webhook);
  } catch {
    return recordFailure(analysisRunId, null);
  }
  const payload = buildIncidentTriageCard({
    incident,
    analysis: { result: analysis.result },
    apexBaseUrl: resolveApexBaseUrl(),
    serviceNowUrl: incident.serviceNowUrl,
  });
  const status = await deliver(webhookUrl, payload, deps.fetchImpl ?? fetch);
  if (!isSuccess(status)) return recordFailure(analysisRunId, status);

  await markTeamsPosted(analysisRunId);
  return 'posted';
}

/** Retries posts of the given projects that failed and have attempts left. One failing row never stops the rest. */
export async function retryFailedIncidentTriagePosts(
  limit: number,
  projects: readonly string[],
  deps: IncidentTriageTeamsDeps = {},
): Promise<void> {
  for (const runId of await listFailedTeamsPosts(limit, projects)) {
    try {
      await postIncidentTriageCard(runId, deps);
    } catch (error) {
      console.error(
        `[IncidentTriageTeams] Retry for run ${runId} failed: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
    }
  }
}

/** Sends a sample card with no incident data. `status` is null when nothing was sent or Teams did not answer. */
export async function sendIncidentTriageTestCard(
  project: string,
  deps: IncidentTriageTeamsDeps = {},
): Promise<{ ok: boolean; status: number | null }> {
  const webhook = await getTeamsWebhook(project);
  if (!webhook) return { ok: false, status: null };
  let webhookUrl: string;
  try {
    webhookUrl = decryptWebhookUrl(project, webhook);
  } catch {
    return { ok: false, status: null };
  }
  const status = await deliver(webhookUrl, buildTestCard(resolveApexBaseUrl()), deps.fetchImpl ?? fetch);
  return { ok: isSuccess(status), status };
}
