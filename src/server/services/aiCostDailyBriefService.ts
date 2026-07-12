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

// ── Outcome / value mapping ───────────────────────────────────────────────────

const FEATURE_OUTCOME_LABELS: Record<string, string> = {
  interview: 'feature interview sessions',
  prd: 'PRD generations',
  'design-doc': 'design documents',
  'design-prototype': 'UI prototypes',
  'my-work': 'dev work sessions',
  standup: 'standup facilitations',
  'ui-lab': 'UI Lab designs',
};

/** Estimated engineering-hours saved per workflow run (heuristics). */
const TIME_SAVINGS_HOURS: Record<string, number> = {
  interview: 2,
  prd: 8,
  'design-doc': 6,
  'design-prototype': 4,
  'my-work': 3,
  standup: 1,
  'ui-lab': 2,
};

function outcomeLabel(feature: string): string {
  return FEATURE_OUTCOME_LABELS[feature] ?? feature;
}

type WorkflowOutcomes = {
  interviews: number;
  prds: number;
  designDocs: number;
  prototypes: number;
  myWork: number;
  standups: number;
  uiLab: number;
};

function computeHoursSaved(outcomes: WorkflowOutcomes): number {
  return (
    outcomes.interviews * (TIME_SAVINGS_HOURS['interview'] ?? 0) +
    outcomes.prds * (TIME_SAVINGS_HOURS['prd'] ?? 0) +
    outcomes.designDocs * (TIME_SAVINGS_HOURS['design-doc'] ?? 0) +
    outcomes.prototypes * (TIME_SAVINGS_HOURS['design-prototype'] ?? 0) +
    outcomes.myWork * (TIME_SAVINGS_HOURS['my-work'] ?? 0) +
    outcomes.standups * (TIME_SAVINGS_HOURS['standup'] ?? 0) +
    outcomes.uiLab * (TIME_SAVINGS_HOURS['ui-lab'] ?? 0)
  );
}

function buildWorkflowSummary(outcomes: WorkflowOutcomes, totalWorkflows: number): string {
  const parts: string[] = [];
  if (outcomes.interviews > 0) parts.push(`${outcomes.interviews} interview${outcomes.interviews > 1 ? 's' : ''}`);
  if (outcomes.prds > 0) parts.push(`${outcomes.prds} PRD${outcomes.prds > 1 ? 's' : ''}`);
  if (outcomes.designDocs > 0) parts.push(`${outcomes.designDocs} design doc${outcomes.designDocs > 1 ? 's' : ''}`);
  if (outcomes.prototypes > 0) parts.push(`${outcomes.prototypes} prototype${outcomes.prototypes > 1 ? 's' : ''}`);
  if (outcomes.myWork > 0) parts.push(`${outcomes.myWork} dev session${outcomes.myWork > 1 ? 's' : ''}`);
  if (outcomes.uiLab > 0) parts.push(`${outcomes.uiLab} UI Lab design${outcomes.uiLab > 1 ? 's' : ''}`);
  if (outcomes.standups > 0) parts.push(`${outcomes.standups} standup${outcomes.standups > 1 ? 's' : ''}`);
  return parts.length > 0 ? parts.join(', ') : `${totalWorkflows} workflows`;
}

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
  outcomes: WorkflowOutcomes,
  totalWorkflows: number,
): string {
  const dateLabel = new Date(briefDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  const trendSign = forecast.trendDirection === 'up' ? '+' : forecast.trendDirection === 'down' ? '-' : '';
  const wow = priorWeekSameDay.costUsd > 0
    ? ((yesterday.costUsd - priorWeekSameDay.costUsd) / priorWeekSameDay.costUsd * 100).toFixed(1)
    : null;
  const burnRate = mtd.daysIn > 0
    ? ((mtd.costUsd / mtd.daysIn) * mtd.daysInMonth).toFixed(2)
    : null;
  const costPerWorkflow = totalWorkflows > 0 ? (yesterday.costUsd / totalWorkflows).toFixed(4) : '0';
  const hoursSaved = computeHoursSaved(outcomes);
  const costPerHour = hoursSaved > 0 ? (yesterday.costUsd / hoursSaved).toFixed(4) : null;
  const workflowSummary = buildWorkflowSummary(outcomes, totalWorkflows);

  return `You are generating a morning AI productivity brief for the "${project}" project. This is an EXECUTIVE-GRADE summary — always lead with outcomes and productivity, then softly mention investment cost. Frame AI spend as an investment, never as an expense.

## Apex Productivity — ${dateLabel}
- Workflows completed: ${totalWorkflows} total — ${workflowSummary}
- Estimated work assisted: ~${hoursSaved}h (heuristics: interview=2h, PRD=8h, design doc=6h, prototype=4h, dev session=3h, standup=1h, UI Lab=2h)
- AI invested: $${yesterday.costUsd.toFixed(4)}${costPerHour ? ` = $${costPerHour}/hr of AI-assisted work` : ''}
- Investment efficiency: $${costPerWorkflow}/workflow avg (${totalWorkflows} workflows for $${yesterday.costUsd.toFixed(4)})
${wow !== null ? `- vs same day last week: ${parseFloat(wow) >= 0 ? '+' : ''}${wow}% change in investment ($${priorWeekSameDay.costUsd.toFixed(4)} prior)` : '- No comparison data for same day last week'}

## Month-to-Date Investment
- Invested $${mtd.costUsd.toFixed(2)} over ${mtd.daysIn} days
${burnRate ? `- At current pace: est. $${burnRate} for the full month` : ''}
- Official EOM forecast: $${forecast.projectedEomUsd.toFixed(2)} (trend: ${trendSign}${Math.abs(forecast.trendPct).toFixed(1)}% ${forecast.trendDirection})

## Yesterday's Workflow Breakdown
${topFeatures.length > 0 ? topFeatures.map(f => `- ${outcomeLabel(f.feature)}: ${f.interactions} run${f.interactions !== 1 ? 's' : ''} · $${f.costUsd.toFixed(4)} invested ($${f.avgCost.toFixed(4)}/run)`).join('\n') : '- No workflow activity recorded'}

## Model Mix (yesterday)
${topModels.length > 0 ? topModels.map(m => `- ${m.model} [${m.provider}]: $${m.costUsd.toFixed(4)} (${m.pct}% of investment)`).join('\n') : '- No model data'}

Respond with ONLY this JSON (no markdown fences):
{
  "headline": "One punchy sentence — MUST open with what Apex produced (workflow count/type), end with investment cost",
  "keyBullets": [
    "Workflow productivity bullet — what was built/assisted, estimated hours of work delivered",
    "Investment efficiency bullet — cost per workflow or cost per hour, top workflow type by cost",
    "Month trajectory — MTD investment and EOM forecast, framed as budget health not expense"
  ],
  "alerts": []
}

Rules:
- headline ≤ 15 words, past tense, MUST open with workflow count or outcomes — NEVER open with a dollar amount
- keyBullets: exactly 3, ≤ 20 words each, use "invested" not "spent", frame positively
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
  outcomes: WorkflowOutcomes,
  totalWorkflows: number,
): string {
  const hourNow = new Date().getHours();
  const dateLabel = new Date(todayDate + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
  const pacePct = yesterdayFull.costUsd > 0
    ? (todaySoFar.costUsd / yesterdayFull.costUsd * 100).toFixed(0)
    : null;
  const projectedEndOfDay = hourNow > 0
    ? (todaySoFar.costUsd / hourNow * 24).toFixed(4)
    : null;
  const hoursSaved = computeHoursSaved(outcomes);
  const costPerWorkflow = totalWorkflows > 0 ? (todaySoFar.costUsd / totalWorkflows).toFixed(4) : '0';
  const workflowSummary = buildWorkflowSummary(outcomes, totalWorkflows);

  return `You are generating a 2pm AI productivity update for "${project}" — a mid-day executive check-in. Lead with what Apex has PRODUCED today, not what it cost. Frame AI spend as investment, never as expense.

## Apex Activity Today (as of ${hourNow}:00, ${dateLabel})
- Workflows completed so far: ${totalWorkflows} — ${workflowSummary}
- Estimated work assisted today: ~${hoursSaved}h
- AI invested today: $${todaySoFar.costUsd.toFixed(4)} ($${costPerWorkflow}/workflow avg)
${pacePct !== null ? `- Pace vs yesterday's full day: ${pacePct}% ($${yesterdayFull.costUsd.toFixed(4)} full day)` : ''}
${projectedEndOfDay ? `- Projected end-of-day investment: $${projectedEndOfDay} if current pace continues` : ''}

## Month Context
- MTD investment: $${mtd.costUsd.toFixed(2)} | Updated EOM projection: $${forecast.projectedEomUsd.toFixed(2)}

## Today's Active Workflows
${topFeaturesToday.length > 0 ? topFeaturesToday.map(f => `- ${outcomeLabel(f.feature)}: ${f.interactions} run${f.interactions !== 1 ? 's' : ''} · $${f.costUsd.toFixed(4)} invested`).join('\n') : '- No workflows active yet today'}

Respond with ONLY this JSON (no markdown fences):
{
  "headline": "One punchy sentence about what Apex has delivered today, with investment cost mentioned last",
  "keyBullets": [
    "Today's workflow productivity — what has been built or assisted so far, hours of work delivered",
    "Investment efficiency — cost per workflow, most active workflow type today",
    "Month trajectory — updated MTD and EOM if changed materially, framed as budget health"
  ],
  "alerts": []
}

Rules:
- headline ≤ 15 words, present tense ("has delivered", "is on track"), MUST open with workflow count or outcomes — NEVER open with a dollar amount
- keyBullets: exactly 3, ≤ 20 words each, use "invested" not "spent"
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

  // Workflow outcome counts (user-facing features only)
  const outcomes: WorkflowOutcomes = {
    interviews: dayFeatures.find(f => f.feature === 'interview')?.interactions ?? 0,
    prds: dayFeatures.find(f => f.feature === 'prd')?.interactions ?? 0,
    designDocs: dayFeatures.find(f => f.feature === 'design-doc')?.interactions ?? 0,
    prototypes: dayFeatures.find(f => f.feature === 'design-prototype')?.interactions ?? 0,
    myWork: dayFeatures.find(f => f.feature === 'my-work')?.interactions ?? 0,
    standups: dayFeatures.find(f => f.feature === 'standup')?.interactions ?? 0,
    uiLab: dayFeatures.find(f => f.feature === 'ui-lab')?.interactions ?? 0,
  };
  const totalWorkflows = Object.values(outcomes).reduce((a, b) => a + b, 0);

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
      outcomes,
      totalWorkflows,
    );
    totalCostUsd = daySummary.totalCostUsd;
    totalInteractions = totalWorkflows;
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
      outcomes,
      totalWorkflows,
    );
    totalCostUsd = daySummary.totalCostUsd;
    totalInteractions = totalWorkflows;
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
