/**
 * AI Cost Daily Brief Service
 *
 * Generates concise, executive-grade AI cost briefs at 8am and 2pm daily.
 * Powered by Bedrock Claude Sonnet. Designed for VP/CTO-level consumption.
 *
 * MORNING BRIEF (8am) — Yesterday's complete picture
 *   Like a Fitbit morning summary: what happened yesterday, how it compares
 *   to last week, burn rate, top cost drivers, model efficiency.
 *
 * AFTERNOON BRIEF (2pm) — Today so far + live projections
 *   Mid-day check-in: what's running today, updated EOM projection,
 *   any spikes vs morning baseline, actionable flags.
 */
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { db } from '../db/drizzle';
import { aiCostDailyBrief } from '../db/schema';
import { and, eq } from 'drizzle-orm';
import { getSummary, getByFeature, getByModel } from './aiCostAnalyticsService';
import { getForecast } from './aiCostForecastService';
import { recordAiUsage, computeCost } from './aiUsageService';
import type { AiCostDailyBrief } from '../../shared/types/aiCostAnalytics';

const BRIEF_MODEL = process.env.BEDROCK_INSIGHTS_MODEL_ID ?? 'us.anthropic.claude-sonnet-4-6';

function resolveRegion(): string {
  if (/^(us|eu|ap)\./.test(BRIEF_MODEL)) return 'us-east-1';
  return process.env.AWS_REGION ?? 'us-east-1';
}

const client = new BedrockRuntimeClient({ region: resolveRegion() });

async function callModel(prompt: string): Promise<{ text: string; inputTokens: number; outputTokens: number }> {
  const command = new InvokeModelCommand({
    modelId: BRIEF_MODEL,
    contentType: 'application/json',
    accept: 'application/json',
    body: JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 1200,
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

// ── Morning Brief prompt (8am — yesterday's data) ────────────────────────────

function buildMorningPrompt(
  project: string,
  briefDate: string,
  yesterday: { costUsd: number; cursorCostUsd: number; bedrockCostUsd: number; interactions: number },
  priorWeekSameDay: { costUsd: number; interactions: number },
  mtd: { costUsd: number; daysIn: number; daysInMonth: number },
  forecast: { projectedEomUsd: number; trendDirection: string; trendPct: number },
  topFeatures: Array<{ feature: string; costUsd: number; interactions: number; avgCost: number }>,
  topModels: Array<{ model: string; provider: string; costUsd: number; pct: number }>,
): string {
  const dateLabel = new Date(briefDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  const trendSign = forecast.trendDirection === 'up' ? '+' : forecast.trendDirection === 'down' ? '-' : '';
  const wow = priorWeekSameDay.costUsd > 0
    ? ((yesterday.costUsd - priorWeekSameDay.costUsd) / priorWeekSameDay.costUsd * 100).toFixed(1)
    : null;
  const burnRate = mtd.daysIn > 0
    ? ((mtd.costUsd / mtd.daysIn) * mtd.daysInMonth).toFixed(2)
    : null;
  const cursorPct = yesterday.costUsd > 0 ? (yesterday.cursorCostUsd / yesterday.costUsd * 100).toFixed(0) : '0';
  const bedrockPct = yesterday.costUsd > 0 ? (yesterday.bedrockCostUsd / yesterday.costUsd * 100).toFixed(0) : '0';
  const costPerInteraction = yesterday.interactions > 0 ? (yesterday.costUsd / yesterday.interactions).toFixed(4) : '0';

  return `You are generating a morning AI cost brief for the "${project}" project. This is a Fitbit-style daily summary — leadership opens the app and sees what yesterday looked like. Be punchy, specific, and forward-looking.

## Yesterday (${dateLabel})
- Total AI spend: $${yesterday.costUsd.toFixed(4)} | ${yesterday.interactions} interactions | $${costPerInteraction} avg/interaction
- Cursor SDK: $${yesterday.cursorCostUsd.toFixed(4)} (${cursorPct}%) | AWS Bedrock: $${yesterday.bedrockCostUsd.toFixed(4)} (${bedrockPct}%)
${wow !== null ? `- vs same day last week: ${parseFloat(wow) >= 0 ? '+' : ''}${wow}% ($${priorWeekSameDay.costUsd.toFixed(4)})` : '- No comparison data for same day last week'}

## Month-to-Date
- Spent $${mtd.costUsd.toFixed(2)} in ${mtd.daysIn} days
${burnRate ? `- At this rate: $${burnRate} projected for the full month` : ''}
- Official EOM forecast: $${forecast.projectedEomUsd.toFixed(2)} (trend: ${trendSign}${Math.abs(forecast.trendPct).toFixed(1)}% ${forecast.trendDirection})

## Yesterday's Top Features
${topFeatures.length > 0 ? topFeatures.map(f => `- ${f.feature}: $${f.costUsd.toFixed(4)} (${f.interactions} runs, $${f.avgCost.toFixed(4)}/run)`).join('\n') : '- No feature activity recorded'}

## Model Mix (yesterday)
${topModels.length > 0 ? topModels.map(m => `- ${m.model} [${m.provider}]: $${m.costUsd.toFixed(4)} (${m.pct}% of spend)`).join('\n') : '- No model data'}

Respond with ONLY this JSON (no markdown fences):
{
  "headline": "One punchy sentence — lead with the most significant number or change",
  "keyBullets": [
    "Yesterday cost bullet — actual $ with context (vs prior week if available)",
    "Efficiency or model insight — cost per interaction, most expensive workflow, or model observation",
    "Month trajectory — MTD burn rate and where we're heading"
  ],
  "alerts": []
}

Rules:
- headline ≤ 15 words, past tense, must include a dollar figure
- keyBullets: exactly 3, ≤ 20 words each, dollar amounts, past tense, no fluff
- alerts: add ONE alert only if projected EOM > $100, or yesterday > $10, or WoW increase > 40% — otherwise empty array
- Never invent numbers — only use figures provided above`;
}

// ── Afternoon Brief prompt (2pm — today so far) ───────────────────────────────

function buildAfternoonPrompt(
  project: string,
  todayDate: string,
  todaySoFar: { costUsd: number; cursorCostUsd: number; bedrockCostUsd: number; interactions: number },
  yesterdayFull: { costUsd: number; interactions: number },
  mtd: { costUsd: number },
  forecast: { projectedEomUsd: number },
  topFeaturesToday: Array<{ feature: string; costUsd: number; interactions: number }>,
): string {
  const hourNow = new Date().getHours();
  const dateLabel = new Date(todayDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  const pacePct = yesterdayFull.costUsd > 0
    ? (todaySoFar.costUsd / yesterdayFull.costUsd * 100).toFixed(0)
    : null;
  const projectedEndOfDay = hourNow > 0
    ? (todaySoFar.costUsd / hourNow * 24).toFixed(4)
    : null;

  return `You are generating a 2pm AI cost update for "${project}" — a mid-day check-in for leadership. Focus on what's happening TODAY so far.

## Today So Far (as of ${hourNow}:00, ${dateLabel})
- AI spend today: $${todaySoFar.costUsd.toFixed(4)} across ${todaySoFar.interactions} interactions
- Cursor SDK: $${todaySoFar.cursorCostUsd.toFixed(4)} | AWS Bedrock: $${todaySoFar.bedrockCostUsd.toFixed(4)}
${pacePct !== null ? `- Pace vs yesterday: ${pacePct}% of yesterday's full-day total ($${yesterdayFull.costUsd.toFixed(4)})` : ''}
${projectedEndOfDay ? `- Projected end-of-day: $${projectedEndOfDay} if current pace continues` : ''}

## Month Context
- MTD: $${mtd.costUsd.toFixed(2)} | Updated EOM projection: $${forecast.projectedEomUsd.toFixed(2)}

## Today's Active Workflows
${topFeaturesToday.length > 0 ? topFeaturesToday.map(f => `- ${f.feature}: $${f.costUsd.toFixed(4)} (${f.interactions} runs)`).join('\n') : '- No workflows active yet today'}

Respond with ONLY this JSON (no markdown fences):
{
  "headline": "One punchy sentence about today's activity level",
  "keyBullets": [
    "Today-so-far spend with pace context vs yesterday",
    "Most active workflow or noteworthy pattern today",
    "Month trajectory — updated EOM if it changed materially"
  ],
  "alerts": []
}

Rules:
- headline ≤ 15 words, present tense ("is running", "has spent"), must include a number
- keyBullets: exactly 3, ≤ 20 words each, present/today context
- alerts: only if today's pace would project to > 2x yesterday's full day — otherwise empty
- Never invent numbers`;
}

// ── Core generation function ──────────────────────────────────────────────────

export async function generateDailyBrief(
  project: string,
  briefType: 'morning' | 'afternoon' = 'morning',
): Promise<void> {
  const now = new Date();
  const today = now.toISOString().split('T')[0]!;

  // For morning: cover yesterday. For afternoon: cover today so far.
  const coverDate = briefType === 'morning'
    ? (() => { const d = new Date(now); d.setDate(d.getDate() - 1); return d.toISOString().split('T')[0]!; })()
    : today;

  const coverStart = `${coverDate}T00:00:00.000Z`;
  const coverEnd = briefType === 'morning'
    ? `${coverDate}T23:59:59.999Z`
    : now.toISOString();

  // Primary period summary
  const daySummary = await getSummary({ from: coverStart, to: coverEnd, project });

  // MTD (through cover period)
  const mtdStart = new Date(coverDate);
  mtdStart.setDate(1);
  const mtdSummary = await getSummary({ from: mtdStart.toISOString(), to: coverEnd, project });

  // Forecast
  const forecast = await getForecast(project);

  // Top features for the period
  const dayFeatures = await getByFeature({ from: coverStart, to: coverEnd, project });
  const topFeatures = dayFeatures.slice(0, 5).map(f => ({
    feature: f.feature,
    costUsd: f.costUsd,
    interactions: f.interactions,
    avgCost: f.avgCostUsd,
  }));

  let prompt: string;
  let totalCostUsd: number;
  let totalInteractions: number;

  if (briefType === 'morning') {
    // Prior week same day for WoW comparison
    const priorStart = new Date(coverDate);
    priorStart.setDate(priorStart.getDate() - 7);
    const priorDateStr = priorStart.toISOString().split('T')[0]!;
    const priorSummary = await getSummary({
      from: `${priorDateStr}T00:00:00.000Z`,
      to: `${priorDateStr}T23:59:59.999Z`,
      project,
    });

    // Top models
    const byModel = await getByModel({ from: coverStart, to: coverEnd, project });
    const totalModelCost = byModel.reduce((s, m) => s + m.costUsd, 0);
    const topModels = byModel.slice(0, 4).map(m => ({
      model: m.modelId.replace(/^us\.anthropic\./, '').replace(/-20\d{6}.*$/, ''),
      provider: m.provider,
      costUsd: m.costUsd,
      pct: totalModelCost > 0 ? Math.round(m.costUsd / totalModelCost * 100) : 0,
    }));

    const daysIn = parseInt(coverDate.split('-')[2], 10);
    const daysInMonth = new Date(
      parseInt(coverDate.split('-')[0], 10),
      parseInt(coverDate.split('-')[1], 10),
      0,
    ).getDate();

    prompt = buildMorningPrompt(
      project,
      coverDate,
      { costUsd: daySummary.totalCostUsd, cursorCostUsd: daySummary.cursorCostUsd, bedrockCostUsd: daySummary.bedrockCostUsd, interactions: daySummary.totalInteractions },
      { costUsd: priorSummary.totalCostUsd, interactions: priorSummary.totalInteractions },
      { costUsd: mtdSummary.totalCostUsd, daysIn, daysInMonth },
      { projectedEomUsd: forecast.projectedEndOfMonthUsd, trendDirection: forecast.trendDirection, trendPct: forecast.trendPct },
      topFeatures,
      topModels,
    );
    totalCostUsd = daySummary.totalCostUsd;
    totalInteractions = daySummary.totalInteractions;
  } else {
    // Afternoon — also need yesterday's full-day for pace comparison
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yStr = yesterday.toISOString().split('T')[0]!;
    const yesterdaySummary = await getSummary({
      from: `${yStr}T00:00:00.000Z`,
      to: `${yStr}T23:59:59.999Z`,
      project,
    });

    prompt = buildAfternoonPrompt(
      project,
      coverDate,
      { costUsd: daySummary.totalCostUsd, cursorCostUsd: daySummary.cursorCostUsd, bedrockCostUsd: daySummary.bedrockCostUsd, interactions: daySummary.totalInteractions },
      { costUsd: yesterdaySummary.totalCostUsd, interactions: yesterdaySummary.totalInteractions },
      { costUsd: mtdSummary.totalCostUsd },
      { projectedEomUsd: forecast.projectedEndOfMonthUsd },
      topFeatures,
    );
    totalCostUsd = daySummary.totalCostUsd;
    totalInteractions = daySummary.totalInteractions;
  }

  const { text, inputTokens, outputTokens } = await callModel(prompt);

  let parsed: { headline?: string; keyBullets?: string[]; alerts?: string[] } = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { headline: text.slice(0, 120), keyBullets: [], alerts: [] };
  }

  await db.insert(aiCostDailyBrief).values({
    project,
    briefDate: coverDate,
    briefType,
    modelUsed: BRIEF_MODEL,
    totalCostUsd: String(totalCostUsd.toFixed(8)),
    cursorCostUsd: String(daySummary.cursorCostUsd.toFixed(8)),
    bedrockCostUsd: String(daySummary.bedrockCostUsd.toFixed(8)),
    totalInteractions,
    mtdCostUsd: String(mtdSummary.totalCostUsd.toFixed(8)),
    projectedEomUsd: String(forecast.projectedEndOfMonthUsd.toFixed(8)),
    trendDirection: forecast.trendDirection,
    trendPct: String(forecast.trendPct.toFixed(4)),
    headline: parsed.headline ?? null,
    keyBullets: parsed.keyBullets ?? [],
    alerts: parsed.alerts ?? [],
    topFeatures,
  }).onConflictDoUpdate({
    target: [aiCostDailyBrief.project, aiCostDailyBrief.briefDate, aiCostDailyBrief.briefType],
    set: {
      modelUsed: BRIEF_MODEL,
      totalCostUsd: String(totalCostUsd.toFixed(8)),
      cursorCostUsd: String(daySummary.cursorCostUsd.toFixed(8)),
      bedrockCostUsd: String(daySummary.bedrockCostUsd.toFixed(8)),
      totalInteractions,
      mtdCostUsd: String(mtdSummary.totalCostUsd.toFixed(8)),
      projectedEomUsd: String(forecast.projectedEndOfMonthUsd.toFixed(8)),
      trendDirection: forecast.trendDirection,
      trendPct: String(forecast.trendPct.toFixed(4)),
      headline: parsed.headline ?? null,
      keyBullets: parsed.keyBullets ?? [],
      alerts: parsed.alerts ?? [],
      topFeatures,
      generatedAt: new Date().toISOString(),
    },
  });

  // Record cost
  const costUsd = await computeCost({ provider: 'bedrock', modelId: BRIEF_MODEL, inputTokens, outputTokens });
  recordAiUsage({
    provider: 'bedrock',
    modelId: BRIEF_MODEL,
    feature: 'ai-cost-insights',
    project,
    inputTokens,
    outputTokens,
    tokenSource: 'exact',
    costUsd,
    costSource: 'computed',
    status: 'success',
  });

  console.log(`[aiCostDailyBrief] ${briefType} brief generated for ${project} covering ${coverDate}`);
}

export async function generateBriefForAllProjects(briefType: 'morning' | 'afternoon'): Promise<void> {
  const { sql } = await import('drizzle-orm');
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);

  const rows = await db.execute<{ project: string }>(sql`
    SELECT DISTINCT project FROM ai_usage_events
    WHERE created_at >= ${cutoff.toISOString()} AND project != 'unknown'
  `);

  for (const row of rows.rows) {
    try {
      await generateDailyBrief(row.project, briefType);
    } catch (err) {
      console.error(`[aiCostDailyBrief] ${briefType} failed for ${row.project}:`, (err as Error).message);
    }
  }
}

// Keep old name for API route compatibility
export const generateDailyBriefForAllProjects = () => generateBriefForAllProjects('morning');

export async function getLatestDailyBrief(
  project: string,
  briefType?: 'morning' | 'afternoon',
): Promise<AiCostDailyBrief | null> {
  const { desc } = await import('drizzle-orm');
  const row = await db.query.aiCostDailyBrief.findFirst({
    where: briefType
      ? and(eq(aiCostDailyBrief.project, project), eq(aiCostDailyBrief.briefType, briefType))
      : eq(aiCostDailyBrief.project, project),
    orderBy: (t) => [desc(t.briefDate), desc(t.generatedAt)],
  });

  if (!row) return null;

  return {
    id: row.id,
    project: row.project,
    briefDate: row.briefDate,
    briefType: (row.briefType as 'morning' | 'afternoon') ?? 'morning',
    modelUsed: row.modelUsed,
    totalCostUsd: parseFloat(row.totalCostUsd),
    cursorCostUsd: parseFloat(row.cursorCostUsd),
    bedrockCostUsd: parseFloat(row.bedrockCostUsd),
    totalInteractions: row.totalInteractions,
    mtdCostUsd: parseFloat(row.mtdCostUsd),
    projectedEomUsd: parseFloat(row.projectedEomUsd),
    trendDirection: row.trendDirection as 'up' | 'down' | 'flat',
    trendPct: parseFloat(row.trendPct),
    headline: row.headline,
    keyBullets: (row.keyBullets as string[]) ?? [],
    alerts: (row.alerts as string[]) ?? [],
    topFeatures: (row.topFeatures as Array<{ feature: string; costUsd: number }>) ?? [],
    generatedAt: row.generatedAt,
  };
}
