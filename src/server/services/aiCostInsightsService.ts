/**
 * AI Cost Insights Service
 *
 * Uses Bedrock Claude Sonnet to generate narrative analysis of cost data.
 * Insights are:
 *  - Generated daily per project via the scheduler
 *  - Cached in ai_cost_insights table
 *  - Never block the UI (UI reads from cache)
 *  - Each generation is itself recorded via recordAiUsage()
 */
import { db } from '../db/drizzle';
import { aiCostInsights } from '../db/schema';
import { and, eq } from 'drizzle-orm';
import { getSummary, getByFeature, getByModel } from './aiCostAnalyticsService';
import { getForecast } from './aiCostForecastService';
import { recordAiUsage, computeCost } from './aiUsageService';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

const INSIGHTS_MODEL = process.env.BEDROCK_INSIGHTS_MODEL_ID ?? 'us.anthropic.claude-sonnet-4-6';

function resolveInsightsRegion(): string {
  // Cross-region inference profiles (us.* prefix) must be invoked via us-east-1
  if (/^(us|eu|ap)\./.test(INSIGHTS_MODEL)) return 'us-east-1';
  return process.env.AWS_REGION ?? 'us-east-1';
}

const client = new BedrockRuntimeClient({ region: resolveInsightsRegion() });

async function callInsightsModel(prompt: string): Promise<{
  text: string;
  inputTokens: number;
  outputTokens: number;
}> {
  const command = new InvokeModelCommand({
    modelId: INSIGHTS_MODEL,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const response = await client.send(command);
  const body = JSON.parse(new TextDecoder().decode(response.body)) as {
    content: Array<{ type: string; text: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  return {
    text: body.content[0]?.text ?? '',
    inputTokens: body.usage?.input_tokens ?? 0,
    outputTokens: body.usage?.output_tokens ?? 0,
  };
}

function buildInsightsPrompt(
  project: string,
  summary: Awaited<ReturnType<typeof getSummary>>,
  byFeature: Awaited<ReturnType<typeof getByFeature>>,
  byModel: Awaited<ReturnType<typeof getByModel>>,
  forecast: Awaited<ReturnType<typeof getForecast>>,
): string {
  return `You are analyzing AI model usage costs for the "${project}" project. Based on the following data, provide structured insights.

## Current Period Summary (${summary.periodFrom} to ${summary.periodTo})
- Total spend: $${summary.totalCostUsd.toFixed(4)}
- Cursor SDK spend: $${summary.cursorCostUsd.toFixed(4)}
- Bedrock (AWS) spend: $${summary.bedrockCostUsd.toFixed(4)}
- Total AI interactions: ${summary.totalInteractions}

## Spend by Feature
${byFeature.map(f => `- ${f.feature}: $${f.costUsd.toFixed(4)} (${f.interactions} interactions, avg $${f.avgCostUsd.toFixed(4)}/interaction)`).join('\n')}

## Spend by Model
${byModel.map(m => `- ${m.modelId} (${m.provider}): $${m.costUsd.toFixed(4)} (${m.interactions} interactions)`).join('\n')}

## Cost Forecast
- Projected end-of-month: $${forecast.projectedEndOfMonthUsd.toFixed(4)}
- 7-day projected: $${forecast.projectedNext7dUsd.toFixed(4)}
- Trend: ${forecast.trendDirection} (${forecast.trendPct.toFixed(1)}%)

Provide a JSON response with this exact structure (no markdown fences):
{
  "headline": "One-sentence summary of the most important finding",
  "insights": [
    "Specific observation about cost drivers (mention dollar amounts)",
    "Pattern or trend in usage across features or models",
    "Efficiency observation (cost per interaction, cache usage, etc.)"
  ],
  "recommendations": [
    "Actionable step to reduce or optimize costs",
    "Model selection recommendation if applicable"
  ],
  "riskFlags": [
    "Any cost anomaly, spike, or projected overrun that needs attention"
  ]
}

Rules:
- Reference the actual dollar figures provided — never invent numbers
- Be concise and specific
- insights array: 2-4 items
- recommendations array: 1-3 items
- riskFlags array: 0-2 items (empty array if no flags)`;
}

export async function generateInsightsForProject(project: string): Promise<void> {
  const to = new Date().toISOString().split('T')[0]!;
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - 30);
  const from = fromDate.toISOString().split('T')[0]!;

  const [summary, byFeature, byModel, forecast] = await Promise.all([
    getSummary({ from, to, project }),
    getByFeature({ from, to, project }),
    getByModel({ from, to, project }),
    getForecast(project),
  ]);

  if (summary.totalInteractions === 0) {
    console.log(`[aiCostInsights] No interactions for ${project} in last 30 days, skipping`);
    return;
  }

  const prompt = buildInsightsPrompt(project, summary, byFeature, byModel, forecast);
  const { text, inputTokens, outputTokens } = await callInsightsModel(prompt);

  let parsed: {
    headline?: string;
    insights?: string[];
    recommendations?: string[];
    riskFlags?: string[];
  } = {};

  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { headline: text.slice(0, 200), insights: [], recommendations: [], riskFlags: [] };
  }

  await db.insert(aiCostInsights).values({
    project,
    periodFrom: from,
    periodTo: to,
    modelUsed: INSIGHTS_MODEL,
    headline: parsed.headline ?? null,
    insights: parsed.insights ?? [],
    recommendations: parsed.recommendations ?? [],
    riskFlags: parsed.riskFlags ?? [],
  }).onConflictDoUpdate({
    target: [aiCostInsights.project, aiCostInsights.periodFrom, aiCostInsights.periodTo],
    set: {
      modelUsed: INSIGHTS_MODEL,
      headline: parsed.headline ?? null,
      insights: parsed.insights ?? [],
      recommendations: parsed.recommendations ?? [],
      riskFlags: parsed.riskFlags ?? [],
      generatedAt: new Date().toISOString(),
    },
  });

  // Record own cost
  const costUsd = await computeCost({ provider: 'bedrock', modelId: INSIGHTS_MODEL, inputTokens, outputTokens });
  recordAiUsage({
    provider: 'bedrock',
    modelId: INSIGHTS_MODEL,
    feature: 'ai-cost-insights',
    project,
    inputTokens,
    outputTokens,
    tokenSource: 'exact',
    costUsd,
    costSource: 'computed',
    status: 'success',
  });
}

// Scheduler-safe wrapper — catches and logs errors without crashing
export async function generateInsightsForProjectSafe(project: string): Promise<void> {
  try {
    await generateInsightsForProject(project);
  } catch (err) {
    console.error(`[aiCostInsights] Failed for ${project}:`, (err as Error).message);
  }
}

export async function generateInsightsForAllProjects(): Promise<void> {
  // Find all distinct projects with recent usage
  const { db: drizzleDb } = await import('../db/drizzle');
  const { aiUsageEvents: events } = await import('../db/schema');
  const { sql } = await import('drizzle-orm');

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);

  const rows = await drizzleDb.execute<{ project: string }>(sql`
    SELECT DISTINCT project FROM ai_usage_events WHERE created_at >= ${cutoff.toISOString()}
  `);

  for (const row of rows.rows) {
    if (row.project && row.project !== 'unknown') {
      await generateInsightsForProjectSafe(row.project);
    }
  }
}
