import { DefaultAzureCredential } from '@azure/identity';
import {
  GROUNDING_ROLLOUT_STAGE_CALLERS,
  GROUNDING_ROLLOUT_STAGES,
  type GroundingMetricSample,
  type GroundingRolloutStage,
} from '../../shared/types/groundingOperations';

const APP_INSIGHTS_SCOPE = 'https://api.applicationinsights.io/.default';
const APP_INSIGHTS_QUERY_ENDPOINT =
  'https://api.applicationinsights.io/v1/apps';

interface LogsQueryColumn {
  name: string;
}

interface LogsQueryResponse {
  tables?: Array<{
    columns?: LogsQueryColumn[];
    rows?: unknown[][];
  }>;
}

export interface ApplicationInsightsGroundingMetricsOptions {
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  getAccessToken?: () => Promise<string | null>;
}

function connectionStringValue(
  connectionString: string | undefined,
  keys: string[]
): string | null {
  if (!connectionString) return null;
  const accepted = new Set(keys.map((key) => key.toLowerCase()));
  for (const segment of connectionString.split(';')) {
    const separator = segment.indexOf('=');
    if (separator < 1) continue;
    const key = segment.slice(0, separator).trim().toLowerCase();
    if (!accepted.has(key)) continue;
    const value = segment.slice(separator + 1).trim();
    if (value) return value;
  }
  return null;
}

export function resolveApplicationInsightsApplicationId(
  environment: NodeJS.ProcessEnv = process.env
): string | null {
  return (
    environment.APPLICATIONINSIGHTS_APPLICATION_ID?.trim() ||
    environment.APPINSIGHTS_APPLICATION_ID?.trim() ||
    connectionStringValue(environment.APPLICATIONINSIGHTS_CONNECTION_STRING, [
      'ApplicationId',
      'AppId',
    ])
  );
}

function numeric(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseSample(payload: LogsQueryResponse): GroundingMetricSample | null {
  const table = payload.tables?.[0];
  const columns = table?.columns?.map((column) => column.name);
  const values = table?.rows?.[0];
  if (!columns || !values) return null;
  const row = Object.fromEntries(
    columns.map((column, index) => [column, values[index]])
  );
  return {
    sampleSize: numeric(row, 'sampleSize') ?? 0,
    fallbackRate: numeric(row, 'fallbackRate'),
    warmMaterializationP95Ms: numeric(row, 'warmMaterializationP95Ms'),
    coldMaterializationP95Ms: numeric(row, 'coldMaterializationP95Ms'),
    mirrorHitRate: numeric(row, 'mirrorHitRate'),
    groundingFailureCount: numeric(row, 'groundingFailureCount'),
  };
}

function escapeKustoString(value: string): string {
  return value.replace(/'/g, "''");
}

function buildQuery(
  cohort: string,
  lookbackHours: number,
  project?: string
): string {
  const callers = GROUNDING_ROLLOUT_STAGES.includes(
    cohort as GroundingRolloutStage
  )
    ? GROUNDING_ROLLOUT_STAGE_CALLERS[cohort as GroundingRolloutStage]
    : [cohort];
  const callerList = callers
    .map((caller) => `'${escapeKustoString(caller)}'`)
    .join(', ');
  return [
    `customEvents`,
    `| where timestamp >= ago(${lookbackHours}h)`,
    `| where tostring(customDimensions.caller) in (${callerList})`,
    ...(project
      ? [
          `| where tostring(customDimensions.project) == '${escapeKustoString(project)}'`,
        ]
      : []),
    `| where name startswith 'grounding.'`,
    `| summarize`,
    `    sampleSize=dcountif(tostring(customDimensions.runId), name in ('grounding.materialize', 'grounding.fallback', 'grounding.failure') and isnotempty(tostring(customDimensions.runId))),`,
    `    fallbackCount=countif(name == 'grounding.fallback'),`,
    `    warmMaterializationP95Ms=percentileif(todouble(customMeasurements.durationMs), 95, name == 'grounding.materialize' and tostring(customDimensions.mode) == 'warm'),`,
    `    coldMaterializationP95Ms=percentileif(todouble(customMeasurements.durationMs), 95, name == 'grounding.materialize' and tostring(customDimensions.mode) == 'cold'),`,
    `    mirrorHitRate=avgif(todouble(customMeasurements.hit), name == 'grounding.mirror'),`,
    `    groundingFailureCount=countif(name == 'grounding.failure')`,
    `| extend fallbackRate=iff(sampleSize == 0, real(null), todouble(fallbackCount) / todouble(sampleSize))`,
    `| project sampleSize, fallbackRate, warmMaterializationP95Ms, coldMaterializationP95Ms, mirrorHitRate, groundingFailureCount`,
  ].join('\n');
}

export function createApplicationInsightsGroundingMetricsSource(
  options: ApplicationInsightsGroundingMetricsOptions = {}
): {
  loadSample(
    cohort: string,
    project?: string
  ): Promise<GroundingMetricSample | null>;
} {
  const environment = options.environment ?? process.env;
  const request = options.fetch ?? fetch;
  const getAccessToken =
    options.getAccessToken ??
    (async () => {
      const token = await new DefaultAzureCredential().getToken(
        APP_INSIGHTS_SCOPE
      );
      return token?.token ?? null;
    });

  return {
    async loadSample(cohort, project) {
      const applicationId =
        resolveApplicationInsightsApplicationId(environment);
      if (!applicationId) return null;

      const configuredLookback = Number(
        environment.GROUNDING_GATE_SAMPLE_LOOKBACK_HOURS
      );
      const lookbackHours =
        Number.isFinite(configuredLookback) && configuredLookback > 0
          ? Math.floor(configuredLookback)
          : 168;

      try {
        const accessToken = await getAccessToken();
        if (!accessToken) return null;
        const response = await request(
          `${APP_INSIGHTS_QUERY_ENDPOINT}/${encodeURIComponent(applicationId)}/query`,
          {
            method: 'POST',
            headers: {
              authorization: `Bearer ${accessToken}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              query: buildQuery(cohort, lookbackHours, project),
            }),
          }
        );
        if (!response.ok) return null;
        return parseSample((await response.json()) as LogsQueryResponse);
      } catch {
        return null;
      }
    },
  };
}

export const applicationInsightsGroundingMetrics =
  createApplicationInsightsGroundingMetricsSource();
