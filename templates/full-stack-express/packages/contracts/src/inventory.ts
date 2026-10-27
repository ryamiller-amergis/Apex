import { routeKey, routeList, type RouteLocation } from './registry.ts';

export interface RouteInventoryResult {
  readonly ok: boolean;
  readonly undocumented: string[];
  readonly unimplemented: string[];
}

export function compareRouteInventory(
  registered: readonly RouteLocation[],
  documented: readonly RouteLocation[] = routeList
): RouteInventoryResult {
  if (registered.length === 0) {
    throw new Error(
      'compareRouteInventory: no registered routes were found; route discovery is broken'
    );
  }
  const actual = new Set(registered.map(routeKey));
  const expected = new Set(documented.map(routeKey));
  const undocumented = [...actual].filter((key) => !expected.has(key)).sort();
  const unimplemented = [...expected].filter((key) => !actual.has(key)).sort();
  return {
    ok: undocumented.length === 0 && unimplemented.length === 0,
    undocumented,
    unimplemented,
  };
}
