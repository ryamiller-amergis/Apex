import express from 'express';
import passport from 'passport';
import { OIDCStrategy } from 'passport-azure-ad';
import { upsertAppUser } from '../services/rbacService';
import { resolvePendingAssignments } from '../services/pendingAssignmentService';

const router = express.Router();

// Configure Azure AD strategy
const azureAdConfig: any = {
  identityMetadata: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/v2.0/.well-known/openid-configuration`,
  clientID: process.env.AZURE_CLIENT_ID || '',
  clientSecret: process.env.AZURE_CLIENT_SECRET || '',
  responseType: 'code',
  responseMode: 'query',
  redirectUrl: process.env.AZURE_REDIRECT_URL || 'http://localhost:3001/auth/callback',
  allowHttpForRedirectUrl: process.env.NODE_ENV !== 'production',
  validateIssuer: true,
  passReqToCallback: false,
  scope: ['profile', 'openid', 'email', 'User.Read'],
  loggingLevel: 'info' as const,
  loggingNoPII: true,
};

console.log('Azure AD Config:', {
  tenantId: process.env.AZURE_TENANT_ID,
  clientId: process.env.AZURE_CLIENT_ID,
  redirectUrl: process.env.AZURE_REDIRECT_URL,
  allowHttp: azureAdConfig.allowHttpForRedirectUrl,
  nodeEnv: process.env.NODE_ENV
});

passport.use(
  new OIDCStrategy(
    azureAdConfig,
    (iss: any, sub: any, profile: any, accessToken: any, refreshToken: any, done: any) => {
      console.log('Authentication successful', { oid: profile?.oid ?? sub });
      // Store user profile and tokens
      const user = {
        profile,
        accessToken,
        refreshToken,
      };
      return done(null, user);
    }
  )
);

passport.serializeUser((user: any, done) => {
  done(null, user);
});

passport.deserializeUser((user: any, done) => {
  done(null, user);
});

// Login route
router.get('/login', (req, res, next) => {
  console.log('Login route hit, initiating OAuth flow');
  passport.authenticate('azuread-openidconnect', { 
    failureRedirect: '/auth/login-failed',
    failureMessage: true 
  })(req, res, next);
});

// Callback route (GET for query response mode)
router.get(
  '/callback',
  (req, res, next) => {
    console.log('Auth callback received');
    passport.authenticate('azuread-openidconnect', (err: any, user: any, info: any) => {
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
        // Fire-and-forget: populate user cache table (do not block login on this)
        upsertAppUser(
          user.profile?.oid ?? '',
          user.profile?.displayName ?? '',
          user.profile?.upn ?? user.profile?.email ?? ''
        ).catch((err) => console.error('upsertAppUser failed:', err));
        resolvePendingAssignments(
          user.profile?.oid ?? '',
          user.profile?.upn ?? user.profile?.email ?? ''
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
    res.json({ available: true });
  });

  router.post('/dev-login', (req, res) => {
    const mockUser = {
      profile: {
        oid: 'dev-mock-oid-00000000-0000-0000-0000-000000000000',
        sub: 'dev-mock-oid-00000000-0000-0000-0000-000000000000',
        displayName: 'Dev User',
        upn: 'dev@localhost',
        email: 'dev@localhost',
      },
      accessToken: 'mock-access-token',
      refreshToken: 'mock-refresh-token',
    };

    req.logIn(mockUser, (err) => {
      if (err) {
        console.error('Dev login error:', err);
        return res.status(500).json({ error: 'Dev login failed' });
      }
      console.log('[dev-login] Mock user logged in');
      upsertAppUser(
        mockUser.profile.oid,
        mockUser.profile.displayName,
        mockUser.profile.upn
      ).catch((e) => console.error('upsertAppUser failed:', e));
      res.json({ ok: true });
    });
  });
}

export default router;
