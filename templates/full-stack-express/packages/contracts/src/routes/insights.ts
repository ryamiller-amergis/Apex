import { z } from 'zod';
import { problemDetailsSchema } from '../conventions/problem-details.ts';
import { defineRoute } from '../define-route.ts';
import { contractSchemas } from '../schema-registry.ts';

export const insightSourceKindValues = ['database', 'connector'] as const;
export const insightSourceKindSchema = z.enum(insightSourceKindValues);

export const insightCitationSchema = z
  .strictObject({
    id: z.string().min(1).max(64),
    sourceKind: insightSourceKindSchema,
    sourceLabel: z.string().trim().min(1).max(160),
    excerpt: z.string().trim().min(1).max(400),
  })
  .register(contractSchemas, {
    id: 'InsightCitation',
    description:
      'Grounding citation referencing a database record or a third-party connector feed item.',
  });

export const insightFindingSchema = z
  .strictObject({
    id: z.string().min(1).max(64),
    title: z.string().trim().min(1).max(160),
    summary: z.string().trim().min(1).max(600),
    impact: z.enum(['high', 'medium', 'low']),
    recommendedAction: z.string().trim().min(1).max(300),
    citationIds: z.array(z.string().min(1).max(64)),
  })
  .register(contractSchemas, {
    id: 'InsightFinding',
    description: 'One structured AI skill finding with recommended action.',
  });

export const analyzeInsightsBodySchema = z
  .strictObject({
    focusArea: z.enum(['operations', 'retention', 'capacity']).optional(),
    includeConnectorFeed: z.boolean().optional(),
    connectorSource: z.string().trim().min(1).max(120).optional(),
  })
  .register(contractSchemas, {
    id: 'AnalyzeInsightsBody',
    description:
      'Parameters for invoking the grounded AI skill over database records and connector feeds.',
  });

export const insightsAnalysisSchema = z
  .strictObject({
    skillName: z.string().min(1).max(80),
    modelId: z.string().min(1).max(80),
    focusArea: z.enum(['operations', 'retention', 'capacity']),
    headline: z.string().trim().min(1).max(240),
    findings: z.array(insightFindingSchema),
    citations: z.array(insightCitationSchema),
  })
  .register(contractSchemas, {
    id: 'InsightsAnalysis',
    description:
      'Grounded analysis produced by the AI skill adapter over database and connector sources.',
  });

export type InsightSourceKind = z.infer<typeof insightSourceKindSchema>;
export type InsightCitation = z.infer<typeof insightCitationSchema>;
export type InsightFinding = z.infer<typeof insightFindingSchema>;
export type AnalyzeInsightsBody = z.infer<typeof analyzeInsightsBodySchema>;
export type InsightsAnalysis = z.infer<typeof insightsAnalysisSchema>;

const exampleAnalysis: InsightsAnalysis = {
  skillName: 'operational-briefing',
  modelId: 'composer-2.5',
  focusArea: 'operations',
  headline:
    'Fulfillment throughput rose 14% while connector telemetry flagged two regional carrier delays.',
  findings: [
    {
      id: 'finding-carrier-delay',
      title: 'Rebalance Midwest carrier dispatch window',
      summary:
        'Database order cycle logs and carrier webhook telemetry show a 35-minute pickup lag on afternoon routes.',
      impact: 'high',
      recommendedAction:
        'Shift priority Midwest dispatches to the 13:30 cutoff and notify warehouse leads.',
      citationIds: ['cit-db-orders', 'cit-conn-carrier'],
    },
  ],
  citations: [
    {
      id: 'cit-db-orders',
      sourceKind: 'database',
      sourceLabel: 'Database · Fulfillment Ledger Q1',
      excerpt:
        '42 priority batches completed with 98.4% on-time verification across primary hubs.',
    },
    {
      id: 'cit-conn-carrier',
      sourceKind: 'connector',
      sourceLabel: 'Connector · Logistics Telemetry Feed',
      excerpt:
        'Regional hub ORD-2 reported a 35-minute dock queue spike between 14:00 and 16:00.',
    },
  ],
};

export const analyzeInsights = defineRoute({
  id: 'analyzeInsights',
  method: 'post',
  path: '/api/v1/insights/analyze',
  auth: 'principal',
  summary: 'Run grounded AI skill analysis over database and connector data',
  description:
    'Invokes the structured AI skill adapter (configured with composer-2.5 by default) over database records and the third-party connector feed.',
  request: {
    body: analyzeInsightsBodySchema,
    bodyExample: {
      focusArea: 'operations',
      includeConnectorFeed: true,
      connectorSource: 'Logistics Telemetry Feed',
    },
  },
  responses: {
    200: {
      description: 'Grounded insights, citations, and recommended actions',
      body: insightsAnalysisSchema,
      example: exampleAnalysis,
    },
    503: {
      description: 'The analysis service or database is unavailable.',
      body: problemDetailsSchema,
    },
  },
});
