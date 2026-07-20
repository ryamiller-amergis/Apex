import express from 'express';
import passport from 'passport';
import { OIDCStrategy } from 'passport-azure-ad';
import { DEV_MOCK_USER_BY_ID, DEV_MOCK_USERS } from '../../shared/constants/devMockUsers';
import type { DevMockPersonaId } from '../../shared/constants/devMockUsers';
import { upsertAppUser } from '../services/rbacService';
import { resolvePendingAssignments } from '../services/pendingAssignmentService';

const router = express.Router();

// Base Azure AD strategy config (everything except redirectUrl, which is resolved
// per-request — see resolveStrategyName below).
const baseAzureAdConfig: any = {
  identityMetadata: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/v2.0/.well-known/openid-configuration`,
  clientID: process.env.AZURE_CLIENT_ID || '',
  clientSecret: process.env.AZURE_CLIENT_SECRET || '',
  responseType: 'code',
  responseMode: 'query',
  allowHttpForRedirectUrl: process.env.NODE_ENV !== 'production',
  validateIssuer: true,
  passReqToCallback: false,
  // offline_access ensures Azure AD issues a refresh token. The refresh token is
  // later redeemed (see adoUserToken.ts) for an Azure DevOps-scoped access token so
  // ADO writes act as the logged-in user. The ADO scope is intentionally NOT requested
  // here: mixing a resource "/.default" scope with Graph scopes in one interactive
  // request is rejected by Azure AD. Admin consent for the ADO user_impersonation
  // permission already authorizes the app, so the refresh token can be exchanged for
  // an ADO token without listing it at login.
  scope: ['profile', 'openid', 'email', 'offline_access', 'User.Read'],
  loggingLevel: 'info' as const,
  loggingNoPII: true,
};

// Fallback redirect URL — used in dev and whenever the request Host can't be trusted.
const DEFAULT_REDIRECT_URL =
  process.env.AZURE_REDIRECT_URL || 'http://localhost:3001/auth/callback';

console.log('Azure AD Config:', {
  tenantId: process.env.AZURE_TENANT_ID,
  clientId: process.env.AZURE_CLIENT_ID,
  defaultRedirectUrl: DEFAULT_REDIRECT_URL,
  dynamicRedirect: process.env.NODE_ENV === 'production',
  allowHttp: baseAzureAdConfig.allowHttpForRedirectUrl,
  nodeEnv: process.env.NODE_ENV,
});

const verifyAzureAd = (
  iss: any,
  sub: any,
  profile: any,
  accessToken: any,
  refreshToken: any,
  done: any
) => {
  console.log('Authentication successful', { oid: profile?.oid ?? sub });
  // Store user profile and tokens
  const user = {
    profile,
    accessToken,
    refreshToken,
  };
  return done(null, user);
};

// passport-azure-ad reads redirectUrl from the strategy instance (both when building
// the authorize request and when redeeming the code), and offers no per-request
// override. To support a custom domain AND the *.azurewebsites.net hostnames without
// the OAuth flow ever hopping between origins (which breaks the session cookie and the
// redirect_uri match), we register one strategy instance per redirect URL and select it
// by the request's Host header. Azure AD still rejects any redirect_uri not listed in
// the app registration's Reply URLs, so the Host header can't be abused to exfiltrate
// tokens — the only residual concern is unbounded cache growth, capped below.
const DEFAULT_STRATEGY_NAME = 'azuread-openidconnect';
const MAX_DYNAMIC_STRATEGIES = 25;
const HOSTNAME_RE = /^[a-z0-9.-]+(:\d+)?$/i;
const strategyNameByRedirect = new Map<string, string>();

// Azure AD is only usable when credentials are provided. In test/e2e and local dev
// without creds, we skip registering the OIDC strategy entirely and rely on the
// dev-login flow — constructing OIDCStrategy with an empty clientID throws at boot.
const isAzureAdConfigured = Boolean(process.env.AZURE_CLIENT_ID && process.env.AZURE_TENANT_ID);

function registerStrategy(name: string, redirectUrl: string): void {
  if (!isAzureAdConfigured) return;
  passport.use(name, new OIDCStrategy({ ...baseAzureAdConfig, redirectUrl }, verifyAzureAd));
}

// Always register the default strategy (dev flow + production fallback).
registerStrategy(DEFAULT_STRATEGY_NAME, DEFAULT_REDIRECT_URL);
strategyNameByRedirect.set(DEFAULT_REDIRECT_URL, DEFAULT_STRATEGY_NAME);

// Pick (and lazily register) the OIDC strategy whose redirect URL matches the host the
// user actually visited, so login starts and finishes on the same origin.
function resolveStrategyName(req: express.Request): string {
  // Outside production we keep the original static behavior to avoid disrupting the
  // local dev / Vite-proxy flow.
  if (process.env.NODE_ENV !== 'production') return DEFAULT_STRATEGY_NAME;

  const host = (req.get('host') || '').toLowerCase();
  if (!host || !HOSTNAME_RE.test(host)) return DEFAULT_STRATEGY_NAME;

  const proto = req.protocol || 'https';
  const redirectUrl = `${proto}://${host}/auth/callback`;

  let name = strategyNameByRedirect.get(redirectUrl);
  if (!name) {
    // Safety valve against Host-header flooding filling the strategy cache.
    if (strategyNameByRedirect.size >= MAX_DYNAMIC_STRATEGIES) {
      return DEFAULT_STRATEGY_NAME;
    }
    name = `azuread-${host.replace(/[^a-z0-9]/gi, '_')}`;
    registerStrategy(name, redirectUrl);
    strategyNameByRedirect.set(redirectUrl, name);
    console.log(`[auth] Registered dynamic OIDC strategy for ${redirectUrl}`);
  }
  return name;
}

passport.serializeUser((user: any, done) => {
  done(null, user);
});

passport.deserializeUser((user: any, done) => {
  done(null, user);
});

// Login route
router.get('/login', (req, res, next) => {
  if (!isAzureAdConfigured) {
    console.warn('[auth] Azure AD is not configured — /login is unavailable. Use dev-login in non-production environments.');
    return res.redirect('/auth/login-failed');
  }
  const strategyName = resolveStrategyName(req);
  console.log(`Login route hit, initiating OAuth flow via "${strategyName}" (host: ${req.get('host')})`);
  passport.authenticate(strategyName, { 
    failureRedirect: '/auth/login-failed',
    failureMessage: true 
  })(req, res, next);
});

// Callback route (GET for query response mode)
router.get(
  '/callback',
  (req, res, next) => {
    console.log('Auth callback received');
    if (!isAzureAdConfigured) {
      return res.redirect('/auth/login-failed');
    }
    passport.authenticate(resolveStrategyName(req), (err: any, user: any, info: any) => {
      if (err) {
        console.error('Authentication error:', err);
        return res.redirect('/auth/login-failed');
      }
      if (!user) {
        console.error('Authentication failed - no user:', info);
        return res.redirect('/auth/login-failed');
      }
      req.logIn(user, (loginErr) => {
        if (loginErr) {
          console.error('Login error:', loginErr);
          return res.redirect('/auth/login-failed');
        }
        console.log('User logged in successfully');
        const userEmail =
          user.profile?.upn ||
          user.profile?.email ||
          user.profile?.preferred_username ||
          (Array.isArray(user.profile?.emails) ? user.profile.emails[0] : '') ||
          user.profile?._json?.email ||
          user.profile?._json?.preferred_username ||
          '';
        if (!userEmail) {
          console.warn('[auth] No email found in profile claims:', Object.keys(user.profile ?? {}));
        }
        // Fire-and-forget: populate user cache table (do not block login on this)
        upsertAppUser(
          user.profile?.oid ?? '',
          user.profile?.displayName ?? '',
          userEmail,
        ).catch((err) => console.error('upsertAppUser failed:', err));
        resolvePendingAssignments(
          user.profile?.oid ?? '',
          userEmail,
        ).catch((err) => console.error('resolvePendingAssignments failed:', err));
        // Redirect to the Vite dev server (or root in production)
        const redirectUrl = process.env.NODE_ENV === 'production' 
          ? '/' 
          : 'http://localhost:3000/';
        return res.redirect(redirectUrl);
      });
    })(req, res, next);
  }
);

// Login failed route
router.get('/login-failed', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Login Failed</title>
        <style>
          body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            display: flex;
            justify-content: center;
            align-items: center;
            min-height: 100vh;
            margin: 0;
            background: linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 50%, #1a1a1a 100%);
            color: white;
          }
          .container {
            text-align: center;
            padding: 3rem;
            background: rgba(45, 45, 45, 0.95);
            border-radius: 16px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
            border: 1px solid rgba(255, 255, 255, 0.1);
          }
          h1 { color: #dc2626; margin-bottom: 1rem; }
          p { color: #b0b0b0; margin-bottom: 2rem; }
          a { 
            display: inline-block;
            background: linear-gradient(135deg, #dc2626 0%, #991b1b 100%);
            color: white;
            padding: 12px 24px;
            border-radius: 8px;
            text-decoration: none;
            font-weight: 600;
          }
          a:hover { background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Authentication Failed</h1>
          <p>We couldn't sign you in. Please check that you have the correct permissions and try again.</p>
          <a href="/">Return to Login</a>
        </div>
      </body>
    </html>
  `);
});

// Logout route
router.get('/logout', (req, res) => {
  req.logout((err) => {
    if (err) {
      return res.status(500).json({ error: 'Logout failed' });
    }
    req.session.destroy(() => {
      res.redirect('/');
    });
  });
});

// Check auth status
router.get('/status', (req, res) => {
  if (req.isAuthenticated()) {
    res.json({ 
      authenticated: true, 
      user: {
        name: (req.user as any)?.profile?.displayName || 'User',
        email: (req.user as any)?.profile?.upn || (req.user as any)?.profile?.email
      }
    });
  } else {
    res.json({ authenticated: false });
  }
});

// Dev-only: mock login for local development without Azure AD
if (process.env.NODE_ENV !== 'production') {
  router.get('/dev-login-available', (_req, res) => {
    res.json({
      available: true,
      personas: DEV_MOCK_USERS.map(({ id, label, displayName }) => ({ id, label, displayName })),
    });
  });

  router.post('/dev-login', (req, res) => {
    const persona = (req.body?.persona ?? 'developer') as DevMockPersonaId;
    const personaUser = DEV_MOCK_USER_BY_ID.get(persona);
    if (!personaUser) {
      return res.status(400).json({ error: `Unknown dev persona: ${persona}` });
    }

    const mockUser = {
      profile: {
        oid: personaUser.oid,
        sub: personaUser.oid,
        displayName: personaUser.displayName,
        upn: personaUser.email,
        email: personaUser.email,
      },
      accessToken: 'mock-access-token',
      refreshToken: 'mock-refresh-token',
    };

    req.logIn(mockUser, (err) => {
      if (err) {
        console.error('Dev login error:', err);
        return res.status(500).json({ error: 'Dev login failed' });
      }
      console.log(`[dev-login] Mock user logged in as ${personaUser.label}`);
      upsertAppUser(
        mockUser.profile.oid,
        mockUser.profile.displayName,
        mockUser.profile.upn
      ).catch((e) => console.error('upsertAppUser failed:', e));
      resolvePendingAssignments(
        mockUser.profile.oid,
        mockUser.profile.upn
      ).catch((e) => console.error('resolvePendingAssignments failed:', e));
      res.json({ ok: true, persona: personaUser.id });
    });
  });
}

export default router;
