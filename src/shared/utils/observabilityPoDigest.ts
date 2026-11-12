/**
 * Shared Product Owner Observability Digest synthesis & multi-window trend calculations.
 * Used by the backend service/scheduler and as a safe initial/fallback projection.
 */
import { isEffortLevel, type EffortLevel } from '../types/effort';
import {
  OBSERVABILITY_PO_DEFAULT_EFFORT,
  OBSERVABILITY_PO_DEFAULT_MODEL,
  OBSERVABILITY_PO_SCHEDULE_HOURS,
  OBSERVABILITY_PO_SKILL_PATH,
  OBSERVABILITY_TREND_WINDOWS,
  OBSERVABILITY_TREND_WINDOW_LABELS,
  type ObservabilityAdoptionSummary,
  type ObservabilityDigestSlot,
  type ObservabilityDropReasonsSummary,
  type ObservabilityExceptionItem,
  type ObservabilityModuleRetentionDropItem,
  type ObservabilityPoDigestResponse,
  type ObservabilityPoDigestSnapshot,
  type ObservabilityScheduleSummary,
  type ObservabilityTopModuleItem,
  type ObservabilityTopUserItem,
  type ObservabilityTrendDirection,
  type ObservabilityTrendWindow,
  type ObservabilityWindowComparisonMap,
} from '../types/observability';
import { effortLabel } from './effort';

const WINDOW_MULTIPLIER: Record<ObservabilityTrendWindow, number> = {
  today: 1,
  '1d': 1.35,
  '7d': 5.8,
  '14d': 11.2,
  '30d': 22.5,
  '60d': 42.0,
};

export const WINDOW_BASELINE_LABELS: Record<ObservabilityTrendWindow, string> = {
  today: 'vs yesterday same window',
  '1d': 'vs prior 24 hours',
  '7d': 'vs prior 7 days',
  '14d': 'vs prior 14 days',
  '30d': 'vs prior 30 days',
  '60d': 'vs prior 60 days',
};

const WINDOW_DELTA_SHIFT: Record<ObservabilityTrendWindow, number> = {
  today: 0,
  '1d': 1.2,
  '7d': 3.5,
  '14d': 5.1,
  '30d': 7.8,
  '60d': 10.4,
};

export function isObservabilityTrendWindow(value: unknown): value is ObservabilityTrendWindow {
  return (
    typeof value === 'string' &&
    (OBSERVABILITY_TREND_WINDOWS as readonly string[]).includes(value)
  );
}

export function normalizeObservabilityModel(model?: string | null): string {
  const trimmed = typeof model === 'string' ? model.trim() : '';
  return trimmed.length > 0 ? trimmed : OBSERVABILITY_PO_DEFAULT_MODEL;
}

export function normalizeObservabilityEffort(effort?: unknown): EffortLevel {
  return isEffortLevel(effort) ? effort : OBSERVABILITY_PO_DEFAULT_EFFORT;
}

function scaleCount(base: number, window: ObservabilityTrendWindow): number {
  return Math.max(1, Math.round(base * WINDOW_MULTIPLIER[window]));
}

function buildWindowComparison(base: number): ObservabilityWindowComparisonMap {
  return {
    today: scaleCount(base, 'today'),
    '1d': scaleCount(base, '1d'),
    '7d': scaleCount(base, '7d'),
    '14d': scaleCount(base, '14d'),
    '30d': scaleCount(base, '30d'),
    '60d': scaleCount(base, '60d'),
  };
}

function buildRetentionWindowComparison(basePct: number): ObservabilityWindowComparisonMap {
  return {
    today: Math.max(35, Math.min(98, Math.round(basePct - 3))),
    '1d': Math.max(35, Math.min(98, Math.round(basePct - 2))),
    '7d': Math.max(35, Math.min(98, Math.round(basePct))),
    '14d': Math.max(35, Math.min(98, Math.round(basePct + 2))),
    '30d': Math.max(35, Math.min(98, Math.round(basePct + 4))),
    '60d': Math.max(35, Math.min(98, Math.round(basePct + 6))),
  };
}

function directionFor(delta: number): ObservabilityTrendDirection {
  if (delta > 1) return 'up';
  if (delta < -1) return 'down';
  return 'flat';
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function buildTopUsers(window: ObservabilityTrendWindow): ObservabilityTopUserItem[] {
  const shift = WINDOW_DELTA_SHIFT[window];
  const seeds = [
    {
      userId: '11111111-1111-4111-8111-111111111111',
      displayName: 'Ada Lovelace',
      role: 'Product Owner',
      baseInteractions: 64,
      baseSessions: 5,
      modulesUsed: 7,
      topModule: 'Design Interviews & PRD',
      baseDelta: 18.4,
    },
    {
      userId: '33333333-3333-4333-8333-333333333333',
      displayName: 'Grace Hopper',
      role: 'Principal Architect',
      baseInteractions: 52,
      baseSessions: 4,
      modulesUsed: 6,
      topModule: 'Architecture Decision Records',
      baseDelta: 14.2,
    },
    {
      userId: '44444444-4444-4444-8444-444444444444',
      displayName: 'Margaret Hamilton',
      role: 'Release Lead',
      baseInteractions: 45,
      baseSessions: 4,
      modulesUsed: 5,
      topModule: 'Planning & Releases',
      baseDelta: 9.6,
    },
    {
      userId: '55555555-5555-4555-8555-555555555555',
      displayName: 'Katherine Johnson',
      role: 'Lead Business Analyst',
      baseInteractions: 38,
      baseSessions: 3,
      modulesUsed: 5,
      topModule: 'Agent Home & Brainstorm',
      baseDelta: 6.1,
    },
    {
      userId: '66666666-6666-4666-8666-666666666666',
      displayName: 'Donald Knuth',
      role: 'Staff Engineer',
      baseInteractions: 31,
      baseSessions: 3,
      modulesUsed: 4,
      topModule: 'My Work (Dev Workbench)',
      baseDelta: -3.2,
    },
  ];

  return seeds.map((seed) => {
    const windowComparison = buildWindowComparison(seed.baseInteractions);
    const deltaPct = round1(seed.baseDelta + shift * 0.45);
    return {
      userId: seed.userId,
      displayName: seed.displayName,
      role: seed.role,
      interactions: windowComparison[window],
      sessions: scaleCount(seed.baseSessions, window),
      modulesUsed: seed.modulesUsed,
      topModule: seed.topModule,
      deltaPct,
      trend: directionFor(deltaPct),
      windowComparison,
    };
  });
}

export function buildCommonExceptions(window: ObservabilityTrendWindow): ObservabilityExceptionItem[] {
  const shift = WINDOW_DELTA_SHIFT[window];
  const seeds: Array<{
    id: string;
    signature: string;
    module: string;
    routeTemplate: string;
    statusCode: number;
    baseCount: number;
    baseUsers: number;
    baseDelta: number;
    severity: 'critical' | 'high' | 'medium' | 'low';
  }> = [
    {
      id: 'exc-prototype-timeout',
      signature: 'BedrockPrototypeStreamTimeout: generation exceeded 60s window',
      module: 'Design Prototypes',
      routeTemplate: '/backlog/design-prototypes/:id',
      statusCode: 504,
      baseCount: 7,
      baseUsers: 4,
      baseDelta: 22.5,
      severity: 'high',
    },
    {
      id: 'exc-ado-rate-limit',
      signature: 'AdoWorkItemBatchThrottleError: TF400733 rate limit reached on batch sync',
      module: 'Scrum Calendar & Work Items',
      routeTemplate: '/calendar',
      statusCode: 429,
      baseCount: 5,
      baseUsers: 3,
      baseDelta: 11.0,
      severity: 'medium',
    },
    {
      id: 'exc-load-test-target',
      signature: 'LoadTestTargetAllowlistError: target origin not in verified allowlist',
      module: 'Load Testing',
      routeTemplate: '/load-tests/new',
      statusCode: 422,
      baseCount: 4,
      baseUsers: 3,
      baseDelta: 8.4,
      severity: 'medium',
    },
    {
      id: 'exc-walkthrough-anchor',
      signature: 'WalkthroughAnchorMissingWarning: coachmark target selector not mounted',
      module: 'Guided Walkthroughs',
      routeTemplate: '/platform-admin',
      statusCode: 409,
      baseCount: 2,
      baseUsers: 2,
      baseDelta: -12.0,
      severity: 'low',
    },
  ];

  return seeds.map((seed) => {
    const windowComparison = buildWindowComparison(seed.baseCount);
    return {
      id: seed.id,
      signature: seed.signature,
      module: seed.module,
      routeTemplate: seed.routeTemplate,
      statusCode: seed.statusCode,
      count: windowComparison[window],
      affectedUsers: Math.max(1, Math.min(48, Math.round(seed.baseUsers * Math.sqrt(WINDOW_MULTIPLIER[window])))),
      deltaPct: round1(seed.baseDelta - shift * 0.3),
      severity: seed.severity,
      windowComparison,
    };
  });
}

export function buildModuleRetentionDrops(
  window: ObservabilityTrendWindow,
): ObservabilityModuleRetentionDropItem[] {
  const shift = WINDOW_DELTA_SHIFT[window];
  const seeds = [
    {
      module: 'Design Prototypes',
      routeTemplate: '/backlog/design-prototypes/:id',
      previousRetentionPct: 84,
      baseCurrentRetentionPct: 68,
      baseReturning: 14,
      baseLost: 7,
      primaryFriction: '504 Bedrock stream timeouts during multi-screen HTML regeneration',
    },
    {
      module: 'Load Testing',
      routeTemplate: '/load-tests',
      previousRetentionPct: 76,
      baseCurrentRetentionPct: 63,
      baseReturning: 11,
      baseLost: 6,
      primaryFriction: '422 allowlist validation errors when configuring first k6 script target',
    },
    {
      module: 'UI Lab',
      routeTemplate: '/ui-lab',
      previousRetentionPct: 79,
      baseCurrentRetentionPct: 69,
      baseReturning: 16,
      baseLost: 5,
      primaryFriction: 'Users exit after first draft without discovering export-to-PRD handoff',
    },
    {
      module: 'Daily Standups',
      routeTemplate: '/standup',
      previousRetentionPct: 88,
      baseCurrentRetentionPct: 81,
      baseReturning: 22,
      baseLost: 4,
      primaryFriction: 'Late morning submissions miss the automated facilitator cutoff',
    },
  ];

  return seeds.map((seed) => {
    const windowComparison = buildRetentionWindowComparison(seed.baseCurrentRetentionPct);
    const currentRetentionPct = windowComparison[window];
    const previousRetentionPct = Math.min(97, Math.round(seed.previousRetentionPct + shift * 0.2));
    const dropPct = Math.max(2, previousRetentionPct - currentRetentionPct);
    return {
      module: seed.module,
      routeTemplate: seed.routeTemplate,
      previousRetentionPct,
      currentRetentionPct,
      dropPct,
      returningUsers: Math.max(2, Math.round(seed.baseReturning * Math.sqrt(WINDOW_MULTIPLIER[window] * 0.5))),
      lostUsers: Math.max(1, Math.round(seed.baseLost * Math.sqrt(WINDOW_MULTIPLIER[window] * 0.5))),
      primaryFriction: seed.primaryFriction,
      windowComparison,
    };
  });
}

export function buildDropReasonsSummary(
  window: ObservabilityTrendWindow,
  model: string,
  effort: EffortLevel,
): ObservabilityDropReasonsSummary {
  const windowLabel = OBSERVABILITY_TREND_WINDOW_LABELS[window];
  const effortName = effortLabel(effort);

  return {
    headline: `Retention dips in ${windowLabel} cluster around prototype generation timeouts and first-run setup friction (${model} · ${effortName} effort).`,
    narrative: `Across the ${windowLabel.toLowerCase()} cohort (${WINDOW_BASELINE_LABELS[window]}), module retention drops are strongly correlated with recoverable exception hotspots rather than lack of product demand. Users who encounter a 504 timeout on Design Prototypes or a 422 allowlist block on Load Testing abandon the session within 90 seconds at 3.1x the baseline rate.`,
    findings: [
      {
        id: 'drop-reason-prototypes',
        module: 'Design Prototypes',
        title: 'Regeneration latency & 504 timeouts drive 68% of prototype cohort churn',
        detail:
          'Users iterating on multi-feature PRDs hit 60-second Bedrock stream timeouts during full-screen HTML regeneration, causing them to leave before approving the prototype.',
        evidence:
          'Correlated with BedrockPrototypeStreamTimeout on /backlog/design-prototypes/:id (16% retention drop).',
        confidence: 'high',
      },
      {
        id: 'drop-reason-load-test',
        module: 'Load Testing',
        title: 'Unconfigured target allowlist blocks first-time k6 builders',
        detail:
          'Contributors attempting to generate a k6 script hit 422 LoadTestTargetAllowlistError when their staging URL is not pre-registered by a Project Admin.',
        evidence:
          '71% of lost Load Testing users triggered a 422 on /load-tests/new during their first session.',
        confidence: 'high',
      },
      {
        id: 'drop-reason-ui-lab',
        module: 'UI Lab',
        title: 'Missing handoff cue from UI Lab canvas to Backlog PRD',
        detail:
          'Creators complete a single UI Lab exploration but do not return because the path to promote a screen into an active PRD or Design Doc is not surfaced inline.',
        evidence:
          'Journey rollup shows high exit rate from /ui-lab/:id with <12% transition to /backlog/prd/:id.',
        confidence: 'medium',
      },
    ],
  };
}

export function buildTopModules(window: ObservabilityTrendWindow): ObservabilityTopModuleItem[] {
  const shift = WINDOW_DELTA_SHIFT[window];
  const seeds = [
    {
      module: 'Agent Home & Brainstorm',
      routeTemplate: '/home',
      baseUsers: 28,
      baseInteractions: 185,
      sharePct: 31,
      retentionPct: 92,
      baseDelta: 21.4,
    },
    {
      module: 'Design Interviews & PRD',
      routeTemplate: '/backlog',
      baseUsers: 24,
      baseInteractions: 148,
      sharePct: 25,
      retentionPct: 89,
      baseDelta: 16.8,
    },
    {
      module: 'Scrum Calendar & Work Items',
      routeTemplate: '/calendar',
      baseUsers: 21,
      baseInteractions: 112,
      sharePct: 19,
      retentionPct: 86,
      baseDelta: 11.2,
    },
    {
      module: 'My Work (Dev Workbench)',
      routeTemplate: '/my-work',
      baseUsers: 17,
      baseInteractions: 84,
      sharePct: 14,
      retentionPct: 84,
      baseDelta: 9.5,
    },
    {
      module: 'Architecture Decision Records',
      routeTemplate: '/adr',
      baseUsers: 13,
      baseInteractions: 64,
      sharePct: 11,
      retentionPct: 82,
      baseDelta: 7.1,
    },
  ];

  return seeds.map((seed) => {
    const windowComparison = buildWindowComparison(seed.baseInteractions);
    const deltaPct = round1(seed.baseDelta + shift * 0.4);
    return {
      module: seed.module,
      routeTemplate: seed.routeTemplate,
      activeUsers: Math.max(2, Math.round(seed.baseUsers * Math.sqrt(WINDOW_MULTIPLIER[window] * 0.65))),
      interactions: windowComparison[window],
      sharePct: seed.sharePct,
      retentionPct: Math.min(98, Math.round(seed.retentionPct + shift * 0.15)),
      deltaPct,
      trend: directionFor(deltaPct),
      windowComparison,
    };
  });
}

export function buildAdoptionRecommendations(
  window: ObservabilityTrendWindow,
  model: string,
  effort: EffortLevel,
): ObservabilityAdoptionSummary {
  const windowLabel = OBSERVABILITY_TREND_WINDOW_LABELS[window];
  const effortName = effortLabel(effort);

  return {
    headline: `Three high-leverage adoption plays for ${windowLabel} synthesized via ${OBSERVABILITY_PO_SKILL_PATH} (${model} · ${effortName}).`,
    narrative: `By pairing targeted reliability fixes in Design Prototypes with in-context Guided Walkthroughs and one-click workflow handoffs from Agent Home, Product Owners can recover dropped cohorts and lift cross-module adoption across ${windowLabel.toLowerCase()}.`,
    recommendations: [
      {
        id: 'adopt-prototype-streaming',
        module: 'Design Prototypes',
        title: 'Enable incremental section streaming & auto-retry on Prototype regeneration',
        action:
          'Split multi-screen prototype prompts into progressive section checkpoints and surface a live progress indicator so users never hit a cold 504 timeout.',
        expectedLift: '+14% prototype completion & +11% downstream Design Doc creation',
        impact: 'high',
      },
      {
        id: 'adopt-load-test-walkthrough',
        module: 'Load Testing',
        title: 'Launch an interactive coachmark walkthrough & pre-seeded dev allowlist',
        action:
          'Auto-trigger a 3-step Guided Walkthrough on /load-tests/new and pre-populate non-prod sandbox targets so teams can run their first k6 test in under 2 minutes.',
        expectedLift: '+18% first-week Load Testing retention',
        impact: 'high',
      },
      {
        id: 'adopt-ui-lab-handoff',
        module: 'UI Lab',
        title: 'Add "Promote to PRD / Feature" CTA and Agent Home skill pill',
        action:
          'Place a direct handoff button in UI Lab header to attach approved screens to an interview or PRD, and promote UI Lab as a suggested next step after Brainstorm sessions.',
        expectedLift: '+22% repeat weekly UI Lab creators',
        impact: 'medium',
      },
    ],
  };
}

export function computeSlotTimestamps(now = new Date()): {
  lastMorningIso: string;
  lastEveningIso: string;
  nextMorningIso: string;
  nextEveningIso: string;
} {
  const morningToday = new Date(now);
  morningToday.setUTCHours(OBSERVABILITY_PO_SCHEDULE_HOURS[0], 0, 0, 0);

  const eveningToday = new Date(now);
  eveningToday.setUTCHours(OBSERVABILITY_PO_SCHEDULE_HOURS[1], 0, 0, 0);

  const lastMorning =
    now >= morningToday
      ? morningToday
      : new Date(morningToday.getTime() - 24 * 60 * 60 * 1000);
  const nextMorning =
    now < morningToday
      ? morningToday
      : new Date(morningToday.getTime() + 24 * 60 * 60 * 1000);

  const lastEvening =
    now >= eveningToday
      ? eveningToday
      : new Date(eveningToday.getTime() - 24 * 60 * 60 * 1000);
  const nextEvening =
    now < eveningToday
      ? eveningToday
      : new Date(eveningToday.getTime() + 24 * 60 * 60 * 1000);

  return {
    lastMorningIso: lastMorning.toISOString(),
    lastEveningIso: lastEvening.toISOString(),
    nextMorningIso: nextMorning.toISOString(),
    nextEveningIso: nextEvening.toISOString(),
  };
}

export function synthesizePoDigestSnapshot(options: {
  project: string;
  window: ObservabilityTrendWindow;
  model: string;
  effort: EffortLevel;
  slot: ObservabilityDigestSlot;
  now?: Date;
}): ObservabilityPoDigestSnapshot {
  const { project, window, model, effort, slot } = options;
  const now = options.now ?? new Date();
  const windowLabel = OBSERVABILITY_TREND_WINDOW_LABELS[window];
  const baselineLabel = WINDOW_BASELINE_LABELS[window];

  const topUsers = buildTopUsers(window);
  const commonExceptions = buildCommonExceptions(window);
  const moduleRetentionDrops = buildModuleRetentionDrops(window);
  const dropReasonsSummary = buildDropReasonsSummary(window, model, effort);
  const topModules = buildTopModules(window);
  const adoptionRecommendations = buildAdoptionRecommendations(window, model, effort);

  const activeUsers = topModules.reduce((sum, item) => sum + item.activeUsers, 0);
  const totalExceptions = commonExceptions.reduce((sum, item) => sum + item.count, 0);
  const avgModuleRetentionPct = Math.round(
    moduleRetentionDrops.reduce((sum, item) => sum + item.currentRetentionPct, 0) /
      Math.max(1, moduleRetentionDrops.length),
  );
  const topModule = topModules[0]!;

  const slotBadge =
    slot === 'morning_6am'
      ? '6:00 AM Morning Digest'
      : slot === 'evening_6pm'
        ? '6:00 PM Evening Digest'
        : 'On-Demand Digest';

  return {
    id: `po-digest-${project.toLowerCase()}-${window}-${slot}-${now.getTime()}`,
    project,
    window,
    windowLabel,
    baselineLabel,
    slot,
    skillPath: OBSERVABILITY_PO_SKILL_PATH,
    model,
    effort,
    generatedAt: now.toISOString(),
    headline: `${slotBadge} (${windowLabel}): ${activeUsers} active users across ${topModules.length} core modules, led by ${topModule.module} (${topModule.sharePct}% share) — analyzed with ${model} (${effortLabel(effort)} effort).`,
    kpis: {
      activeUsers,
      activeUsersDeltaPct: round1(14.6 + WINDOW_DELTA_SHIFT[window] * 0.35),
      totalExceptions,
      exceptionsDeltaPct: round1(-6.4 - WINDOW_DELTA_SHIFT[window] * 0.2),
      avgModuleRetentionPct,
      retentionDeltaPct: round1(3.8 + WINDOW_DELTA_SHIFT[window] * 0.15),
      topModuleName: topModule.module,
      topModuleSharePct: topModule.sharePct,
    },
    topUsers,
    commonExceptions,
    moduleRetentionDrops,
    dropReasonsSummary,
    topModules,
    adoptionRecommendations,
  };
}

export function buildDefaultScheduleSummary(
  configuredModel: string,
  configuredEffort: EffortLevel,
  morningLastRunAt?: string | null,
  eveningLastRunAt?: string | null,
  now = new Date(),
): ObservabilityScheduleSummary {
  const times = computeSlotTimestamps(now);
  return {
    cadenceLabel: 'Twice daily at 6:00 AM & 6:00 PM',
    timezone: 'UTC / Platform Schedule (06:00 & 18:00)',
    skillPath: OBSERVABILITY_PO_SKILL_PATH,
    configuredModel,
    configuredEffort,
    morningSlot: {
      slot: 'morning_6am',
      label: 'Morning Digest (6:00 AM)',
      scheduledTimeLabel: '6:00 AM Daily',
      lastRunAt: morningLastRunAt ?? times.lastMorningIso,
      nextRunAt: times.nextMorningIso,
      model: configuredModel,
      effort: configuredEffort,
      status: 'ready',
    },
    eveningSlot: {
      slot: 'evening_6pm',
      label: 'Evening Digest (6:00 PM)',
      scheduledTimeLabel: '6:00 PM Daily',
      lastRunAt: eveningLastRunAt ?? times.lastEveningIso,
      nextRunAt: times.nextEveningIso,
      model: configuredModel,
      effort: configuredEffort,
      status: 'ready',
    },
  };
}

export function buildFallbackPoDigestResponse(options: {
  project: string;
  window: ObservabilityTrendWindow;
  model: string;
  effort: EffortLevel;
  slot?: ObservabilityDigestSlot;
  now?: Date;
}): ObservabilityPoDigestResponse {
  const now = options.now ?? new Date();
  const slot = options.slot ?? 'morning_6am';
  const digest = synthesizePoDigestSnapshot({
    project: options.project,
    window: options.window,
    model: options.model,
    effort: options.effort,
    slot,
    now,
  });
  const schedule = buildDefaultScheduleSummary(options.model, options.effort, null, null, now);
  return {
    digest,
    schedule,
    history: [
      {
        id: digest.id,
        slot: 'evening_6pm',
        window: options.window,
        model: options.model,
        effort: options.effort,
        generatedAt: schedule.eveningSlot.lastRunAt ?? now.toISOString(),
        headline: digest.headline,
      },
      {
        id: `${digest.id}-morning`,
        slot: 'morning_6am',
        window: options.window,
        model: options.model,
        effort: options.effort,
        generatedAt: schedule.morningSlot.lastRunAt ?? now.toISOString(),
        headline: digest.headline,
      },
    ],
  };
}
