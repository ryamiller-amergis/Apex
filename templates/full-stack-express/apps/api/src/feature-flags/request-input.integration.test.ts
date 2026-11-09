import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createLocalFlagEvaluator, type FlagEvaluator } from './index.ts';

const silentLogger = { warn: () => undefined };

// Test-only route factory: receives the evaluator the way a route factory in the
// composition root does, reads the flag once, and branches once.
function createGatedRouter(flags: FlagEvaluator): express.Router {
  const router = express.Router();
  router.all('/gated', (_req, res) => {
    const behavior = flags.isEnabled('checkout-v2', false) ? 'new' : 'existing';
    res.json({ behavior });
  });
  return router;
}

function buildApp(source: string): express.Express {
  const app = express();
  app.use(express.json());
  app.use(
    createGatedRouter(
      createLocalFlagEvaluator({ source, logger: silentLogger })
    )
  );
  return app;
}

async function crafted(app: express.Express, value: 'true' | 'false') {
  const flag = { 'checkout-v2': value === 'true' };
  return [
    await request(app).get(`/gated?checkout-v2=${value}`),
    await request(app).get(`/gated?FEATURE_FLAGS=${JSON.stringify(flag)}`),
    await request(app)
      .get('/gated')
      .set('x-feature-flag-checkout-v2', value)
      .set('x-feature-flags', JSON.stringify(flag)),
    await request(app).get('/gated').set('Cookie', `checkout-v2=${value}`),
    await request(app).post('/gated').send(flag),
    await request(app).post('/gated').send({ FEATURE_FLAGS: flag }),
  ];
}

describe('flag evaluation through the HTTP stack', () => {
  it('VT-08 PBI-016 AC-0 NFR-security request input cannot turn a configured-on flag off', async () => {
    const app = buildApp('{"checkout-v2":true}');

    expect((await request(app).get('/gated')).body).toEqual({
      behavior: 'new',
    });
    for (const response of await crafted(app, 'false')) {
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ behavior: 'new' });
    }
  });

  it('VT-08 PBI-016 AC-2 NFR-security request input cannot turn an undefined flag on', async () => {
    const app = buildApp('{}');

    expect((await request(app).get('/gated')).body).toEqual({
      behavior: 'existing',
    });
    for (const response of await crafted(app, 'true')) {
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ behavior: 'existing' });
    }
  });
});
