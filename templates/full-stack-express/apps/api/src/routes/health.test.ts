import {
  healthLiveSchema,
  healthReadySchema,
  problemContentType,
  problemDetailsSchema,
  problemTypes,
} from '@project-scope/contracts';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createMemoryPersistence } from '../../test/support/memoryPersistence.ts';
import { buildTestApp } from '../../test/support/testApp.ts';

const LEAK = 'postgres://synthetic-user:synthetic-pw@db.internal:5432/app';

function throwingPersistence() {
  const persistence = createMemoryPersistence();
  for (const method of [
    'findBySubject',
    'create',
    'updateBySubject',
    'ping',
  ] as const) {
    persistence.override(method, () => {
      throw new Error(LEAK);
    });
  }
  return persistence;
}

describe('GET /health/live', () => {
  it('VT-15 PBI-012 AC-0 NFR returns ok without touching the database', async () => {
    const persistence = throwingPersistence();
    const { app } = buildTestApp({ persistence });
    const response = await request(app).get('/health/live').expect(200);
    expect(healthLiveSchema.parse(response.body)).toEqual({ status: 'ok' });
    expect(persistence.calls).toEqual([]);
  });
});

describe('GET /health/ready', () => {
  it('VT-16 PBI-012 AC-0 returns ready with no credentials when the database answers', async () => {
    const { app, persistence } = buildTestApp({ principal: null });
    const response = await request(app).get('/health/ready').expect(200);
    expect(healthReadySchema.parse(response.body)).toEqual({
      status: 'ready',
    });
    expect(response.headers['x-request-id']).toBeDefined();
    expect(response.headers['cache-control']).toBe('no-store');
    expect(persistence.calls.map((call) => call.method)).toEqual(['ping']);
  });

  it('VT-17 PBI-012 AC-1 returns 503 not-ready with no connection detail while live stays 200', async () => {
    const { app } = buildTestApp({ persistence: throwingPersistence() });
    const ready = await request(app).get('/health/ready');
    expect(ready.status).toBe(503);
    expect(ready.headers['content-type']).toContain(problemContentType);
    const body = problemDetailsSchema.parse(ready.body);
    expect(body).toEqual({
      type: problemTypes.notReady,
      title: 'Not ready',
      status: 503,
      detail: 'The service is not ready to accept traffic.',
      requestId: ready.headers['x-request-id'],
    });
    for (const fragment of ['postgres', 'db.internal', 'synthetic-pw', '5432']) {
      expect(ready.text).not.toContain(fragment);
    }
    await request(app).get('/health/live').expect(200);
  });

  it('VT-19 PBI-012 AC-2 answers 503 within 500 ms when the ping hangs', async () => {
    const persistence = createMemoryPersistence();
    persistence.override('ping', () => new Promise(() => {}));
    const { app } = buildTestApp({
      persistence,
      deps: { readinessTimeoutMs: 50 },
    });
    const started = Date.now();
    const response = await request(app).get('/health/ready');
    expect(response.status).toBe(503);
    expect(problemDetailsSchema.parse(response.body).type).toBe(
      problemTypes.notReady
    );
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('PBI-012 reports not ready while the process shuts down', async () => {
    const { app } = buildTestApp({ deps: { isShuttingDown: () => true } });
    const response = await request(app).get('/health/ready');
    expect(response.status).toBe(503);
  });
});

describe('probes need no credentials (VT-20)', () => {
  it('VT-20 PBI-012 AC-3 never returns 401 when the adapter rejects everything', async () => {
    const { app, adapter } = buildTestApp({
      principal: () => {
        throw new Error('adapter rejects every request');
      },
    });
    for (const target of ['/health/live', '/health/ready']) {
      const response = await request(app).get(target);
      expect(response.status, target).toBe(200);
    }
    expect(adapter.calls).toBe(0);
    const api = await request(app).get('/api/v1/me');
    expect(api.status).toBe(401);
  });
});
