import {
  JOURNEY_CANVAS_EDGE_LIMIT,
  type JourneyEdge,
  type JourneyEdgePage,
  type JourneyNode,
} from '../../../shared/types/observability';
import {
  JourneyNormalizationError,
  defaultJourneyFilters,
  edgeStableKey,
  isNormalizedRouteTemplate,
  isRangeWithinCoverage,
  journeyCoverageWindow,
  layoutJourneyGraph,
  rangeForPreset,
  selectCanvasEdges,
  toJourneyMapView,
} from '../journeyGraph';

function node(routeTemplate: string, transitionCount = 10): JourneyNode {
  return { routeTemplate, transitionCount, distinctActorCount: 3 };
}

function edge(fromRoute: string, toRoute: string, transitionCount = 10, lastSeen = '2026-08-17'): JourneyEdge {
  return { fromRoute, toRoute, transitionCount, distinctActorCount: 2, lastSeen };
}

function page(items: JourneyEdgePage['items'], capReached = false): JourneyEdgePage {
  return { items, nextCursor: null, capReached };
}

describe('journey route normalization (PBI-007 AC-3 / VT-08)', () => {
  it('accepts canonical route templates', () => {
    expect(isNormalizedRouteTemplate('/home')).toBe(true);
    expect(isNormalizedRouteTemplate('/users/edit/:id')).toBe(true);
    expect(isNormalizedRouteTemplate('/')).toBe(true);
  });

  it('rejects query strings, fragments, blanks, and concrete identifiers', () => {
    expect(isNormalizedRouteTemplate('/users?id=12')).toBe(false);
    expect(isNormalizedRouteTemplate('/users#tab')).toBe(false);
    expect(isNormalizedRouteTemplate('home')).toBe(false);
    expect(isNormalizedRouteTemplate('/users/11111111-1111-4111-8111-111111111111')).toBe(false);
    expect(isNormalizedRouteTemplate('/users/42')).toBe(false);
  });
});

describe('toJourneyMapView (PBI-007 AC-0 / AC-3 / VT-02 / VT-08)', () => {
  const filters = { from: '2026-08-01', to: '2026-08-17', minTransitions: 1 as const };

  it('aggregates daily rollup rows into range edges and nodes without actor identifiers', () => {
    const result = toJourneyMapView(
      [
        page([
          { day: '2026-08-16', fromRoute: '/home', toRoute: '/calendar', transitionCount: 10, distinctActorCount: 4 },
          { day: '2026-08-17', fromRoute: '/home', toRoute: '/calendar', transitionCount: 5, distinctActorCount: 6 },
        ]),
      ],
      filters,
      '2026-08-17T18:00:00.000Z',
      { availableFrom: '2026-07-19', availableTo: '2026-08-17' },
    );

    expect(result.machineTransitionsExcluded).toBe(true);
    expect(result.edges).toEqual([
      expect.objectContaining({
        fromRoute: '/home',
        toRoute: '/calendar',
        transitionCount: 15,
        distinctActorCount: 6,
        lastSeen: '2026-08-17',
      }),
    ]);
    expect(result.nodes.map((item) => item.routeTemplate)).toEqual(['/calendar', '/home']);
    expect(JSON.stringify(result)).not.toMatch(/actorId|email|@/);
  });

  it('fails closed when a malformed backend fixture includes a query string or concrete route', () => {
    expect(() =>
      toJourneyMapView(
        [page([{ day: '2026-08-17', fromRoute: '/users?id=1', toRoute: '/home', transitionCount: 1, distinctActorCount: 1 }])],
        filters,
        '2026-08-17T18:00:00.000Z',
      ),
    ).toThrow(JourneyNormalizationError);

    expect(() =>
      toJourneyMapView(
        [page([{ day: '2026-08-17', fromRoute: '/home', toRoute: '/users/42', transitionCount: 1, distinctActorCount: 1 }])],
        filters,
        '2026-08-17T18:00:00.000Z',
      ),
    ).toThrow(JourneyNormalizationError);
  });

  it('applies the minimum-transition filter after aggregation', () => {
    const result = toJourneyMapView(
      [
        page([
          { day: '2026-08-17', fromRoute: '/home', toRoute: '/calendar', transitionCount: 40, distinctActorCount: 8 },
          { day: '2026-08-17', fromRoute: '/home', toRoute: '/profile', transitionCount: 60, distinctActorCount: 9 },
        ]),
      ],
      { ...filters, minTransitions: 50 },
      '2026-08-17T18:00:00.000Z',
    );
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]?.toRoute).toBe('/profile');
  });
});

describe('layoutJourneyGraph (TBI-011 DoD-0 / VT-01 / VT-07)', () => {
  it('returns deterministic coordinates and does not mutate inputs', () => {
    const nodes = [node('/a', 80), node('/b', 40), node('/c', 20)];
    const edges = [edge('/a', '/b', 80), edge('/b', '/c', 40), edge('/c', '/a', 12)];
    const snapshot = JSON.parse(JSON.stringify({ nodes, edges })) as { nodes: JourneyNode[]; edges: JourneyEdge[] };

    const first = layoutJourneyGraph(nodes, edges);
    const second = layoutJourneyGraph(nodes, edges);

    expect(first).toEqual(second);
    expect(nodes).toEqual(snapshot.nodes);
    expect(edges).toEqual(snapshot.edges);
    expect(first.nodes.map((item) => item.routeTemplate)).toEqual(['/a', '/b', '/c']);
  });

  it('places disconnected nodes, cycles, and self-edges', () => {
    const layout = layoutJourneyGraph(
      [node('/home'), node('/orphan'), node('/loop')],
      [edge('/home', '/home', 9), edge('/home', '/loop', 4)],
    );
    expect(layout.nodes).toHaveLength(3);
    expect(layout.edges.some((item) => item.self && item.fromRoute === '/home')).toBe(true);
    expect(layout.nodes.find((item) => item.routeTemplate === '/orphan')).toBeDefined();
  });

  it('limits canvas edges to the 100 highest-volume relationships', () => {
    const edges = Array.from({ length: 140 }, (_, index) =>
      edge('/home', `/feature-requests`, 140 - index, '2026-08-17'),
    ).map((item, index) => ({ ...item, toRoute: `/n/${index}` }));
    const validEdges = edges.map((item) => ({ ...item, toRoute: `/item/:id` }));
    // unique destinations so selectCanvasEdges keeps distinct pairs
    const unique = edges.map((item, index) => ({
      ...item,
      toRoute: `/r${index}`,
    }));
    expect(selectCanvasEdges(unique)).toHaveLength(JOURNEY_CANVAS_EDGE_LIMIT);
    expect(selectCanvasEdges(unique)[0]?.transitionCount).toBe(140);
    expect(validEdges[0]?.fromRoute).toBe('/home');
  });
});

describe('journey coverage presets (PBI-007 AC-0)', () => {
  const now = Date.parse('2026-08-17T18:00:00.000Z');

  it('advertises only 30-day coverage and default min-50 filters', () => {
    expect(journeyCoverageWindow(now)).toEqual({ availableFrom: '2026-07-19', availableTo: '2026-08-17' });
    expect(defaultJourneyFilters(now)).toEqual({
      from: '2026-07-19',
      to: '2026-08-17',
      minTransitions: 50,
    });
    expect(rangeForPreset('7d', now)).toEqual({ from: '2026-08-11', to: '2026-08-17' });
    expect(isRangeWithinCoverage('2026-06-01', '2026-08-17', '2026-07-19', '2026-08-17')).toBe(false);
    expect(isRangeWithinCoverage('2026-07-19', '2026-08-17', '2026-07-19', '2026-08-17')).toBe(true);
  });

  it('builds stable edge keys from route templates', () => {
    expect(edgeStableKey('/users/edit/:id', '/profile')).toBe('users-edit-id--profile');
  });
});
