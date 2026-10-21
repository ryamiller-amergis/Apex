/**
 * Auth route tests — dynamic OIDC redirect URL resolution per request Host.
 */
import fs from 'fs';
import path from 'path';
import express from 'express';
import request from 'supertest';

const authenticateMock = jest.fn();
const oidcStrategyConfigs: Array<{ redirectUrl: string }> = [];
let mockCallbackUser: unknown;

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
    const verifyCallback = args[1];
    if (mockCallbackUser && typeof verifyCallback === 'function') {
      return () => verifyCallback(null, mockCallbackUser, undefined);
    }
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

jest.mock('../services/devEnvAllowlistService', () => ({
  isDevEnvironmentAllowed: jest.fn().mockResolvedValue(true),
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
      AZURE_TENANT_ID: 'tenant-test',
      AZURE_CLIENT_ID: 'client-test',
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
      AZURE_TENANT_ID: 'tenant-test',
      AZURE_CLIENT_ID: 'client-test',
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

  it('redirects to login-failed when Azure AD is not configured', async () => {
    process.env = { ...originalEnv, NODE_ENV: 'test' };
    delete process.env.AZURE_CLIENT_ID;
    delete process.env.AZURE_TENANT_ID;

    const authRouter = loadAuthRouter();
    const app = buildApp(authRouter);

    const res = await request(app).get('/auth/login').expect(302);
    expect(res.headers.location).toBe('/auth/login-failed');
    expect(authenticateMock).not.toHaveBeenCalled();
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

describe('GET /auth/dev-access-denied', () => {
  it('explains that a platform admin must approve the email', async () => {
    process.env = { ...originalEnv, NODE_ENV: 'test' };
    const authRouter = loadAuthRouter();
    const app = express();
    app.use('/auth', authRouter);

    const res = await request(app).get('/auth/dev-access-denied').expect(403);
    expect(res.text).toContain('Dev access required');
    expect(res.text).toContain('platform admin');
  });
});

describe('GET /auth/callback test accounts', () => {
  const ssoEnv = {
    NODE_ENV: 'production',
    AZURE_TENANT_ID: 'tenant-test',
    AZURE_CLIENT_ID: 'client-test',
    AZURE_REDIRECT_URL: 'https://app-apex-prd.azurewebsites.net/auth/callback',
  };

  function buildCallbackApp() {
    const app = express();
    app.use((req, _res, next) => {
      (req as any).session = {};
      (req as any).logIn = (_user: unknown, _opts: unknown, done: (err?: unknown) => void) => done();
      next();
    });
    app.use('/auth', loadAuthRouter());
    return app;
  }

  function signInAs(email: string) {
    mockCallbackUser = { profile: { oid: 'oid-test', displayName: 'Test', upn: email } };
  }

  afterEach(() => {
    process.env = { ...originalEnv };
    mockCallbackUser = undefined;
  });

  it('refuses a test account on a deployed site without the opt-in setting', async () => {
    process.env = { ...originalEnv, ...ssoEnv };
    delete process.env.ALLOW_TEST_ACCOUNT_SIGN_IN;
    signInAs('apex-test-05@amergis.com');

    const res = await request(buildCallbackApp()).get('/auth/callback').expect(302);
    expect(res.headers.location).toBe('/auth/login-failed');
  });

  it('refuses the legacy CI account on a deployed site without the opt-in setting', async () => {
    process.env = { ...originalEnv, ...ssoEnv };
    delete process.env.ALLOW_TEST_ACCOUNT_SIGN_IN;
    signInAs('APEX-E2E-TEST@amergis.com');

    const res = await request(buildCallbackApp()).get('/auth/callback').expect(302);
    expect(res.headers.location).toBe('/auth/login-failed');
  });

  it('signs in a test account when the site opts in', async () => {
    process.env = { ...originalEnv, ...ssoEnv, ALLOW_TEST_ACCOUNT_SIGN_IN: 'true' };
    signInAs('apex-test-05@amergis.com');

    const res = await request(buildCallbackApp()).get('/auth/callback').expect(302);
    expect(res.headers.location).toBe('/');
  });

  it('signs in a regular user on a deployed site without the opt-in setting', async () => {
    process.env = { ...originalEnv, ...ssoEnv };
    delete process.env.ALLOW_TEST_ACCOUNT_SIGN_IN;
    signInAs('someone@amergis.com');

    const res = await request(buildCallbackApp()).get('/auth/callback').expect(302);
    expect(res.headers.location).toBe('/');
  });
});

describe('SSO returnTo session survival', () => {
  it('keeps session fields across Passport 0.7 logIn', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../routes/auth.ts'), 'utf8');
    expect(source).toContain('keepSessionInfo: true');
    expect(source).toContain('session: true');
    expect(source).toContain('pendingReturnTo');
  });
});
