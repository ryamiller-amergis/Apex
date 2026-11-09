import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  compareRouteInventory,
  routeKey,
  routeList,
} from '@project-scope/contracts';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { buildTestApp } from '../../test/support/testApp.ts';
import { listRegisteredRoutes, mountedAt } from './inventory.ts';

describe('route inventory (VT-28)', () => {
  it('VT-28 TBI-015 DoD-0 the app registers exactly the four contract operations', () => {
    const { app } = buildTestApp();
    const registered = listRegisteredRoutes(app);
    expect(registered.map(routeKey).sort()).toEqual(
      routeList.map(routeKey).sort()
    );
    expect(compareRouteInventory(registered)).toEqual({
      ok: true,
      undocumented: [],
      unimplemented: [],
    });
  });

  it('VT-28 the built client fallback is not reported as an API route', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'client-dist-'));
    try {
      writeFileSync(path.join(dir, 'index.html'), '<!doctype html>');
      const { app } = buildTestApp({ deps: { clientDistDir: dir } });
      expect(compareRouteInventory(listRegisteredRoutes(app)).ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('VT-28 an extra route shows up as undocumented', () => {
    const { app } = buildTestApp();
    const extra = mountedAt(express.Router(), '/api/v1');
    extra.get('/debug', (_req, res) => {
      res.end();
    });
    app.use('/api/v1', extra);
    expect(compareRouteInventory(listRegisteredRoutes(app))).toEqual({
      ok: false,
      undocumented: ['GET /api/v1/debug'],
      unimplemented: [],
    });
  });

  it('throws when a router is mounted without a recorded prefix', () => {
    const { app } = buildTestApp();
    const anonymous = express.Router();
    anonymous.get('/x', (_req, res) => {
      res.end();
    });
    app.use('/somewhere', anonymous);
    expect(() => listRegisteredRoutes(app)).toThrow(/mountedAt/);
  });
});
