/**
 * Auth route tests — dynamic OIDC redirect URL resolution per request Host.
 */
import express from 'express';
import request from 'supertest';

const authenticateMock = jest.fn();
const oidcStrategyConfigs: Array<{ redirectUrl: string }> = [];

jest.mock('passport-azure-ad', () => ({
  OIDCStrategy: jest.fn().mockImplementation((config: { redirectUrl: string }) => {
    oidcStrategyConfigs.push(config);
    return function MockOIDCStrategy() {};
  }),
}));

jest.mock('passport', () => ({
  use: jest.fn(),
  authenticate: (...args: unknown[]) => {
    authenticateMock(...args);
    return (_req: express.Request, res: express.Response) => {
      res.sendStatus(200);
    };
  },
  serializeUser: jest.fn(),
  deserializeUser: jest.fn(),
}));

jest.mock('../services/rbacService', () => ({
  upsertAppUser: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../services/pendingAssignmentService', () => ({
  resolvePendingAssignments: jest.fn().mockResolvedValue(undefined),
}));

const originalEnv = process.env;

function loadAuthRouter() {
  jest.resetModules();
  oidcStrategyConfigs.length = 0;
  authenticateMock.mockClear();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('../routes/auth').default as express.Router;
}

function buildApp(router: express.Router) {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'protocol', { value: 'https', configurable: true });
    next();
  });
  app.use('/auth', router);
  return app;
}

describe('GET /auth/login dynamic strategy', () => {
  jest.setTimeout(15_000);

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('uses the default strategy name in non-production', async () => {
    process.env = {
      ...originalEnv,
      NODE_ENV: 'development',
      AZURE_REDIRECT_URL: 'http://localhost:3001/auth/callback',
    };

    const authRouter = loadAuthRouter();
    const app = buildApp(authRouter);

    await request(app)
      .get('/auth/login')
      .set('Host', 'apex.amergis.com')
      .expect(200);

    expect(authenticateMock).toHaveBeenCalledWith(
      'azuread-openidconnect',
      expect.objectContaining({ failureRedirect: '/auth/login-failed' })
    );
  });

  it('registers and selects a host-specific strategy in production', async () => {
    process.env = {
      ...originalEnv,
      NODE_ENV: 'production',
      AZURE_TENANT_ID: 'tenant-test',
      AZURE_CLIENT_ID: 'client-test',
      AZURE_CLIENT_SECRET: 'secret-test',
      AZURE_REDIRECT_URL: 'https://app-apex-prd.azurewebsites.net/auth/callback',
    };

    const authRouter = loadAuthRouter();
    const app = buildApp(authRouter);

    await request(app)
      .get('/auth/login')
      .set('Host', 'apex.amergis.com')
      .expect(200);

    expect(oidcStrategyConfigs.some((c) => c.redirectUrl === 'https://apex.amergis.com/auth/callback')).toBe(true);
    expect(authenticateMock).toHaveBeenCalledWith(
      'azuread-apex_amergis_com',
      expect.objectContaining({ failureRedirect: '/auth/login-failed' })
    );
  });

  it('falls back to the default strategy for an invalid Host header', async () => {
    process.env = {
      ...originalEnv,
      NODE_ENV: 'production',
      AZURE_REDIRECT_URL: 'https://app-apex-prd.azurewebsites.net/auth/callback',
    };

    const authRouter = loadAuthRouter();
    const app = buildApp(authRouter);

    await request(app)
      .get('/auth/login')
      .set('Host', 'evil host!')
      .expect(200);

    expect(authenticateMock).toHaveBeenCalledWith('azuread-openidconnect', expect.any(Object));
  });
});

describe('GET /auth/status', () => {
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns authenticated false when no session user is present', async () => {
    process.env = { ...originalEnv, NODE_ENV: 'test' };

    const authRouter = loadAuthRouter();
    const app = express();
    app.use((req: express.Request, _res, next) => {
      (req as any).isAuthenticated = () => false;
      next();
    });
    app.use('/auth', authRouter);

    const res = await request(app).get('/auth/status').expect(200);
    expect(res.body).toEqual({ authenticated: false });
  });
});
