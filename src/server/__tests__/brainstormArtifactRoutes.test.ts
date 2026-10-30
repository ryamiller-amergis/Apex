import express, { type RequestHandler } from 'express';
import request from 'supertest';

jest.mock('../db/drizzle', () => ({ db: {} }));
jest.mock('../services/telemetry', () => ({ trackEvent: jest.fn(), trackAgentError: jest.fn() }));
jest.mock('../middleware/rbac', () => ({
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

let currentUser = 'creator';
jest.mock('../utils/requestUser', () => ({ getUserId: () => currentUser }));

import { createBrainstormArtifactRouter, type BrainstormArtifactRouteDeps } from '../routes/brainstormArtifact';
import { BrainstormArtifactError } from '../services/brainstormArtifactVersionStore';
import { decideBrainstormAccess, type BrainstormAccessMode } from '../services/brainstormAccessPolicy';
import { BRAINSTORM_CREATE, BRAINSTORM_VIEW } from '../../shared/types/brainstorm';
import type { BrainstormSessionRow } from '../services/brainstormThread';

const SESSION_ID = '50000000-0000-4000-8000-000000000001';
const PROJECT = 'alpha';

let sessionState: 'active' | 'ended' = 'active';

function session(): BrainstormSessionRow {
  return {
    id: SESSION_ID,
    project: PROJECT,
    creatorId: 'creator',
    state: sessionState,
    model: 'model-a',
    title: null,
    artifactType: null,
    chatThreadId: '50000000-0000-4000-8000-000000000002',
    lastActivityAt: '2026-10-29T10:00:00.000Z',
    endedAt: null,
    failureReason: null,
    version: 1,
    createdBy: 'creator',
    updatedBy: 'creator',
    createdAt: '2026-10-29T10:00:00.000Z',
    updatedAt: '2026-10-29T10:00:00.000Z',
  };
}

/** The real access policy with a fixed member viewer, standing in for `requireBrainstormSession`. */
function gate(mode: BrainstormAccessMode): RequestHandler {
  return (req, res, next) => {
    const viewer = {
      id: currentUser,
      isSuperAdmin: false,
      isProjectMember: true,
      permissions: new Set([BRAINSTORM_VIEW, BRAINSTORM_CREATE]),
    };
    const row = req.params.id === SESSION_ID ? session() : null;
    const decision = decideBrainstormAccess({ viewer, project: PROJECT, session: row }, mode);
    if (decision.kind === 'refuse') {
      const status = decision.reason === 'not_found' ? 404 : decision.reason === 'session_not_active' ? 409 : 403;
      res.status(status).json({ error: decision.reason });
      return;
    }
    (req as unknown as { brainstorm: unknown }).brainstorm = { project: PROJECT, session: row };
    next();
  };
}

const emptyArtifact = {
  id: null,
  sessionId: SESSION_ID,
  type: null,
  markdown: '',
  version: 0,
  updatedAt: null,
  lastOrigin: null,
  lastChangeFailure: null,
};

const summary = {
  sequence: 1,
  origin: 'type_switch',
  checkpointName: 'Type set: ADR',
  artifactType: 'adr',
  authorId: 'creator',
  createdAt: '2026-10-29T10:00:00.000Z',
  sizeBytes: 0,
} as const;

function makeDeps() {
  return {
    store: {
      getArtifact: jest.fn().mockResolvedValue(emptyArtifact),
      listVersions: jest.fn().mockResolvedValue({ versions: [], nextCursor: null }),
      getVersion: jest.fn(),
      compareVersions: jest.fn(),
      labelCheckpoint: jest.fn().mockResolvedValue({ ...summary, checkpointName: 'Draft' }),
      rollback: jest.fn().mockResolvedValue({ ...summary, sequence: 6, origin: 'rollback' }),
      setTypeOnEmpty: jest.fn().mockResolvedValue(summary),
    },
    turnInProgress: jest.fn().mockResolvedValue(false),
    startTypeSwitch: jest.fn().mockResolvedValue({ turnId: 't', runId: 'r', messageId: 'm' }),
    read: gate('read'),
    mutate: gate('mutate'),
  };
}

function appWith(deps: ReturnType<typeof makeDeps>) {
  const app = express();
  app.use(express.json());
  app.use('/sessions/:id', createBrainstormArtifactRouter(deps as unknown as BrainstormArtifactRouteDeps));
  return app;
}

const base = `/sessions/${SESSION_ID}`;

beforeEach(() => {
  currentUser = 'creator';
  sessionState = 'active';
});

describe('artifact reads', () => {
  it('returns version 0 and empty Markdown before the first write', async () => {
    const res = await request(appWith(makeDeps())).get(`${base}/artifact`);
    expect(res.status).toBe(200);
    expect(res.body.artifact).toMatchObject({ version: 0, markdown: '', type: null });
  });

  it('VT-45: another project or an unknown session reads as 404', async () => {
    const res = await request(appWith(makeDeps())).get('/sessions/50000000-0000-4000-8000-0000000000ff/artifact');
    expect(res.status).toBe(404);
  });

  it('VT-17: one version only returns 409 NOTHING_TO_COMPARE', async () => {
    const deps = makeDeps();
    deps.store.compareVersions.mockRejectedValue(new BrainstormArtifactError('NOTHING_TO_COMPARE', 409));
    const res = await request(appWith(deps)).get(`${base}/artifact/compare?from=1&to=2`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOTHING_TO_COMPARE');
  });

  it('refuses a compare without numeric sequences', async () => {
    const res = await request(appWith(makeDeps())).get(`${base}/artifact/compare?from=a&to=2`);
    expect(res.status).toBe(400);
  });

  it('returns 404 for a non-numeric version sequence', async () => {
    const res = await request(appWith(makeDeps())).get(`${base}/artifact/versions/abc`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('VERSION_NOT_FOUND');
  });

  it('VT-31: an ended session still reads', async () => {
    sessionState = 'ended';
    const res = await request(appWith(makeDeps())).get(`${base}/artifact/versions`);
    expect(res.status).toBe(200);
  });
});

describe('VT-18 / VT-12: non-creator members read but do not write', () => {
  beforeEach(() => {
    currentUser = 'member';
  });

  it.each([
    ['get', `${base}/artifact/versions`],
    ['get', `${base}/artifact`],
  ])('%s %s returns 200', async (_method, path) => {
    const res = await request(appWith(makeDeps())).get(path);
    expect(res.status).toBe(200);
  });

  it.each([
    [`${base}/artifact/checkpoints`, { name: 'x', expectedVersion: 1 }],
    [`${base}/artifact/rollback`, { toSequence: 1, expectedVersion: 2 }],
    [`${base}/artifact/type`, { type: 'adr', expectedVersion: 0 }],
  ])('POST %s returns 403 and writes nothing', async (path, body) => {
    const deps = makeDeps();
    const res = await request(appWith(deps)).post(path).send(body);
    expect(res.status).toBe(403);
    expect(deps.store.labelCheckpoint).not.toHaveBeenCalled();
    expect(deps.store.rollback).not.toHaveBeenCalled();
    expect(deps.store.setTypeOnEmpty).not.toHaveBeenCalled();
    expect(deps.startTypeSwitch).not.toHaveBeenCalled();
  });
});

describe('VT-28: an ended session refuses writes', () => {
  it('returns 409 for a checkpoint', async () => {
    sessionState = 'ended';
    const deps = makeDeps();
    const res = await request(appWith(deps)).post(`${base}/artifact/checkpoints`).send({ name: 'x', expectedVersion: 1 });
    expect(res.status).toBe(409);
    expect(deps.store.labelCheckpoint).not.toHaveBeenCalled();
  });
});

describe('checkpoints and rollback', () => {
  it('labels the current version', async () => {
    const deps = makeDeps();
    const res = await request(appWith(deps)).post(`${base}/artifact/checkpoints`).send({ name: 'Draft', expectedVersion: 3 });
    expect(res.status).toBe(201);
    expect(deps.store.labelCheckpoint).toHaveBeenCalledWith(expect.objectContaining({ name: 'Draft', expectedVersion: 3 }));
  });

  it('passes the store conflict through with the current version', async () => {
    const deps = makeDeps();
    deps.store.rollback.mockRejectedValue(new BrainstormArtifactError('ARTIFACT_VERSION_CONFLICT', 409, { currentVersion: 6 }));
    const res = await request(appWith(deps)).post(`${base}/artifact/rollback`).send({ toSequence: 2, expectedVersion: 5 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'ARTIFACT_VERSION_CONFLICT', currentVersion: 6 });
  });

  it('refuses a rollback while a turn is in flight', async () => {
    const deps = makeDeps();
    deps.turnInProgress.mockResolvedValue(true);
    const res = await request(appWith(deps)).post(`${base}/artifact/rollback`).send({ toSequence: 2, expectedVersion: 5 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TURN_IN_PROGRESS');
    expect(deps.store.rollback).not.toHaveBeenCalled();
  });

  it('refuses a malformed rollback body', async () => {
    const res = await request(appWith(makeDeps())).post(`${base}/artifact/rollback`).send({ toSequence: 'two' });
    expect(res.status).toBe(400);
  });
});

describe('POST /artifact/type', () => {
  it('sets the type on an empty artifact with no turn (200)', async () => {
    const deps = makeDeps();
    const res = await request(appWith(deps)).post(`${base}/artifact/type`).send({ type: 'adr', expectedVersion: 0 });
    expect(res.status).toBe(200);
    expect(deps.store.setTypeOnEmpty).toHaveBeenCalledWith(expect.objectContaining({ type: 'adr', expectedVersion: 0 }));
    expect(deps.startTypeSwitch).not.toHaveBeenCalled();
  });

  it('starts a reshape turn when the artifact has content (202)', async () => {
    const deps = makeDeps();
    deps.store.getArtifact.mockResolvedValue({ ...emptyArtifact, type: 'adr', version: 4, markdown: '# ADR' });
    const res = await request(appWith(deps)).post(`${base}/artifact/type`).send({ type: 'technical_design', expectedVersion: 4 });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ turnId: 't', runId: 'r', messageId: 'm' });
    expect(deps.startTypeSwitch).toHaveBeenCalledWith(expect.objectContaining({ targetType: 'technical_design', userId: 'creator' }));
  });

  it('VT-13: a stale expected version returns 409 and starts nothing', async () => {
    const deps = makeDeps();
    deps.store.getArtifact.mockResolvedValue({ ...emptyArtifact, type: 'adr', version: 5, markdown: '# ADR' });
    const res = await request(appWith(deps)).post(`${base}/artifact/type`).send({ type: 'technical_design', expectedVersion: 4 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'ARTIFACT_VERSION_CONFLICT', currentVersion: 5 });
    expect(deps.startTypeSwitch).not.toHaveBeenCalled();
  });

  it('VT-13: a turn in flight returns 409 TURN_IN_PROGRESS', async () => {
    const deps = makeDeps();
    deps.turnInProgress.mockResolvedValue(true);
    const res = await request(appWith(deps)).post(`${base}/artifact/type`).send({ type: 'adr', expectedVersion: 0 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TURN_IN_PROGRESS');
    expect(deps.store.setTypeOnEmpty).not.toHaveBeenCalled();
  });

  it.each([['memo'], [42], [undefined]])('refuses type %p with 400 INVALID_ARTIFACT_TYPE', async (type) => {
    const res = await request(appWith(makeDeps())).post(`${base}/artifact/type`).send({ type, expectedVersion: 0 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ARTIFACT_TYPE');
  });

  it('refuses switching to the type the artifact already has', async () => {
    const deps = makeDeps();
    deps.store.getArtifact.mockResolvedValue({ ...emptyArtifact, type: 'adr', version: 2, markdown: '# ADR' });
    const res = await request(appWith(deps)).post(`${base}/artifact/type`).send({ type: 'adr', expectedVersion: 2 });
    expect(res.status).toBe(400);
    expect(deps.startTypeSwitch).not.toHaveBeenCalled();
  });
});
