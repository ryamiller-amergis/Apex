import { sql } from 'drizzle-orm';
import type { AiCostUndercountReport } from '../../shared/types/playbook';
import { db } from '../db/drizzle';
import { getAppEnvironment } from '../utils/superAdmin';
import { getAppSetting, setAppSetting } from './appSettingsService';
import { DEFAULT_NO_HISTORY_CAP_SETTING } from './playbookSpendPolicyService';
import { trackEvent } from './telemetry';

export const LATEST_UNDERCOUNT_REPORT_SETTING =
  'playbooks.spend.latest_undercount_report';

export interface AiCostUndercountReportDependencies {
  readMetrics(
    from: string,
    to: string
  ): Promise<{
    totalUsageEvents: number;
    estimatedZeroCostEvents: number;
    unknownProjectEvents: number;
    unknownProjectCostUsd: number;
  }>;
  getSetting(key: string): Promise<string | null>;
  saveSetting(key: string, value: string): Promise<void>;
  environment(): string;
  cursorTeamApiKeyPresent(): boolean;
  emit(report: AiCostUndercountReport): void;
  now(): Date;
}

export function createAiCostUndercountReportService(
  deps: AiCostUndercountReportDependencies
) {
  return {
    async run(): Promise<AiCostUndercountReport> {
      const now = deps.now();
      const to = now.toISOString();
      const fromDate = new Date(now);
      fromDate.setUTCDate(fromDate.getUTCDate() - 30);
      const from = fromDate.toISOString();
      const metrics = await deps.readMetrics(from, to);
      const report: AiCostUndercountReport = {
        environment: deps.environment(),
        periodFrom: from,
        periodTo: to,
        ...metrics,
        estimatedZeroCostShare:
          metrics.totalUsageEvents === 0
            ? 0
            : metrics.estimatedZeroCostEvents / metrics.totalUsageEvents,
        cursorTeamApiKeyPresent: deps.cursorTeamApiKeyPresent(),
        defaultNoHistoryCapUsd: await deps.getSetting(
          DEFAULT_NO_HISTORY_CAP_SETTING
        ),
        generatedAt: to,
      };
      await deps.saveSetting(
        LATEST_UNDERCOUNT_REPORT_SETTING,
        JSON.stringify(report)
      );
      deps.emit(report);
      return report;
    },
  };
}

export const aiCostUndercountReportService =
  createAiCostUndercountReportService({
    async readMetrics(from, to) {
      const result = await db.execute<{
        total_usage_events: string;
        estimated_zero_cost_events: string;
        unknown_project_events: string;
        unknown_project_cost_usd: string;
      }>(sql`
      SELECT
        COUNT(*) AS total_usage_events,
        COUNT(*) FILTER (
          WHERE cost_source = 'estimated' AND cost_usd::numeric = 0
        ) AS estimated_zero_cost_events,
        COUNT(*) FILTER (WHERE project = 'unknown') AS unknown_project_events,
        COALESCE(SUM(cost_usd::numeric) FILTER (WHERE project = 'unknown'), 0)
          AS unknown_project_cost_usd
      FROM ai_usage_events
      WHERE created_at >= ${from} AND created_at <= ${to}
    `);
      const row = result.rows[0];
      return {
        totalUsageEvents: Number(row?.total_usage_events ?? 0),
        estimatedZeroCostEvents: Number(row?.estimated_zero_cost_events ?? 0),
        unknownProjectEvents: Number(row?.unknown_project_events ?? 0),
        unknownProjectCostUsd: Number(row?.unknown_project_cost_usd ?? 0),
      };
    },
    getSetting: getAppSetting,
    saveSetting: (key, value) => setAppSetting(key, value),
    environment: getAppEnvironment,
    cursorTeamApiKeyPresent: () => Boolean(process.env.CURSOR_TEAM_API_KEY),
    emit(report) {
      trackEvent(
        'playbook_spend.undercount_report',
        {
          environment: report.environment,
          cursorTeamApiKeyPresent: String(report.cursorTeamApiKeyPresent),
        },
        {
          estimatedZeroCostShare: report.estimatedZeroCostShare,
          unknownProjectEvents: report.unknownProjectEvents,
          unknownProjectCostUsd: report.unknownProjectCostUsd,
        }
      );
    },
    now: () => new Date(),
  });
