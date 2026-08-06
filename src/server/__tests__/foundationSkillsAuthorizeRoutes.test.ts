import express from 'express';
import request from 'supertest';
import { authorizeSkillInstall, FoundationSkillAuthorizeResult } from '../services/foundationSkillAuthorizeService';
import router from '../routes/foundationSkillsAuthorize';

jest.mock('../services/foundationSkillAuthorizeService', () => ({
  authorizeSkillInstall: jest.fn(),
}));

const mockAuthorize = authorizeSkillInstall as jest.MockedFunction<typeof authorizeSkillInstall>;

const app = express();
app.use('/api/internal/foundation-skills', router);

const AUTHORIZED: FoundationSkillAuthorizeResult = {
  authorized: true,
  reason: 'authorized',
  repo: 'MaxView',
  apexProject: 'MaxView',
  version: '1.0.0',
  artifactVersion: '1.0.0',
  artifactVersionVerified: true,
  skills: ['to-prd'],
  message: 'Authorized for "MaxView" via release 1.0.0 (1 skill).',
};

const REMOTE = 'https://dev.azure.com/amergis/MaxView/_git/MaxView';
const ORIGINAL_TIMEOUT = process.env.FOUNDATION_SKILLS_AUTHORIZE_TIMEOUT_MS;

function get(artifactVersion?: string) {
  return request(app)
    .get('/api/internal/foundation-skills/authorize')
    .query({ remote: REMOTE, ...(artifactVersion ? { artifactVersion } : {}) });
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
  if (ORIGINAL_TIMEOUT === undefined) delete process.env.FOUNDATION_SKILLS_AUTHORIZE_TIMEOUT_MS;
  else process.env.FOUNDATION_SKILLS_AUTHORIZE_TIMEOUT_MS = ORIGINAL_TIMEOUT;
});

describe('GET /authorize', () => {
  it('returns the entitlement decision when the lookup succeeds', async () => {
    mockAuthorize.mockResolvedValue(AUTHORIZED);

    const res = await get();

    expect(res.status).toBe(200);
    expect(res.body.authorized).toBe(true);
    expect(res.body.artifactVersion).toBe('1.0.0');
    expect(res.body.artifactVersionVerified).toBe(true);
  });

  it('passes the requested artifact version to authorization', async () => {
    mockAuthorize.mockResolvedValue(AUTHORIZED);

    const res = await get('1.0.0');

    expect(res.status).toBe(200);
    expect(mockAuthorize).toHaveBeenCalledWith(REMOTE, '1.0.0');
  });

  it('reports a denial as 200 so the CLI can tell it apart from an outage', async () => {
    mockAuthorize.mockResolvedValue({
      ...AUTHORIZED,
      authorized: false,
      reason: 'repo-not-registered',
      apexProject: null,
      version: null,
      artifactVersion: null,
      artifactVersionVerified: false,
      skills: [],
      message: 'No Apex project is registered for repo "MatterWorx".',
    });

    const res = await get();

    expect(res.status).toBe(200);
    expect(res.body.authorized).toBe(false);
    expect(res.body.reason).toBe('repo-not-registered');
  });

  it('rejects a missing remote without consulting the service', async () => {
    const res = await request(app).get('/api/internal/foundation-skills/authorize');

    expect(res.status).toBe(400);
    expect(mockAuthorize).not.toHaveBeenCalled();
  });

  it('answers 503 with a distinguishable code when the lookup stalls', async () => {
    process.env.FOUNDATION_SKILLS_AUTHORIZE_TIMEOUT_MS = '50';
    mockAuthorize.mockImplementation(() => new Promise(() => {}));

    const res = await get();

    expect(res.status).toBe(503);
    expect(res.body.code).toBe('authorization-unavailable');
  });

  it('answers 500 with a different code when the lookup throws', async () => {
    mockAuthorize.mockRejectedValue(new Error('relation does not exist'));

    const res = await get();

    expect(res.status).toBe(500);
    expect(res.body.code).toBe('authorization-failed');
  });
});
