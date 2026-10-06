import express from 'express';
import request from 'supertest';

jest.mock('../utils/requestUser', () => ({
  getUserId: jest.fn(() => 'user-1'),
  getDisplayName: jest.fn(() => 'Ada Lovelace'),
}));

jest.mock('../services/featureFlagService', () => ({
  isFeatureEnabled: jest.fn().mockResolvedValue(true),
}));

jest.mock('../services/productSetupService', () => ({
  getProductSetup: jest.fn(),
  ProductFoundationError: class ProductFoundationError extends Error {
    status: number;
    code: string;
    constructor(message: string, status: number, code: string) {
      super(message);
      this.name = 'ProductFoundationError';
      this.status = status;
      this.code = code;
    }
  },
}));

jest.mock('../services/productFoundationDraftService', () => ({
  draftProductFoundation: jest.fn(),
  reviseProductFoundation: jest.fn(),
  saveProductFoundation: jest.fn(),
}));

jest.mock('../services/productBuildService', () => ({
  ProductBuildError: class ProductBuildError extends Error {
    status: number;
    code: string;
    constructor(message: string, status: number, code: string) {
      super(message);
      this.name = 'ProductBuildError';
      this.status = status;
      this.code = code;
    }
  },
  syncProductBuild: jest.fn(),
  regenerateProductPrototype: jest.fn(),
  approveProductBuild: jest.fn(),
  startNextProductBuild: jest.fn(),
}));

import productBuildsRouter from '../routes/productBuilds';
import { isFeatureEnabled } from '../services/featureFlagService';
import { getProductSetup, ProductFoundationError } from '../services/productSetupService';
import {
  draftProductFoundation,
  reviseProductFoundation,
  saveProductFoundation,
} from '../services/productFoundationDraftService';
import {
  approveProductBuild,
  ProductBuildError,
  regenerateProductPrototype,
  startNextProductBuild,
  syncProductBuild,
} from '../services/productBuildService';

const mockFlag = isFeatureEnabled as jest.Mock;
const mockSetup = getProductSetup as jest.Mock;
const mockSync = syncProductBuild as jest.Mock;
const mockRegenerate = regenerateProductPrototype as jest.Mock;
const mockApprove = approveProductBuild as jest.Mock;
const mockStartNext = startNextProductBuild as jest.Mock;
const mockDraft = draftProductFoundation as jest.Mock;
const mockRevise = reviseProductFoundation as jest.Mock;
const mockSave = saveProductFoundation as jest.Mock;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/product-builds', productBuildsRouter);
  return app;
}

describe('product build routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFlag.mockResolvedValue(true);
    mockSetup.mockResolvedValue({ active: true, phase: 'build', chatThreadId: 'thread-1' });
    mockSync.mockResolvedValue({ phase: 'build', build: { id: 'build-1' } });
    mockRegenerate.mockResolvedValue({ phase: 'build', design: { id: 'design-1' } });
    mockApprove.mockResolvedValue({ phase: 'build', build: { status: 'approved' } });
    mockStartNext.mockResolvedValue({ phase: 'build', build: { kind: 'feature', status: 'discovery' } });
    mockDraft.mockResolvedValue('# Product Foundation');
    mockRevise.mockResolvedValue('# Product Foundation\n\nRevised');
    mockSave.mockResolvedValue(undefined);
  });

  it('hides every route when rfp-intake is off for Apex', async () => {
    mockFlag.mockResolvedValue(false);
    const app = buildApp();

    const setup = await request(app).get('/api/product-builds/setup').query({ project: 'Benefits Tracker' });
    const sync = await request(app).post('/api/product-builds/build-1/sync');
    const regenerate = await request(app).post('/api/product-builds/build-1/prototype/regenerate').send({ feedback: 'Larger type' });
    const approve = await request(app).post('/api/product-builds/build-1/approve');
    const draft = await request(app).post('/api/product-builds/foundation/draft').send({ project: 'Benefits Tracker', answers: ['a', 'b', 'c', 'd'] });

    expect([setup.status, sync.status, regenerate.status, approve.status, draft.status]).toEqual([404, 404, 404, 404, 404]);
    expect(mockFlag).toHaveBeenCalledWith('rfp-intake', { userId: 'user-1', project: 'Apex' });
    expect(mockSetup).not.toHaveBeenCalled();
    expect(mockSync).not.toHaveBeenCalled();
    expect(mockRegenerate).not.toHaveBeenCalled();
    expect(mockApprove).not.toHaveBeenCalled();
    expect(mockDraft).not.toHaveBeenCalled();
  });

  it('reads setup for the signed-in user and returns the service status', async () => {
    const response = await request(buildApp()).get('/api/product-builds/setup').query({ project: 'Benefits Tracker' });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ phase: 'build', chatThreadId: 'thread-1' });
    expect(mockSetup).toHaveBeenCalledWith('Benefits Tracker', 'user-1');
  });

  it('requires a project on setup', async () => {
    const response = await request(buildApp()).get('/api/product-builds/setup');
    expect(response.status).toBe(400);
    expect(mockSetup).not.toHaveBeenCalled();
  });

  it('syncs, regenerates, and approves through the service for the signed-in user', async () => {
    const app = buildApp();

    expect((await request(app).post('/api/product-builds/build-1/sync')).status).toBe(200);
    expect((await request(app).post('/api/product-builds/build-1/prototype/regenerate').send({ feedback: 'Larger type' })).status).toBe(200);
    expect((await request(app).post('/api/product-builds/build-1/approve')).status).toBe(200);

    expect(mockSync).toHaveBeenCalledWith('build-1', 'user-1');
    expect(mockRegenerate).toHaveBeenCalledWith('build-1', 'user-1', 'Larger type');
    expect(mockApprove).toHaveBeenCalledWith('build-1', 'user-1');
  });

  it('passes the prompt through when starting the next feature', async () => {
    const response = await request(buildApp()).post('/api/product-builds/next').send({
      project: 'Benefits Tracker',
      prompt: 'Add a reminder for tomorrow',
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ build: { kind: 'feature', status: 'discovery' } });
    expect(mockStartNext).toHaveBeenCalledWith('Benefits Tracker', 'user-1', 'Add a reminder for tomorrow');
  });

  it('returns the service status when approval is refused', async () => {
    mockApprove.mockRejectedValue(new ProductBuildError('Ryan Miller is not an Apex user, so this build cannot be approved yet.', 409, 'REVIEWER_NOT_FOUND'));

    const response = await request(buildApp()).post('/api/product-builds/build-1/approve');

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: 'Ryan Miller is not an Apex user, so this build cannot be approved yet.',
      code: 'REVIEWER_NOT_FOUND',
    });
  });

  it('drafts, revises, and saves a foundation for the signed-in project owner', async () => {
    const app = buildApp();

    const draft = await request(app).post('/api/product-builds/foundation/draft').send({
      project: 'Benefits Tracker',
      answers: ['Product', 'Problem', 'First release', 'Success'],
    });
    const revise = await request(app).post('/api/product-builds/foundation/revise').send({
      project: 'Benefits Tracker',
      draft: '# Product Foundation',
      changes: 'Shorter problem',
    });
    const save = await request(app).post('/api/product-builds/foundation/save').send({
      project: 'Benefits Tracker',
      markdown: '# Product Foundation',
    });

    expect(draft.status).toBe(200);
    expect(draft.body).toEqual({ markdown: '# Product Foundation' });
    expect(revise.status).toBe(200);
    expect(revise.body).toEqual({ markdown: '# Product Foundation\n\nRevised' });
    expect(save.status).toBe(200);
    expect(save.body).toEqual({ ok: true });
    expect(mockDraft).toHaveBeenCalledWith({
      project: 'Benefits Tracker',
      userId: 'user-1',
      answeredBy: 'Ada Lovelace',
      answers: ['Product', 'Problem', 'First release', 'Success'],
    });
    expect(mockRevise).toHaveBeenCalledWith({
      project: 'Benefits Tracker',
      userId: 'user-1',
      answeredBy: 'Ada Lovelace',
      draft: '# Product Foundation',
      changes: 'Shorter problem',
    });
    expect(mockSave).toHaveBeenCalledWith({
      project: 'Benefits Tracker',
      userId: 'user-1',
      answeredBy: 'Ada Lovelace',
      markdown: '# Product Foundation',
    });
  });

  it('returns foundation service errors without asking for a global admin role', async () => {
    mockDraft.mockRejectedValue(new ProductFoundationError('Four answers are required.', 400, 'INVALID_ANSWERS'));

    const response = await request(buildApp()).post('/api/product-builds/foundation/draft').send({
      project: 'Benefits Tracker',
      answers: [],
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'Four answers are required.', code: 'INVALID_ANSWERS' });
  });
});
