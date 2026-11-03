import express, { type RequestHandler } from 'express';
import request from 'supertest';

jest.mock('../db/drizzle', () => ({ db: {} }));
jest.mock('../services/telemetry', () => ({ trackEvent: jest.fn(), trackAgentError: jest.fn() }));
jest.mock('../middleware/rbac', () => ({
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  requireProjectAccess: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  resolveRequestProject: (req: { query: { project?: string } }) => req.query.project,
}));

let currentUser = 'creator';
jest.mock('../utils/requestUser', () => ({ getUserId: () => currentUser }));

import { createBrainstormHandoffsRouter, type BrainstormHandoffRouteDeps } from '../routes/brainstormHandoffs';
import { BrainstormHandoffError } from '../services/brainstormHandoffEngine';
import { decideBrainstormAccess, type BrainstormAccessMode } from '../services/brainstormAccessPolicy';
import { BRAINSTORM_CREATE, BRAINSTORM_VIEW } from '../../shared/types/brainstorm';

const SESSION_ID = '70000000-0000-4000-8000-000000000001';
const HANDOFF_ID = '70000000-0000-4000-8000-000000000002';
const PROJECT = 'alpha';
const session = { id: SESSION_ID, project: PROJECT, creatorId: 'creator', state: 'active' as const };

function gate(mode: BrainstormAccessMode): RequestHandler {
  return (req, res, next) => {
    const viewer = {
      id: currentUser,
      isSuperAdmin: false,
      isProjectMember: true,
      permissions: new Set([BRAINSTORM_VIEW, BRAINSTORM_CREATE]),
    };
    const row = req.params.id === SESSION_ID ? session : null;
    const decision = decideBrainstormAccess({ viewer, project: PROJECT, session: row }, mode);
    if (decision.kind === 'refuse') {
      res.status(decision.reason === 'not_found' ? 404 : decision.reason === 'session_not_active' ? 409 : 403).json({ error: decision.reason });
      return;
    }
    (req as unknown as { brainstorm: unknown }).brainstorm = { project: PROJECT, session: row };
    next();
  };
}

function makeEngine() {
  return {
    listActions: jest.fn().mockResolvedValue({ artifactVersion: 3, viewerCanAct: true, actions: [], handoffs: [] }),
    preview: jest.fn().mockResolvedValue({ handoffId: HANDOFF_ID, idempotencyKey: 'key-1', state: 'previewed' }),
    confirm: jest.fn().mockResolvedValue({ handoffId: HANDOFF_ID, state: 'completed', resultRef: { module: 'adr', id: 'a', link: '/adr/a' }, replayed: false }),
    keepStandalone: jest.fn().mockResolvedValue({ handoffId: HANDOFF_ID, state: 'completed', resultRef: { module: 'standalone', id: 'x', link: null }, replayed: false }),
    getHandoff: jest.fn().mockResolvedValue({ handoffId: HANDOFF_ID, state: 'completed' }),
  };
}

function appWith(engine: ReturnType<typeof makeEngine>) {
  const app = express();
  app.use(express.json());
  app.use('/sessions/:id', createBrainstormHandoffsRouter({
    engine: () => engine,
    read: gate('read'),
    mutate: gate('mutate'),
  } as unknown as BrainstormHandoffRouteDeps));
  return app;
}

const base = `/sessions/${SESSION_ID}`;

beforeEach(() => {
  currentUser = 'creator';
});

describe('handoff routes', () => {
  it('lists actions for the viewer', async () => {
    const engine = makeEngine();
    const res = await request(appWith(engine)).get(`${base}/actions`);
    expect(res.status).toBe(200);
    expect(engine.listActions).toHaveBeenCalledWith(session, 'creator');
  });

  it('previews with the action and expected version', async () => {
    const engine = makeEngine();
    const res = await request(appWith(engine)).post(`${base}/handoffs/preview`).send({ actionId: 'create-adr', expectedVersion: 3 });
    expect(res.status).toBe(201);
    expect(engine.preview).toHaveBeenCalledWith(session, 'creator', { actionId: 'create-adr', expectedVersion: 3 });
  });

  it('confirms with the Idempotency-Key header', async () => {
    const engine = makeEngine();
    const res = await request(appWith(engine))
      .post(`${base}/handoffs/${HANDOFF_ID}/confirm`)
      .set('Idempotency-Key', 'key-1')
      .send({ confirm: true });
    expect(res.status).toBe(200);
    expect(engine.confirm).toHaveBeenCalledWith(session, 'creator', { handoffId: HANDOFF_ID, idempotencyKey: 'key-1' });
  });

  it('returns 202 while another confirmation is executing', async () => {
    const engine = makeEngine();
    engine.confirm.mockResolvedValue({ handoffId: HANDOFF_ID, state: 'executing' });
    const res = await request(appWith(engine)).post(`${base}/handoffs/${HANDOFF_ID}/confirm`).set('Idempotency-Key', 'k').send({ confirm: true });
    expect(res.status).toBe(202);
  });

  it('VT-35: refuses a confirmation without explicit confirm: true', async () => {
    const engine = makeEngine();
    const res = await request(appWith(engine)).post(`${base}/handoffs/${HANDOFF_ID}/confirm`).set('Idempotency-Key', 'k').send({});
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CONFIRMATION_REQUIRED');
    expect(engine.confirm).not.toHaveBeenCalled();
  });

  it('VT-35: passes engine refusals through with their code', async () => {
    const engine = makeEngine();
    engine.confirm.mockRejectedValue(new BrainstormHandoffError('IDEMPOTENCY_KEY_MISMATCH', 409));
    const res = await request(appWith(engine)).post(`${base}/handoffs/${HANDOFF_ID}/confirm`).set('Idempotency-Key', 'bad').send({ confirm: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_MISMATCH');
  });

  it('VT-40: an unavailable action returns 409 with its reasons', async () => {
    const engine = makeEngine();
    engine.preview.mockRejectedValue(new BrainstormHandoffError('ACTION_UNAVAILABLE', 409, { reasons: [{ code: 'NOT_OFFERED', text: 'x' }] }));
    const res = await request(appWith(engine)).post(`${base}/handoffs/preview`).send({ actionId: 'create-adr', expectedVersion: 3 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'ACTION_UNAVAILABLE', reasons: [{ code: 'NOT_OFFERED' }] });
  });

  it('an unexpected stop returns 500 HANDOFF_INTERRUPTED', async () => {
    const engine = makeEngine();
    engine.confirm.mockRejectedValue(new BrainstormHandoffError('HANDOFF_INTERRUPTED', 500));
    const res = await request(appWith(engine)).post(`${base}/handoffs/${HANDOFF_ID}/confirm`).set('Idempotency-Key', 'k').send({ confirm: true });
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('HANDOFF_INTERRUPTED');
  });

  it('refuses a malformed handoff id with 404', async () => {
    const res = await request(appWith(makeEngine())).get(`${base}/handoffs/not-a-uuid`);
    expect(res.status).toBe(404);
  });

  it('keeps as standalone', async () => {
    const engine = makeEngine();
    const res = await request(appWith(engine)).post(`${base}/handoffs/keep-standalone`).send({ expectedVersion: 3 });
    expect(res.status).toBe(200);
    expect(engine.keepStandalone).toHaveBeenCalledWith(session, 'creator', { expectedVersion: 3 });
  });
});

describe('VT-05 / VT-25: a non-creator member reads but does not write', () => {
  beforeEach(() => {
    currentUser = 'member';
  });

  it('reads actions', async () => {
    const res = await request(appWith(makeEngine())).get(`${base}/actions`);
    expect(res.status).toBe(200);
  });

  it.each([
    [`${base}/handoffs/preview`, { actionId: 'create-adr', expectedVersion: 3 }],
    [`${base}/handoffs/${HANDOFF_ID}/confirm`, { confirm: true }],
    [`${base}/handoffs/keep-standalone`, { expectedVersion: 3 }],
  ])('POST %s returns 403 and calls nothing', async (path, body) => {
    const engine = makeEngine();
    const res = await request(appWith(engine)).post(path).set('Idempotency-Key', 'key-1').send(body);
    expect(res.status).toBe(403);
    expect(engine.preview).not.toHaveBeenCalled();
    expect(engine.confirm).not.toHaveBeenCalled();
    expect(engine.keepStandalone).not.toHaveBeenCalled();
  });
});

describe('VT-45: flag off', () => {
  let app: express.Express;

  beforeAll(async () => {
    jest.resetModules();
    jest.doMock('../services/brainstormThread', () => ({
      isBrainstormEnabled: jest.fn().mockResolvedValue(false),
      loadBrainstormSession: jest.fn(),
      loadBrainstormViewer: jest.fn(),
    }));
    const { default: brainstormRouter } = await import('../routes/brainstorm');
    app = express();
    app.use(express.json());
    app.use('/api/brainstorm', brainstormRouter);
  }, 120_000);

  it.each([
    ['get', `/sessions/${SESSION_ID}/artifact`],
    ['get', `/sessions/${SESSION_ID}/artifact/versions`],
    ['get', `/sessions/${SESSION_ID}/artifact/compare?from=1&to=2`],
    ['post', `/sessions/${SESSION_ID}/artifact/type`],
    ['post', `/sessions/${SESSION_ID}/artifact/checkpoints`],
    ['post', `/sessions/${SESSION_ID}/artifact/rollback`],
    ['get', `/sessions/${SESSION_ID}/actions`],
    ['post', `/sessions/${SESSION_ID}/handoffs/preview`],
    ['post', `/sessions/${SESSION_ID}/handoffs/keep-standalone`],
    ['post', `/sessions/${SESSION_ID}/handoffs/${HANDOFF_ID}/confirm`],
    ['get', `/sessions/${SESSION_ID}/handoffs/${HANDOFF_ID}`],
    ['get', `/artifacts/${HANDOFF_ID}`],
  ] as const)('%s %s returns 404', async (method, path) => {
    const res = await request(app)[method](`/api/brainstorm${path}${path.includes('?') ? '&' : '?'}project=${PROJECT}`).send({});
    expect(res.status).toBe(404);
  });
});
