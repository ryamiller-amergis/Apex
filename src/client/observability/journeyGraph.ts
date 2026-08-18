/**
 * FEAT-009 — deterministic Journey Map layout, route-template guards,
 * and aggregation of FEAT-005 daily rollup pages into a graph view model.
 */
import {
  JOURNEY_CANVAS_EDGE_LIMIT,
  JOURNEY_DEFAULT_MIN_TRANSITIONS,
  OBSERVABILITY_RAW_RETENTION_DAYS,
  type JourneyEdge,
  type JourneyEdgePage,
  type JourneyEdgeView,
  type JourneyMapFilters,
  type JourneyMapResponse,
  type JourneyMinTransitions,
  type JourneyNode,
} from '../../shared/types/observability';

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NUMERIC_SEGMENT = /^\d+$/;

export class JourneyNormalizationError extends Error {
  readonly code = 'JOURNEY_INVALID_ROUTE';

  constructor(readonly route: string) {
    super('Journey response contained a non-normalized route template');
    this.name = 'JourneyNormalizationError';
  }
}

export function isNormalizedRouteTemplate(value: string): boolean {
  if (!value.startsWith('/') || value.includes('?') || value.includes('#')) return false;
  if (/\s/.test(value)) return false;
  if (value.length > 1 && value.endsWith('/')) return false;
  const segments = value.split('/').filter(Boolean);
  return segments.every((segment) => {
    if (segment.startsWith(':')) return /^:[A-Za-z0-9_]+$/.test(segment);
    return !UUID_SEGMENT.test(segment) && !NUMERIC_SEGMENT.test(segment);
  });
}

export function routeStableKey(route: string): string {
  const encoded = route.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');
  return encoded || 'root';
}

export function edgeStableKey(fromRoute: string, toRoute: string): string {
  return `${routeStableKey(fromRoute)}--${routeStableKey(toRoute)}`;
}

export function toUtcDay(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value.slice(0, 10);
  return new Date(parsed).toISOString().slice(0, 10);
}

export function dayToRangeStart(day: string): string {
  return `${toUtcDay(day)}T00:00:00.000Z`;
}

export function dayToRangeEnd(day: string): string {
  return `${toUtcDay(day)}T23:59:59.999Z`;
}

export function addUtcDays(day: string, delta: number): string {
  const date = new Date(`${toUtcDay(day)}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

export function journeyCoverageWindow(nowMs = Date.now()): { availableFrom: string; availableTo: string } {
  const availableTo = new Date(nowMs).toISOString().slice(0, 10);
  return {
    availableFrom: addUtcDays(availableTo, -(OBSERVABILITY_RAW_RETENTION_DAYS - 1)),
    availableTo,
  };
}

export function defaultJourneyFilters(nowMs = Date.now()): JourneyMapFilters {
  const { availableFrom, availableTo } = journeyCoverageWindow(nowMs);
  return {
    from: availableFrom,
    to: availableTo,
    minTransitions: JOURNEY_DEFAULT_MIN_TRANSITIONS,
  };
}

export function rangeForPreset(
  preset: '7d' | '30d',
  nowMs = Date.now(),
): { from: string; to: string } {
  const { availableFrom, availableTo } = journeyCoverageWindow(nowMs);
  if (preset === '30d') return { from: availableFrom, to: availableTo };
  return { from: addUtcDays(availableTo, -6), to: availableTo };
}

export function isRangeWithinCoverage(
  from: string,
  to: string,
  availableFrom: string,
  availableTo: string,
): boolean {
  const fromDay = toUtcDay(from);
  const toDay = toUtcDay(to);
  return fromDay <= toDay && fromDay >= availableFrom && toDay <= availableTo;
}

export function selectCanvasEdges<T extends { transitionCount: number; fromRoute: string; toRoute: string }>(
  edges: T[],
  limit = JOURNEY_CANVAS_EDGE_LIMIT,
): T[] {
  return [...edges]
    .sort((a, b) => {
      if (b.transitionCount !== a.transitionCount) return b.transitionCount - a.transitionCount;
      const fromCmp = a.fromRoute.localeCompare(b.fromRoute);
      if (fromCmp !== 0) return fromCmp;
      return a.toRoute.localeCompare(b.toRoute);
    })
    .slice(0, limit);
}

function edgePairKey(fromRoute: string, toRoute: string): string {
  return `${fromRoute}\0${toRoute}`;
}

function sortEdges(edges: JourneyEdge[]): JourneyEdge[] {
  return [...edges].sort((a, b) => {
    if (b.transitionCount !== a.transitionCount) return b.transitionCount - a.transitionCount;
    const fromCmp = a.fromRoute.localeCompare(b.fromRoute);
    if (fromCmp !== 0) return fromCmp;
    return a.toRoute.localeCompare(b.toRoute);
  });
}

function sortNodes(nodes: JourneyNode[]): JourneyNode[] {
  return [...nodes].sort((a, b) => a.routeTemplate.localeCompare(b.routeTemplate));
}

export function toJourneyMapView(
  pages: JourneyEdgePage[],
  filters: JourneyMapFilters,
  generatedAt: string,
  coverage = journeyCoverageWindow(Date.parse(generatedAt) || Date.now()),
): JourneyMapResponse {
  const daily: JourneyEdgeView[] = pages.flatMap((page) => page.items);
  for (const row of daily) {
    if (!isNormalizedRouteTemplate(row.fromRoute)) throw new JourneyNormalizationError(row.fromRoute);
    if (!isNormalizedRouteTemplate(row.toRoute)) throw new JourneyNormalizationError(row.toRoute);
  }

  const grouped = new Map<string, JourneyEdge>();
  for (const row of daily) {
    const key = edgePairKey(row.fromRoute, row.toRoute);
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        fromRoute: row.fromRoute,
        toRoute: row.toRoute,
        transitionCount: row.transitionCount,
        distinctActorCount: row.distinctActorCount,
        lastSeen: row.day,
      });
      continue;
    }
    existing.transitionCount += row.transitionCount;
    existing.distinctActorCount = Math.max(existing.distinctActorCount, row.distinctActorCount);
    if (row.day > existing.lastSeen) existing.lastSeen = row.day;
  }

  const minTransitions: JourneyMinTransitions = filters.minTransitions;
  const edges = sortEdges(
    [...grouped.values()].filter((edge) => edge.transitionCount >= minTransitions),
  );

  const nodeAcc = new Map<string, JourneyNode>();
  const bump = (routeTemplate: string, transitionCount: number, distinctActorCount: number) => {
    const current = nodeAcc.get(routeTemplate);
    if (!current) {
      nodeAcc.set(routeTemplate, { routeTemplate, transitionCount, distinctActorCount });
      return;
    }
    current.transitionCount += transitionCount;
    current.distinctActorCount = Math.max(current.distinctActorCount, distinctActorCount);
  };
  for (const edge of edges) {
    bump(edge.fromRoute, edge.transitionCount, edge.distinctActorCount);
    bump(edge.toRoute, edge.transitionCount, edge.distinctActorCount);
  }

  const truncated = pages.some((page) => page.capReached);
  const lastSeen = edges.reduce((max, edge) => (edge.lastSeen > max ? edge.lastSeen : max), filters.from);

  return {
    generatedAt,
    rollupThrough: dayToRangeEnd(lastSeen),
    availableFrom: coverage.availableFrom,
    availableTo: coverage.availableTo,
    range: { from: toUtcDay(filters.from), to: toUtcDay(filters.to) },
    machineTransitionsExcluded: true,
    truncated,
    nodes: sortNodes([...nodeAcc.values()]),
    edges,
  };
}

export interface JourneyLayoutViewport {
  width: number;
  height: number;
}

export interface JourneyLayoutNode extends JourneyNode {
  x: number;
  y: number;
  r: number;
}

export interface JourneyLayoutEdge extends JourneyEdge {
  self: boolean;
  path: string;
  labelX: number;
  labelY: number;
}

export interface JourneyGraphLayout {
  width: number;
  height: number;
  nodes: JourneyLayoutNode[];
  edges: JourneyLayoutEdge[];
}

function nodeRadius(transitionCount: number): number {
  return Math.max(12, Math.min(28, 10 + Math.log10(Math.max(transitionCount, 1)) * 8));
}

function assignLayers(nodeIds: string[], edges: Array<{ fromRoute: string; toRoute: string }>): string[][] {
  const remaining = new Set(nodeIds);
  const incoming = new Map<string, Set<string>>();
  const outgoing = new Map<string, Set<string>>();
  for (const id of nodeIds) {
    incoming.set(id, new Set());
    outgoing.set(id, new Set());
  }
  for (const edge of edges) {
    if (edge.fromRoute === edge.toRoute) continue;
    incoming.get(edge.toRoute)?.add(edge.fromRoute);
    outgoing.get(edge.fromRoute)?.add(edge.toRoute);
  }

  const layers: string[][] = [];
  const placed = new Set<string>();

  const nextFrontier = (): string[] => {
    const ready = [...remaining]
      .filter((id) => [...(incoming.get(id) ?? [])].every((src) => placed.has(src) || !remaining.has(src)))
      .sort((a, b) => a.localeCompare(b));
    if (ready.length > 0) return ready;
    return [...remaining].sort((a, b) => a.localeCompare(b)).slice(0, 1);
  };

  while (remaining.size > 0) {
    const layer = nextFrontier();
    layers.push(layer);
    for (const id of layer) {
      remaining.delete(id);
      placed.add(id);
    }
  }

  return layers;
}

export function layoutJourneyGraph(
  nodes: JourneyNode[],
  edges: JourneyEdge[],
  viewport: JourneyLayoutViewport = { width: 960, height: 480 },
): JourneyGraphLayout {
  const nodeCopy = nodes.map((node) => ({ ...node }));
  const edgeCopy = edges.map((edge) => ({ ...edge }));
  const canvasEdges = selectCanvasEdges(edgeCopy);
  const nodeIds = [...new Set([
    ...nodeCopy.map((node) => node.routeTemplate),
    ...canvasEdges.flatMap((edge) => [edge.fromRoute, edge.toRoute]),
  ])].sort((a, b) => a.localeCompare(b));

  const layers = assignLayers(nodeIds, canvasEdges);
  const layerCount = Math.max(layers.length, 1);
  const xGap = viewport.width / (layerCount + 1);
  const positions = new Map<string, { x: number; y: number }>();

  layers.forEach((layer, layerIndex) => {
    const yGap = viewport.height / (layer.length + 1);
    layer.forEach((id, index) => {
      positions.set(id, {
        x: xGap * (layerIndex + 1),
        y: yGap * (index + 1),
      });
    });
  });

  const nodeByRoute = new Map(nodeCopy.map((node) => [node.routeTemplate, node]));
  const layoutNodes: JourneyLayoutNode[] = nodeIds.map((id) => {
    const source = nodeByRoute.get(id) ?? { routeTemplate: id, transitionCount: 0, distinctActorCount: 0 };
    const pos = positions.get(id) ?? { x: viewport.width / 2, y: viewport.height / 2 };
    return {
      ...source,
      x: pos.x,
      y: pos.y,
      r: nodeRadius(source.transitionCount),
    };
  });

  const layoutEdges: JourneyLayoutEdge[] = canvasEdges.map((edge) => {
    const from = positions.get(edge.fromRoute) ?? { x: 0, y: 0 };
    const to = positions.get(edge.toRoute) ?? { x: 0, y: 0 };
    const self = edge.fromRoute === edge.toRoute;
    if (self) {
      const r = 36;
      const path = `M ${from.x} ${from.y - 12} C ${from.x + r} ${from.y - r}, ${from.x + r} ${from.y + r}, ${from.x} ${from.y + 12}`;
      return {
        ...edge,
        self,
        path,
        labelX: from.x + r + 8,
        labelY: from.y,
      };
    }
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const cx = (from.x + to.x) / 2 - dy * 0.12;
    const cy = (from.y + to.y) / 2 + dx * 0.12;
    const path = `M ${from.x} ${from.y} Q ${cx} ${cy} ${to.x} ${to.y}`;
    return {
      ...edge,
      self,
      path,
      labelX: cx,
      labelY: cy,
    };
  });

  return {
    width: viewport.width,
    height: viewport.height,
    nodes: layoutNodes,
    edges: layoutEdges,
  };
}
