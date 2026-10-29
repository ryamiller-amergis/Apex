import { describe, expect, it } from 'vitest';
import { compareRouteInventory, routeKey, routeList } from '../src/index.ts';

describe('route inventory comparison (VT-05, PBI-006 AC-3)', () => {
  it('PBI-006 AC-3 reports undocumented and unimplemented routes', () => {
    const result = compareRouteInventory([
      { method: 'GET', path: '/api/v1/me' },
      { method: 'put', path: '/api/v1/me' },
      { method: 'get', path: '/api/v1/debug' },
    ]);
    expect(result).toEqual({
      ok: false,
      undocumented: ['GET /api/v1/debug'],
      unimplemented: ['GET /health/live', 'GET /health/ready'],
    });
  });

  it('PBI-006 AC-3 passes when the registered routes equal the contracts', () => {
    const registered = routeList.map(({ method, path }) => ({ method, path }));
    expect(compareRouteInventory(registered)).toEqual({
      ok: true,
      undocumented: [],
      unimplemented: [],
    });
  });

  it('PBI-006 AC-3 throws when no routes were discovered', () => {
    expect(() => compareRouteInventory([])).toThrow(/no registered routes/);
  });

  it('routeKey upper-cases the method', () => {
    expect(routeKey({ method: 'put', path: '/api/v1/me' })).toBe(
      'PUT /api/v1/me'
    );
  });
});
