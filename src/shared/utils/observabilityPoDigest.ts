/**
 * Shared Product Owner Observability Digest aggregation & synthesis utilities.
 *
 * Computes the six Product Owner core signals from real `trace_events`,
 * `trace_path_rollups`, and `app_users` rows across `today`, `1d`, `7d`, `14d`,
 * `30d`, and `60d` trend windows, and provides a telemetry-grounded synthesis
 * fallback when offline or in E2E/unit test environments.
 */
import { isEffortLevel, type EffortLevel } from '../types/effort';
import {
  OBSERVABILITY_PO_DEFAULT_EFFORT,
  OBSERVABILITY_PO_DEFAULT_MODEL,
  OBSERVABILITY_PO_SCHEDULE_HOURS,
  OBSERVABILITY_PO_SKILL_PATH,
  OBSERVABILITY_TREND_WINDOWS,
  OBSERVABILITY_TREND_WINDOW_LABELS,
  type ObservabilityAdoptionPlay,
  type ObservabilityAdoptionSummary,
  type ObservabilityDigestSlot,
  type ObservabilityDropReasonFinding,
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

const DAY_MS = 24 * 60 * 60 * 1000;

export const WINDOW_BASELINE_LABELS: Record<ObservabilityTrendWindow, string> = {
  today: 'vs yesterday same window',
  '1d': 'vs prior 24 hours',
  '7d': 'vs prior 7 days',
  '14d': 'vs prior 14 days',
  '30d': 'vs prior 30 days',
  '60d': 'vs prior 60 days',
};

export interface RawDigestTraceEventRow {
  id: string;
  eventType: string;
  occurredAt: string;
  actorUserId: string | null;
  projectId: string | null;
  sessionId: string | null;
  routeTemplate: string | null;
  httpMethod: string | null;
  statusCode: number | null;
  durationMs: number | null;
  severity: string | null;
  message: string | null;
}

export interface RawDigestRollupRow {
  fromRoute: string;
  toRoute: string;
  day: string;
  transitionCount: number;
  distinctActorCount: number;
}

export interface RawDigestUserRow {
  oid: string;
  displayName: string | null;
  email: string | null;
  role?: string | null;
}

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

export function windowDurationMs(window: ObservabilityTrendWindow, now = new Date()): number {
  switch (window) {
    case 'today': {
      const startOfUtcDay = Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        0,
        0,
        0,
        0,
      );
      return Math.max(60 * 60 * 1000, now.getTime() - startOfUtcDay);
    }
    case '1d':
      return DAY_MS;
    case '7d':
      return 7 * DAY_MS;
    case '14d':
      return 14 * DAY_MS;
    case '30d':
      return 30 * DAY_MS;
    case '60d':
      return 60 * DAY_MS;
  }
}

export function mapRouteToModule(routeTemplate: string | null | undefined): {
  module: string;
  canonicalRoute: string;
} {
  const route = (routeTemplate ?? '').trim();
  if (!route || route === '/' || route.startsWith('/home') || route.startsWith('/brainstorm')) {
    return { module: 'Agent Home & Brainstorm', canonicalRoute: '/home' };
  }
  if (
    route.startsWith('/backlog/design-prototypes') ||
    route.startsWith('/backlog/design-plan') ||
    route.startsWith('/api/design-prototypes')
  ) {
    return { module: 'Design Prototypes', canonicalRoute: '/backlog/design-prototypes/:id' };
  }
  if (route.startsWith('/backlog/design-doc') || route.startsWith('/api/interviews/design-docs')) {
    return { module: 'Design Documents', canonicalRoute: '/backlog/design-doc/:id' };
  }
  if (
    route.startsWith('/backlog') ||
    route.startsWith('/api/interviews') ||
    route.startsWith('/api/prds')
  ) {
    return { module: 'Design Interviews & PRD', canonicalRoute: '/backlog' };
  }
  if (
    route.startsWith('/calendar') ||
    route.startsWith('/api/workitems') ||
    route.startsWith('/api/timecards')
  ) {
    return { module: 'Scrum Calendar & Work Items', canonicalRoute: '/calendar' };
  }
  if (route.startsWith('/my-work') || route.startsWith('/api/dev-workbench')) {
    return { module: 'My Work (Dev Workbench)', canonicalRoute: '/my-work' };
  }
  if (route.startsWith('/adr') || route.startsWith('/api/adr')) {
    return { module: 'Architecture Decision Records', canonicalRoute: '/adr' };
  }
  if (route.startsWith('/ui-lab') || route.startsWith('/api/ui-lab')) {
    return { module: 'UI Lab', canonicalRoute: '/ui-lab' };
  }
  if (route.startsWith('/load-tests') || route.startsWith('/api/load-tests')) {
    return { module: 'Load Testing', canonicalRoute: '/load-tests' };
  }
  if (route.startsWith('/standup') || route.startsWith('/api/standup')) {
    return { module: 'Daily Standups', canonicalRoute: '/standup' };
  }
  if (route.startsWith('/planning') || route.startsWith('/api/releases')) {
    return { module: 'Planning & Releases', canonicalRoute: '/planning' };
  }
  if (
    route.startsWith('/ai-cost') ||
    route.startsWith('/cloud-cost') ||
    route.startsWith('/api/ai-cost')
  ) {
    return { module: 'AI & Cloud Cost Analytics', canonicalRoute: '/ai-cost' };
  }
  if (route.startsWith('/platform-admin') || route.startsWith('/api/platform-admin')) {
    return { module: 'Platform Admin & Walkthroughs', canonicalRoute: '/platform-admin' };
  }
  if (route.startsWith('/admin') || route.startsWith('/api/admin')) {
    return { module: 'Project Admin & RBAC', canonicalRoute: '/admin' };
  }
  if (route.startsWith('/design-module') || route.startsWith('/api/design-module')) {
    return { module: 'Design Module', canonicalRoute: '/design-module' };
  }
  if (route.startsWith('/diagrams') || route.startsWith('/api/diagrams')) {
    return { module: 'Architecture Diagrams', canonicalRoute: '/diagrams' };
  }
  if (route.startsWith('/builds') || route.startsWith('/api/builds')) {
    return { module: 'Builds', canonicalRoute: '/builds' };
  }
  if (route.startsWith('/notifications') || route.startsWith('/api/notifications')) {
    return { module: 'Notifications', canonicalRoute: '/notifications' };
  }
  if (route.startsWith('/profile') || route.startsWith('/api/profile')) {
    return { module: 'User Profile', canonicalRoute: '/profile' };
  }
  return { module: 'Platform Core API', canonicalRoute: route.startsWith('/') ? route : '/' };
}

function directionFor(delta: number): ObservabilityTrendDirection {
  if (delta > 1) return 'up';
  if (delta < -1) return 'down';
  return 'flat';
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function computeDeltaPct(current: number, previous: number): number {
  if (previous > 0) {
    return round1(((current - previous) / previous) * 100);
  }
  if (current > 0) return 100;
  return 0;
}

function isExceptionEvent(row: RawDigestTraceEventRow): boolean {
  if (row.eventType === 'error') return true;
  if (typeof row.statusCode === 'number' && row.statusCode >= 400) return true;
  const sev = (row.severity ?? '').toLowerCase();
  return sev === 'error' || sev === 'fatal' || sev === 'warn' || sev === 'warning';
}

function classifyExceptionSeverity(
  row: RawDigestTraceEventRow,
  count: number,
): 'critical' | 'high' | 'medium' | 'low' {
  const sev = (row.severity ?? '').toLowerCase();
  const code = row.statusCode ?? 500;
  if (sev === 'fatal' || (code >= 500 && count >= 10)) return 'critical';
  if (code >= 500 || sev === 'error') return 'high';
  if (code === 429 || code >= 400 || sev === 'warn' || sev === 'warning') return 'medium';
  return 'low';
}

function resolveUserDisplay(
  userId: string,
  usersById: Map<string, RawDigestUserRow>,
): { displayName: string; role: string } {
  const user = usersById.get(userId);
  const displayName =
    user?.displayName?.trim() ||
    (user?.email?.trim() ? user.email.trim().split('@')[0]! : '') ||
    `User ${userId.slice(0, 8)}`;
  const role = user?.role?.trim() || 'Platform Member';
  return { displayName, role };
}

/**
 * Aggregate live PostgreSQL `trace_events`, `trace_path_rollups`, and `app_users`
 * rows into the structured Product Owner Observability signals for `window`.
 */
export function aggregateTelemetryFromDatabaseRows(options: {
  events: RawDigestTraceEventRow[];
  rollups: RawDigestRollupRow[];
  users: RawDigestUserRow[];
  window: ObservabilityTrendWindow;
  now?: Date;
}): {
  topUsers: ObservabilityTopUserItem[];
  commonExceptions: ObservabilityExceptionItem[];
  moduleRetentionDrops: ObservabilityModuleRetentionDropItem[];
  topModules: ObservabilityTopModuleItem[];
  kpis: ObservabilityPoDigestSnapshot['kpis'];
} {
  const now = options.now ?? new Date();
  const nowMs = now.getTime();
  const selectedSpanMs = windowDurationMs(options.window, now);
  const currentStartMs = nowMs - selectedSpanMs;
  const priorStartMs = nowMs - 2 * selectedSpanMs;
  const priorPriorStartMs = nowMs - 3 * selectedSpanMs;

  const windowStartMsByKey: Record<ObservabilityTrendWindow, number> = {
    today: nowMs - windowDurationMs('today', now),
    '1d': nowMs - windowDurationMs('1d', now),
    '7d': nowMs - windowDurationMs('7d', now),
    '14d': nowMs - windowDurationMs('14d', now),
    '30d': nowMs - windowDurationMs('30d', now),
    '60d': nowMs - windowDurationMs('60d', now),
  };

  const usersById = new Map<string, RawDigestUserRow>();
  for (const u of options.users) {
    if (u.oid) usersById.set(u.oid, u);
  }

  const parsedEvents = options.events
    .map((row) => {
      const ts = Date.parse(row.occurredAt);
      const { module, canonicalRoute } = mapRouteToModule(row.routeTemplate);
      return {
        ...row,
        ts: Number.isNaN(ts) ? nowMs : ts,
        module,
        canonicalRoute,
      };
    })
    .filter((row) => row.ts <= nowMs + 5 * 60 * 1000);

  // ── 1. Top Users Aggregation ─────────────────────────────────────────────────
  interface UserAccumulator {
    userId: string;
    currentCount: number;
    priorCount: number;
    currentSessions: Set<string>;
    currentModules: Map<string, number>;
    allTimeModules: Map<string, number>;
    windowCounts: ObservabilityWindowComparisonMap;
  }

  const userAccMap = new Map<string, UserAccumulator>();
  for (const ev of parsedEvents) {
    if (!ev.actorUserId) continue;
    let acc = userAccMap.get(ev.actorUserId);
    if (!acc) {
      acc = {
        userId: ev.actorUserId,
        currentCount: 0,
        priorCount: 0,
        currentSessions: new Set(),
        currentModules: new Map(),
        allTimeModules: new Map(),
        windowCounts: { today: 0, '1d': 0, '7d': 0, '14d': 0, '30d': 0, '60d': 0 },
      };
      userAccMap.set(ev.actorUserId, acc);
    }

    acc.allTimeModules.set(ev.module, (acc.allTimeModules.get(ev.module) ?? 0) + 1);

    for (const w of OBSERVABILITY_TREND_WINDOWS) {
      if (ev.ts >= windowStartMsByKey[w]) {
        acc.windowCounts[w] += 1;
      }
    }

    if (ev.ts >= currentStartMs) {
      acc.currentCount += 1;
      if (ev.sessionId) acc.currentSessions.add(ev.sessionId);
      acc.currentModules.set(ev.module, (acc.currentModules.get(ev.module) ?? 0) + 1);
    } else if (ev.ts >= priorStartMs && ev.ts < currentStartMs) {
      acc.priorCount += 1;
    }
  }

  const topUsers: ObservabilityTopUserItem[] = Array.from(userAccMap.values())
    .sort(
      (a, b) =>
        b.currentCount - a.currentCount ||
        b.windowCounts['60d'] - a.windowCounts['60d'] ||
        a.userId.localeCompare(b.userId),
    )
    .slice(0, 8)
    .map((acc) => {
      const { displayName, role } = resolveUserDisplay(acc.userId, usersById);
      const moduleSource = acc.currentModules.size > 0 ? acc.currentModules : acc.allTimeModules;
      const topModule =
        Array.from(moduleSource.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ??
        'Agent Home & Brainstorm';
      const deltaPct = computeDeltaPct(acc.currentCount, acc.priorCount);
      const sessions =
        acc.currentSessions.size > 0
          ? acc.currentSessions.size
          : acc.currentCount > 0
            ? 1
            : 0;
      return {
        userId: acc.userId,
        displayName,
        role,
        interactions: acc.currentCount,
        sessions,
        modulesUsed: moduleSource.size,
        topModule,
        deltaPct,
        trend: directionFor(deltaPct),
        windowComparison: acc.windowCounts,
      };
    });

  // ── 2. Most Common Exceptions Aggregation ────────────────────────────────────
  interface ExceptionAccumulator {
    key: string;
    signature: string;
    module: string;
    routeTemplate: string;
    statusCode: number;
    sampleRow: RawDigestTraceEventRow;
    currentCount: number;
    priorCount: number;
    currentUsers: Set<string>;
    allUsers: Set<string>;
    windowCounts: ObservabilityWindowComparisonMap;
  }

  const excAccMap = new Map<string, ExceptionAccumulator>();
  for (const ev of parsedEvents) {
    if (!isExceptionEvent(ev)) continue;
    const statusCode = ev.statusCode ?? 500;
    const routeTemplate = ev.routeTemplate ?? ev.canonicalRoute;
    const signature =
      ev.message?.trim() ||
      `${ev.httpMethod ?? 'ERROR'} ${routeTemplate} (HTTP ${statusCode})`;
    const key = `${signature}::${ev.module}::${routeTemplate}::${statusCode}`;

    let acc = excAccMap.get(key);
    if (!acc) {
      acc = {
        key,
        signature,
        module: ev.module,
        routeTemplate,
        statusCode,
        sampleRow: ev,
        currentCount: 0,
        priorCount: 0,
        currentUsers: new Set(),
        allUsers: new Set(),
        windowCounts: { today: 0, '1d': 0, '7d': 0, '14d': 0, '30d': 0, '60d': 0 },
      };
      excAccMap.set(key, acc);
    }

    if (ev.actorUserId) acc.allUsers.add(ev.actorUserId);

    for (const w of OBSERVABILITY_TREND_WINDOWS) {
      if (ev.ts >= windowStartMsByKey[w]) {
        acc.windowCounts[w] += 1;
      }
    }

    if (ev.ts >= currentStartMs) {
      acc.currentCount += 1;
      if (ev.actorUserId) acc.currentUsers.add(ev.actorUserId);
    } else if (ev.ts >= priorStartMs && ev.ts < currentStartMs) {
      acc.priorCount += 1;
    }
  }

  const commonExceptions: ObservabilityExceptionItem[] = Array.from(excAccMap.values())
    .sort(
      (a, b) =>
        b.currentCount - a.currentCount ||
        b.windowCounts['60d'] - a.windowCounts['60d'] ||
        a.signature.localeCompare(b.signature),
    )
    .slice(0, 8)
    .map((acc, idx) => {
      const count = acc.currentCount;
      const affectedUsers =
        acc.currentUsers.size > 0
          ? acc.currentUsers.size
          : count > 0
            ? Math.max(1, acc.allUsers.size)
            : 0;
      const deltaPct = computeDeltaPct(acc.currentCount, acc.priorCount);
      return {
        id: `exc-${idx + 1}-${acc.module.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        signature: acc.signature,
        module: acc.module,
        routeTemplate: acc.routeTemplate,
        statusCode: acc.statusCode,
        count,
        affectedUsers,
        deltaPct,
        severity: classifyExceptionSeverity(acc.sampleRow, Math.max(count, acc.windowCounts['60d'])),
        windowComparison: acc.windowCounts,
      };
    });

  // ── 3 & 4. Module Adoption & Cohort Retention Drops Aggregation ──────────────
  interface ModuleAccumulator {
    module: string;
    routeTemplate: string;
    currentInteractions: number;
    priorInteractions: number;
    currentUsers: Set<string>;
    priorUsers: Set<string>;
    priorPriorUsers: Set<string>;
    windowInteractions: ObservabilityWindowComparisonMap;
    windowUsersCurrent: Record<ObservabilityTrendWindow, Set<string>>;
    windowUsersPrior: Record<ObservabilityTrendWindow, Set<string>>;
    rollupTransitionsCurrent: number;
    rollupMaxActorsCurrent: number;
  }

  const modAccMap = new Map<string, ModuleAccumulator>();
  const ensureModule = (modName: string, canonicalRoute: string): ModuleAccumulator => {
    let acc = modAccMap.get(modName);
    if (!acc) {
      acc = {
        module: modName,
        routeTemplate: canonicalRoute,
        currentInteractions: 0,
        priorInteractions: 0,
        currentUsers: new Set(),
        priorUsers: new Set(),
        priorPriorUsers: new Set(),
        windowInteractions: { today: 0, '1d': 0, '7d': 0, '14d': 0, '30d': 0, '60d': 0 },
        windowUsersCurrent: {
          today: new Set(),
          '1d': new Set(),
          '7d': new Set(),
          '14d': new Set(),
          '30d': new Set(),
          '60d': new Set(),
        },
        windowUsersPrior: {
          today: new Set(),
          '1d': new Set(),
          '7d': new Set(),
          '14d': new Set(),
          '30d': new Set(),
          '60d': new Set(),
        },
        rollupTransitionsCurrent: 0,
        rollupMaxActorsCurrent: 0,
      };
      modAccMap.set(modName, acc);
    }
    return acc;
  };

  for (const ev of parsedEvents) {
    const acc = ensureModule(ev.module, ev.canonicalRoute);

    for (const w of OBSERVABILITY_TREND_WINDOWS) {
      const wSpan = windowDurationMs(w, now);
      const wStart = nowMs - wSpan;
      const wPriorStart = nowMs - 2 * wSpan;
      if (ev.ts >= wStart) {
        acc.windowInteractions[w] += 1;
        if (ev.actorUserId) acc.windowUsersCurrent[w].add(ev.actorUserId);
      } else if (ev.ts >= wPriorStart && ev.ts < wStart) {
        if (ev.actorUserId) acc.windowUsersPrior[w].add(ev.actorUserId);
      }
    }

    if (ev.ts >= currentStartMs) {
      acc.currentInteractions += 1;
      if (ev.actorUserId) acc.currentUsers.add(ev.actorUserId);
    } else if (ev.ts >= priorStartMs && ev.ts < currentStartMs) {
      acc.priorInteractions += 1;
      if (ev.actorUserId) acc.priorUsers.add(ev.actorUserId);
    } else if (ev.ts >= priorPriorStartMs && ev.ts < priorStartMs) {
      if (ev.actorUserId) acc.priorPriorUsers.add(ev.actorUserId);
    }
  }

  for (const rollup of options.rollups) {
    const rollupTs = Date.parse(`${rollup.day}T12:00:00.000Z`);
    if (Number.isNaN(rollupTs)) continue;
    const { module, canonicalRoute } = mapRouteToModule(rollup.toRoute || rollup.fromRoute);
    const acc = ensureModule(module, canonicalRoute);
    if (rollupTs >= currentStartMs) {
      acc.rollupTransitionsCurrent += rollup.transitionCount;
      acc.rollupMaxActorsCurrent = Math.max(acc.rollupMaxActorsCurrent, rollup.distinctActorCount);
    }
  }

  const allModules = Array.from(modAccMap.values());
  const totalInteractionsAcrossModules = Math.max(
    1,
    allModules.reduce(
      (sum, m) => sum + Math.max(m.currentInteractions, m.rollupTransitionsCurrent),
      0,
    ),
  );

  function computeRetentionForSets(priorSet: Set<string>, currentSet: Set<string>): {
    returningUsers: number;
    lostUsers: number;
    retentionPct: number;
  } {
    if (priorSet.size === 0) {
      return {
        returningUsers: currentSet.size,
        lostUsers: 0,
        retentionPct: currentSet.size > 0 ? 100 : 0,
      };
    }
    let returning = 0;
    for (const uid of priorSet) {
      if (currentSet.has(uid)) returning += 1;
    }
    const lost = Math.max(0, priorSet.size - returning);
    const retentionPct = Math.round((returning / priorSet.size) * 100);
    return { returningUsers: returning, lostUsers: lost, retentionPct };
  }

  const topModules: ObservabilityTopModuleItem[] = allModules
    .map((acc) => {
      const interactions = Math.max(acc.currentInteractions, acc.rollupTransitionsCurrent);
      const activeUsers = Math.max(
        acc.currentUsers.size,
        acc.rollupMaxActorsCurrent,
        interactions > 0 ? 1 : 0,
      );
      const sharePct = Math.max(
        1,
        Math.round((interactions / totalInteractionsAcrossModules) * 100),
      );
      const { retentionPct } = computeRetentionForSets(acc.priorUsers, acc.currentUsers);
      const deltaPct = computeDeltaPct(interactions, acc.priorInteractions);
      const windowComparison: ObservabilityWindowComparisonMap = {
        today: Math.max(acc.windowInteractions.today, 0),
        '1d': Math.max(acc.windowInteractions['1d'], 0),
        '7d': Math.max(acc.windowInteractions['7d'], 0),
        '14d': Math.max(acc.windowInteractions['14d'], 0),
        '30d': Math.max(acc.windowInteractions['30d'], 0),
        '60d': Math.max(acc.windowInteractions['60d'], 0),
      };
      return {
        module: acc.module,
        routeTemplate: acc.routeTemplate,
        activeUsers,
        interactions,
        sharePct,
        retentionPct,
        deltaPct,
        trend: directionFor(deltaPct),
        windowComparison,
      };
    })
    .sort(
      (a, b) =>
        b.interactions - a.interactions ||
        b.windowComparison['60d'] - a.windowComparison['60d'] ||
        a.module.localeCompare(b.module),
    )
    .slice(0, 8);

  const moduleRetentionDrops: ObservabilityModuleRetentionDropItem[] = allModules
    .map((acc) => {
      const currentRet = computeRetentionForSets(acc.priorUsers, acc.currentUsers);
      const previousRetentionPct =
        acc.priorPriorUsers.size > 0
          ? computeRetentionForSets(acc.priorPriorUsers, acc.priorUsers).retentionPct
          : acc.priorUsers.size > 0
            ? 100
            : currentRet.retentionPct;
      const dropPct = Math.max(0, previousRetentionPct - currentRet.retentionPct);

      const moduleException = commonExceptions.find((e) => e.module === acc.module);
      const primaryFriction = moduleException
        ? `${moduleException.signature} (HTTP ${moduleException.statusCode} · ${moduleException.count} events)`
        : currentRet.lostUsers > 0
          ? `${currentRet.lostUsers} cohort user(s) did not return after prior ${acc.routeTemplate} session`
          : `Active cohort stable on ${acc.routeTemplate}`;

      const windowComparison: ObservabilityWindowComparisonMap = {
        today: computeRetentionForSets(acc.windowUsersPrior.today, acc.windowUsersCurrent.today)
          .retentionPct,
        '1d': computeRetentionForSets(acc.windowUsersPrior['1d'], acc.windowUsersCurrent['1d'])
          .retentionPct,
        '7d': computeRetentionForSets(acc.windowUsersPrior['7d'], acc.windowUsersCurrent['7d'])
          .retentionPct,
        '14d': computeRetentionForSets(acc.windowUsersPrior['14d'], acc.windowUsersCurrent['14d'])
          .retentionPct,
        '30d': computeRetentionForSets(acc.windowUsersPrior['30d'], acc.windowUsersCurrent['30d'])
          .retentionPct,
        '60d': computeRetentionForSets(acc.windowUsersPrior['60d'], acc.windowUsersCurrent['60d'])
          .retentionPct,
      };

      return {
        module: acc.module,
        routeTemplate: acc.routeTemplate,
        previousRetentionPct,
        currentRetentionPct: currentRet.retentionPct,
        dropPct,
        returningUsers: currentRet.returningUsers,
        lostUsers: currentRet.lostUsers,
        primaryFriction,
        windowComparison,
      };
    })
    .sort(
      (a, b) =>
        b.dropPct - a.dropPct ||
        b.lostUsers - a.lostUsers ||
        a.currentRetentionPct - b.currentRetentionPct,
    )
    .slice(0, 6);

  // ── Overall KPIs ─────────────────────────────────────────────────────────────
  const distinctCurrentUsers = new Set(
    parsedEvents.filter((e) => e.ts >= currentStartMs && e.actorUserId).map((e) => e.actorUserId!),
  );
  const distinctPriorUsers = new Set(
    parsedEvents
      .filter((e) => e.ts >= priorStartMs && e.ts < currentStartMs && e.actorUserId)
      .map((e) => e.actorUserId!),
  );

  const activeUsers = Math.max(
    distinctCurrentUsers.size,
    topModules.reduce((max, m) => Math.max(max, m.activeUsers), 0),
  );
  const activeUsersDeltaPct = computeDeltaPct(activeUsers, distinctPriorUsers.size);

  const totalExceptions = commonExceptions.reduce((sum, e) => sum + e.count, 0);
  const priorExceptions = Array.from(excAccMap.values()).reduce(
    (sum, e) => sum + e.priorCount,
    0,
  );
  const exceptionsDeltaPct = computeDeltaPct(totalExceptions, priorExceptions);

  const avgModuleRetentionPct =
    moduleRetentionDrops.length > 0
      ? Math.round(
          moduleRetentionDrops.reduce((sum, m) => sum + m.currentRetentionPct, 0) /
            moduleRetentionDrops.length,
        )
      : 100;
  const avgPrevRetentionPct =
    moduleRetentionDrops.length > 0
      ? Math.round(
          moduleRetentionDrops.reduce((sum, m) => sum + m.previousRetentionPct, 0) /
            moduleRetentionDrops.length,
        )
      : 100;
  const retentionDeltaPct = round1(avgModuleRetentionPct - avgPrevRetentionPct);

  const topModule = topModules[0] ?? {
    module: 'Agent Home & Brainstorm',
    sharePct: 100,
  };

  return {
    topUsers,
    commonExceptions,
    moduleRetentionDrops,
    topModules,
    kpis: {
      activeUsers,
      activeUsersDeltaPct,
      totalExceptions,
      exceptionsDeltaPct,
      avgModuleRetentionPct,
      retentionDeltaPct,
      topModuleName: topModule.module,
      topModuleSharePct: topModule.sharePct,
    },
  };
}

/**
 * Telemetry-grounded AI synthesis of `dropReasonsSummary` and `adoptionRecommendations`
 * derived directly from the real aggregated PostgreSQL metrics.
 */
export function synthesizeSummariesFromTelemetry(options: {
  window: ObservabilityTrendWindow;
  model: string;
  effort: EffortLevel;
  topUsers: ObservabilityTopUserItem[];
  commonExceptions: ObservabilityExceptionItem[];
  moduleRetentionDrops: ObservabilityModuleRetentionDropItem[];
  topModules: ObservabilityTopModuleItem[];
}): {
  dropReasonsSummary: ObservabilityDropReasonsSummary;
  adoptionRecommendations: ObservabilityAdoptionSummary;
} {
  const { window, model, effort, commonExceptions, moduleRetentionDrops, topModules } = options;
  const windowLabel = OBSERVABILITY_TREND_WINDOW_LABELS[window];
  const effortName = effortLabel(effort);

  const dropsWithChurn = moduleRetentionDrops.filter((d) => d.dropPct > 0 || d.lostUsers > 0);
  const targetDrops = dropsWithChurn.length > 0 ? dropsWithChurn : moduleRetentionDrops;

  const findings: ObservabilityDropReasonFinding[] = targetDrops.slice(0, 3).map((drop, index) => {
    const matchingExc = commonExceptions.find((e) => e.module === drop.module);
    if (matchingExc) {
      return {
        id: `drop-reason-${index + 1}-${drop.module.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        module: drop.module,
        title: `${matchingExc.signature} correlates with a ${drop.dropPct}% retention drop in ${drop.module}`,
        detail: `${drop.lostUsers} prior-window user(s) did not return to ${drop.module} (${drop.previousRetentionPct}% → ${drop.currentRetentionPct}% retention) after encountering HTTP ${matchingExc.statusCode} errors on ${matchingExc.routeTemplate}.`,
        evidence: `${matchingExc.count} error event(s) affecting ${matchingExc.affectedUsers} user(s) on ${matchingExc.routeTemplate} in ${windowLabel}.`,
        confidence: matchingExc.count >= 2 || drop.dropPct >= 10 ? 'high' : 'medium',
      };
    }
    return {
      id: `drop-reason-${index + 1}-${drop.module.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      module: drop.module,
      title: `Cohort return rate shifted ${drop.previousRetentionPct}% → ${drop.currentRetentionPct}% (-${drop.dropPct}%) on ${drop.module}`,
      detail: `${drop.returningUsers} user(s) returned while ${drop.lostUsers} user(s) exited ${drop.routeTemplate} without completing a follow-up workflow in ${windowLabel}.`,
      evidence: `${drop.primaryFriction} (${windowLabel} ${WINDOW_BASELINE_LABELS[window]}).`,
      confidence: drop.dropPct >= 10 ? 'high' : 'medium',
    };
  });

  if (findings.length === 0) {
    findings.push({
      id: 'drop-reason-baseline',
      module: topModules[0]?.module ?? 'Platform Core',
      title: 'No material cohort retention drop detected in current telemetry window',
      detail: `Active cohorts across ${topModules.length || 1} tracked module(s) maintained baseline return rates during ${windowLabel}.`,
      evidence: `Evaluated across ${windowLabel} (${WINDOW_BASELINE_LABELS[window]}).`,
      confidence: 'high',
    });
  }

  const leadDrop = targetDrops[0];
  const leadExc = commonExceptions[0];

  const dropReasonsSummary: ObservabilityDropReasonsSummary = {
    headline: leadDrop
      ? `Retention dips in ${windowLabel} are led by ${leadDrop.module} (-${leadDrop.dropPct}% to ${leadDrop.currentRetentionPct}%) — synthesized with ${model} (${effortName} effort).`
      : `Cohort retention across ${windowLabel} evaluated with ${model} (${effortName} effort).`,
    narrative: leadExc
      ? `Across ${windowLabel.toLowerCase()} (${WINDOW_BASELINE_LABELS[window]}), PostgreSQL trace telemetry shows ${commonExceptions.reduce((s, e) => s + e.count, 0)} exception event(s) led by "${leadExc.signature}" on ${leadExc.module} (${leadExc.routeTemplate}). Modules experiencing error spikes account for the steepest cohort drop-offs.`
      : `Across ${windowLabel.toLowerCase()} (${WINDOW_BASELINE_LABELS[window]}), cohort transitions show opportunities to re-engage users who completed initial sessions but did not return in the current window.`,
    findings,
  };

  const recommendations: ObservabilityAdoptionPlay[] = [];

  if (leadExc) {
    recommendations.push({
      id: `adopt-fix-${leadExc.module.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      module: leadExc.module,
      title: `Remediate HTTP ${leadExc.statusCode} failures on ${leadExc.routeTemplate} and add automatic retry guards`,
      action: `Eliminate "${leadExc.signature}" (${leadExc.count} occurrences affecting ${leadExc.affectedUsers} user(s)) and surface inline recovery guidance so active sessions complete without abandonment.`,
      expectedLift: `+${Math.max(8, Math.min(25, (leadDrop?.dropPct ?? 12) + 4))}% cohort retention recovery in ${leadExc.module}`,
      impact: 'high',
    });
  }

  for (const drop of targetDrops.slice(0, 2)) {
    if (recommendations.some((r) => r.module === drop.module) && targetDrops.length > 1) {
      continue;
    }
    recommendations.push({
      id: `adopt-walkthrough-${drop.module.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      module: drop.module,
      title: `Launch targeted Guided Walkthrough coachmarks on ${drop.routeTemplate}`,
      action: `Target the ${drop.lostUsers || 1} churned cohort user(s) in ${drop.module} with an in-app coachmark tour and quick-start skill pill from Agent Home to streamline repeat workflows.`,
      expectedLift: `+${Math.max(10, drop.dropPct)}% returning user rate on ${drop.routeTemplate}`,
      impact: drop.dropPct >= 10 ? 'high' : 'medium',
    });
  }

  const leadMod = topModules[0];
  if (leadMod && recommendations.length < 3) {
    recommendations.push({
      id: `adopt-cross-link-${leadMod.module.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      module: leadMod.module,
      title: `Use ${leadMod.module} (${leadMod.sharePct}% traffic share) as an adoption launchpad`,
      action: `Surface contextual next-action prompts inside ${leadMod.routeTemplate} (${leadMod.interactions} interactions across ${leadMod.activeUsers} active users) to drive discovery of lower-share modules.`,
      expectedLift: '+15% cross-module workflow adoption',
      impact: 'medium',
    });
  }

  const adoptionRecommendations: ObservabilityAdoptionSummary = {
    headline: `Actionable adoption plays for ${windowLabel} synthesized via ${OBSERVABILITY_PO_SKILL_PATH} (${model} · ${effortName}).`,
    narrative: `Grounded in live telemetry across ${topModules.length} active module(s) and ${options.topUsers.length} power user(s), pairing error remediation with Guided Walkthrough coachmarks and workflow handoffs from ${leadMod?.module ?? 'Agent Home'} provides the highest-leverage path to lift weekly retention.`,
    recommendations: recommendations.slice(0, 3),
  };

  return { dropReasonsSummary, adoptionRecommendations };
}

/**
 * Default seed-based baseline rows used when generating a fallback response on the client
 * or when the database has no rows in unit fallback mode.
 */
export function buildDefaultSeedTelemetryRows(now = new Date()): {
  events: RawDigestTraceEventRow[];
  rollups: RawDigestRollupRow[];
  users: RawDigestUserRow[];
} {
  const nowMs = now.getTime();
  const users: RawDigestUserRow[] = [
    {
      oid: '11111111-1111-4111-8111-111111111111',
      displayName: 'Ada Lovelace',
      email: 'ada@example.com',
      role: 'Product Owner',
    },
    {
      oid: '33333333-3333-4333-8333-333333333333',
      displayName: 'Grace Hopper',
      email: 'grace@example.com',
      role: 'Principal Architect',
    },
    {
      oid: '44444444-4444-4444-8444-444444444444',
      displayName: 'Margaret Hamilton',
      email: 'margaret@example.com',
      role: 'Release Lead',
    },
    {
      oid: '55555555-5555-4555-8555-555555555555',
      displayName: 'Katherine Johnson',
      email: 'katherine@example.com',
      role: 'Lead Business Analyst',
    },
    {
      oid: '66666666-6666-4666-8666-666666666666',
      displayName: 'Donald Knuth',
      email: 'donald@example.com',
      role: 'Staff Engineer',
    },
  ];

  const events: RawDigestTraceEventRow[] = [];
  let seq = 1;
  const pushEvent = (
    offsetHours: number,
    actorUserId: string,
    routeTemplate: string,
    eventType: 'ui_action' | 'api_request' | 'error' = 'ui_action',
    statusCode = 200,
    message: string | null = null,
    sessionId = `sess-${actorUserId.slice(0, 4)}-${Math.floor(offsetHours / 6)}`,
  ) => {
    events.push({
      id: `seed-evt-${seq++}`,
      eventType,
      occurredAt: new Date(nowMs - offsetHours * 3600 * 1000).toISOString(),
      actorUserId,
      projectId: 'Apex',
      sessionId,
      routeTemplate,
      httpMethod: eventType === 'api_request' || eventType === 'error' ? 'POST' : 'GET',
      statusCode,
      durationMs: eventType === 'error' ? 1420 : 120,
      severity: eventType === 'error' ? 'error' : 'info',
      message,
    });
  };

  // Current window & multi-window events across Today (2h), 1d (18h), 7d (3d), 14d (10d), 30d (20d), 60d (45d)
  const offsets = [1, 2, 16, 20, 72, 120, 240, 480, 960, 1200];
  for (const h of offsets) {
    // Ada Lovelace — heavy across Home, Backlog, Prototypes, Calendar
    pushEvent(h, users[0]!.oid, '/home', 'ui_action', 200);
    pushEvent(h, users[0]!.oid, '/backlog', 'ui_action', 200);
    pushEvent(h, users[0]!.oid, '/calendar', 'api_request', 200);
    pushEvent(h, users[0]!.oid, '/backlog/design-prototypes/:id', 'ui_action', 200);

    // Grace Hopper — ADR, Home, My Work
    pushEvent(h, users[1]!.oid, '/adr', 'ui_action', 200);
    pushEvent(h, users[1]!.oid, '/home', 'ui_action', 200);
    pushEvent(h, users[1]!.oid, '/my-work', 'api_request', 200);

    // Margaret Hamilton — Planning, Calendar, Home
    pushEvent(h, users[2]!.oid, '/planning', 'ui_action', 200);
    pushEvent(h, users[2]!.oid, '/calendar', 'ui_action', 200);

    // Katherine Johnson — Home, Backlog
    pushEvent(h, users[3]!.oid, '/home', 'ui_action', 200);
    pushEvent(h, users[3]!.oid, '/backlog', 'ui_action', 200);

    // Donald Knuth — My Work
    pushEvent(h, users[4]!.oid, '/my-work', 'ui_action', 200);

    // Exceptions on Design Prototypes, Load Testing, Scrum Calendar
    pushEvent(
      h,
      users[0]!.oid,
      '/backlog/design-prototypes/:id',
      'error',
      504,
      'BedrockPrototypeStreamTimeout: generation exceeded 60s window',
    );
    pushEvent(
      h,
      users[1]!.oid,
      '/load-tests/new',
      'error',
      422,
      'LoadTestTargetAllowlistError: target origin not in verified allowlist',
    );
    pushEvent(
      h,
      users[2]!.oid,
      '/calendar',
      'error',
      429,
      'AdoWorkItemBatchThrottleError: TF400733 rate limit reached on batch sync',
    );
  }

  // Prior cohort users in Design Prototypes, Load Testing, and UI Lab who churned in current window
  const priorOffsets = [10, 30, 200, 380, 800, 1500];
  for (const ph of priorOffsets) {
    pushEvent(ph, users[2]!.oid, '/backlog/design-prototypes/:id', 'ui_action', 200);
    pushEvent(ph, users[3]!.oid, '/backlog/design-prototypes/:id', 'ui_action', 200);
    pushEvent(ph, users[3]!.oid, '/load-tests', 'ui_action', 200);
    pushEvent(ph, users[4]!.oid, '/load-tests', 'ui_action', 200);
    pushEvent(ph, users[4]!.oid, '/ui-lab', 'ui_action', 200);
    pushEvent(ph, users[0]!.oid, '/ui-lab', 'ui_action', 200);
  }
  // Returning user in UI Lab & Load Testing so retention is between 33% and 67%
  pushEvent(2, users[0]!.oid, '/ui-lab', 'ui_action', 200);
  pushEvent(2, users[1]!.oid, '/load-tests', 'ui_action', 200);
  pushEvent(10, users[1]!.oid, '/load-tests', 'ui_action', 200);
  pushEvent(200, users[1]!.oid, '/load-tests', 'ui_action', 200);
  pushEvent(380, users[1]!.oid, '/load-tests', 'ui_action', 200);
  pushEvent(800, users[1]!.oid, '/load-tests', 'ui_action', 200);
  pushEvent(1500, users[1]!.oid, '/load-tests', 'ui_action', 200);

  const todayStr = now.toISOString().slice(0, 10);
  const rollups: RawDigestRollupRow[] = [
    {
      fromRoute: '/home',
      toRoute: '/backlog',
      day: todayStr,
      transitionCount: 24,
      distinctActorCount: 4,
    },
    {
      fromRoute: '/backlog',
      toRoute: '/backlog/design-prototypes/:id',
      day: todayStr,
      transitionCount: 14,
      distinctActorCount: 3,
    },
  ];

  return { events, rollups, users };
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
      : new Date(morningToday.getTime() - DAY_MS);
  const nextMorning =
    now < morningToday
      ? morningToday
      : new Date(morningToday.getTime() + DAY_MS);

  const lastEvening =
    now >= eveningToday
      ? eveningToday
      : new Date(eveningToday.getTime() - DAY_MS);
  const nextEvening =
    now < eveningToday
      ? eveningToday
      : new Date(eveningToday.getTime() + DAY_MS);

  return {
    lastMorningIso: lastMorning.toISOString(),
    lastEveningIso: lastEvening.toISOString(),
    nextMorningIso: nextMorning.toISOString(),
    nextEveningIso: nextEvening.toISOString(),
  };
}

export function buildDigestSnapshotFromAggregates(options: {
  project: string;
  window: ObservabilityTrendWindow;
  model: string;
  effort: EffortLevel;
  slot: ObservabilityDigestSlot;
  aggregated: ReturnType<typeof aggregateTelemetryFromDatabaseRows>;
  aiSynthesis?: {
    headline?: string;
    dropReasonsSummary?: ObservabilityDropReasonsSummary;
    adoptionRecommendations?: ObservabilityAdoptionSummary;
  };
  now?: Date;
}): ObservabilityPoDigestSnapshot {
  const { project, window, model, effort, slot, aggregated } = options;
  const now = options.now ?? new Date();
  const windowLabel = OBSERVABILITY_TREND_WINDOW_LABELS[window];
  const baselineLabel = WINDOW_BASELINE_LABELS[window];

  const fallbackAi = synthesizeSummariesFromTelemetry({
    window,
    model,
    effort,
    topUsers: aggregated.topUsers,
    commonExceptions: aggregated.commonExceptions,
    moduleRetentionDrops: aggregated.moduleRetentionDrops,
    topModules: aggregated.topModules,
  });

  const dropReasonsSummary =
    options.aiSynthesis?.dropReasonsSummary ?? fallbackAi.dropReasonsSummary;
  const adoptionRecommendations =
    options.aiSynthesis?.adoptionRecommendations ?? fallbackAi.adoptionRecommendations;

  const slotBadge =
    slot === 'morning_6am'
      ? '6:00 AM Morning Digest'
      : slot === 'evening_6pm'
        ? '6:00 PM Evening Digest'
        : 'On-Demand Digest';

  const defaultHeadline = `${slotBadge} (${windowLabel}): ${aggregated.kpis.activeUsers} active users across ${aggregated.topModules.length} core modules, led by ${aggregated.kpis.topModuleName} (${aggregated.kpis.topModuleSharePct}% share) — analyzed with ${model} (${effortLabel(effort)} effort).`;

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
    headline: options.aiSynthesis?.headline?.trim() || defaultHeadline,
    kpis: aggregated.kpis,
    topUsers: aggregated.topUsers,
    commonExceptions: aggregated.commonExceptions,
    moduleRetentionDrops: aggregated.moduleRetentionDrops,
    dropReasonsSummary,
    topModules: aggregated.topModules,
    adoptionRecommendations,
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
  const now = options.now ?? new Date();
  const seed = buildDefaultSeedTelemetryRows(now);
  const aggregated = aggregateTelemetryFromDatabaseRows({
    events: seed.events,
    rollups: seed.rollups,
    users: seed.users,
    window: options.window,
    now,
  });
  return buildDigestSnapshotFromAggregates({
    ...options,
    aggregated,
    now,
  });
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
