import {
  analyzeInsights,
  zodIssuesToProblemErrors,
  type AnalyzeInsightsBody,
  type AnyRoute,
  type InsightCitation,
  type InsightFinding,
  type InsightsAnalysis,
} from '@project-scope/contracts';
import express, { type Router } from 'express';
import { RequestValidationError } from '../../http/problems.ts';
import { getPrincipal, type Principal } from '../../identity/index.ts';
import { mountedAt } from '../../routes/inventory.ts';
import { API_V1_PREFIX } from '../../routes/me.ts';

export const DEFAULT_INSIGHTS_MODEL_ID = 'composer-2.5';

export interface ConnectorFeedEvent {
  id: string;
  sourceLabel: string;
  excerpt: string;
}

export interface InsightsSkillAdapter {
  readonly modelId: string;
  readonly skillName: string;
  analyze(input: {
    principal: Principal;
    focusArea: 'operations' | 'retention' | 'capacity';
    includeConnectorFeed: boolean;
    connectorSource: string;
    databaseRecordsCount: number;
  }): Promise<InsightsAnalysis>;
}

export function createDeterministicInsightsSkillAdapter(options?: {
  modelId?: string;
  skillName?: string;
}): InsightsSkillAdapter {
  const modelId = options?.modelId ?? DEFAULT_INSIGHTS_MODEL_ID;
  const skillName = options?.skillName ?? 'operational-briefing';

  return {
    modelId,
    skillName,
    async analyze(input) {
      const citations: InsightCitation[] = [
        {
          id: 'cit-db-orders',
          sourceKind: 'database',
          sourceLabel: `Database · Fulfillment Ledger (${Math.max(1, input.databaseRecordsCount)} active profile records)`,
          excerpt:
            '42 priority batches completed with 98.4% on-time verification across primary hubs.',
        },
      ];

      if (input.includeConnectorFeed) {
        citations.push({
          id: 'cit-conn-carrier',
          sourceKind: 'connector',
          sourceLabel: `Connector · ${input.connectorSource}`,
          excerpt:
            'Regional hub ORD-2 reported a 35-minute dock queue spike between 14:00 and 16:00.',
        });
      }

      const citationIds = citations.map((citation) => citation.id);
      const findingsByFocus: Record<
        'operations' | 'retention' | 'capacity',
        InsightFinding[]
      > = {
        operations: [
          {
            id: 'finding-carrier-delay',
            title: 'Rebalance Midwest carrier dispatch window',
            summary:
              'Database order cycle logs and carrier webhook telemetry show a 35-minute pickup lag on afternoon routes.',
            impact: 'high',
            recommendedAction:
              'Shift priority Midwest dispatches to the 13:30 cutoff and notify warehouse leads.',
            citationIds,
          },
          {
            id: 'finding-batch-verification',
            title: 'Lock in automated pre-check for priority batches',
            summary:
              'Hubs using automated manifest verification reduced manual hold time by 22% this week.',
            impact: 'medium',
            recommendedAction:
              'Enable manifest pre-checks on all remaining regional lanes before Friday.',
            citationIds: ['cit-db-orders'],
          },
        ],
        retention: [
          {
            id: 'finding-sla-accounts',
            title: 'Proactively notify two enterprise accounts on dock lag',
            summary:
              'Accounts tied to afternoon Midwest routes experienced two consecutive SLA warnings.',
            impact: 'high',
            recommendedAction:
              'Send proactive status credits and assign priority lane routing for their next 5 shipments.',
            citationIds,
          },
        ],
        capacity: [
          {
            id: 'finding-thursday-peak',
            title: 'Allocate two overflow dock doors for Thursday peak',
            summary:
              'Forecasts combine database order volume with connector telemetry to project 94% dock utilization.',
            impact: 'medium',
            recommendedAction:
              'Open overflow bays B4 and B5 during the 13:00–17:00 window.',
            citationIds,
          },
        ],
      };

      const headlines: Record<'operations' | 'retention' | 'capacity', string> =
        {
          operations:
            'Fulfillment throughput rose 14% while connector telemetry flagged two regional carrier delays.',
          retention:
            'Enterprise SLA compliance holds at 98.4%, with two Midwest accounts needing proactive outreach.',
          capacity:
            'Regional hubs have 18% buffer capacity overall, tightening to 6% on Thursday afternoon.',
        };

      return {
        skillName,
        modelId,
        focusArea: input.focusArea,
        headline: headlines[input.focusArea],
        findings: findingsByFocus[input.focusArea],
        citations,
      };
    },
  };
}

function pathUnder(prefix: string, route: AnyRoute): string {
  if (!route.path.startsWith(`${prefix}/`)) {
    throw new Error(`${route.id} is not under ${prefix}`);
  }
  return route.path.slice(prefix.length);
}

export function createInsightsRouter(deps?: {
  adapter?: InsightsSkillAdapter;
  countDatabaseRecords?: (principal: Principal) => Promise<number>;
}): Router {
  const adapter = deps?.adapter ?? createDeterministicInsightsSkillAdapter();
  const router = mountedAt(express.Router(), API_V1_PREFIX);

  router.post(pathUnder(API_V1_PREFIX, analyzeInsights), async (req, res) => {
    const parsed = analyzeInsights.request.body.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new RequestValidationError(
        zodIssuesToProblemErrors(parsed.error.issues)
      );
    }
    const body: AnalyzeInsightsBody = parsed.data;
    const principal = getPrincipal(res);
    const dbCount = deps?.countDatabaseRecords
      ? await deps.countDatabaseRecords(principal)
      : 3;

    const analysis = await adapter.analyze({
      principal,
      focusArea: body.focusArea ?? 'operations',
      includeConnectorFeed: body.includeConnectorFeed ?? true,
      connectorSource:
        body.connectorSource?.trim() || 'Logistics Telemetry Feed',
      databaseRecordsCount: dbCount,
    });
    res.json(analyzeInsights.responses[200].body.parse(analysis));
  });

  return router;
}
