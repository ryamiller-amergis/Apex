import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import session from 'express-session';
import passport from 'passport';

// Load environment variables BEFORE importing routes
dotenv.config();

import apiRoutes from './routes/api';
import authRoutes from './routes/auth';
import azureCostRoutes from './routes/azureCost';
import skillsRoutes from './routes/skills';
import wikiRoutes from './routes/wiki';
import chatRoutes from './routes/chat';
import workitemsFromPrdRoutes from './routes/workitemsFromPrd';
import interviewRoutes from './routes/interviews';
import notificationRoutes from './routes/notifications';
import { mountAdoMcp } from './mcp/ado/express';
import { ensureAuthenticated } from './middleware/auth';
import { assignRole, listUsers, upsertAppUser } from './services/rbacService';
import adminRouter from './routes/admin';
import {
  extractAgentToken,
  verifyAgentToken,
  expectedScopeForPath,
  type AgentTokenClaims,
} from './utils/agentTokens';
import { getFeatureAutoCompleteService } from './services/featureAutoComplete';
import { getUatAutoReleaseService } from './services/uatAutoReleaseService';
import { startRecoveryLoop, registerGracefulShutdown } from './services/startupRecovery';

const app = express();
const PORT = process.env.PORT || 3001;

// Trust proxy - required for Azure App Service
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// Middleware
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? ['https://app-scrum-dev.azurewebsites.net']
    : ['http://localhost:3000', 'http://localhost:5173'],
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key-change-this',
  resave: true, // Changed to true for file store
  saveUninitialized: true, // Changed to true to save the session before OAuth flow
  name: 'connect.sid',
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    sameSite: 'lax',
    path: '/'
  }
}));

// Initialize Passport
app.use(passport.initialize());
app.use(passport.session());

// Auth routes (no authentication required)
app.use('/auth', authRoutes);

// Internal-only API routes: callable by the Cursor agent (running on the user's
// machine, no browser session cookie) via two paths:
//   1. Localhost dev shortcut — same-machine requests skip auth.
//   2. Production-safe path — a valid HMAC-signed agent token (scoped to a
//      single feature/PBI, time-bounded) authorizes the request. Tokens are
//      minted by the authenticated client just before opening the Figma
//      import modal, then embedded in the URLs the agent fetches.
// Note: when mounted at /api, Express strips that prefix so req.path is relative.
const internalOnlyPaths = [
  '/backlog/pending-figma-exports',
  '/backlog/update-figma-url',
  '/backlog/mock-html',
];
app.use('/api', (req, res, next) => {
  const isLocalhost = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';
  const isInternalPath = internalOnlyPaths.some(p => req.path.startsWith(p));

  if (isInternalPath) {
    if (isLocalhost) return next();

    const token = extractAgentToken(req);
    const claims = token ? verifyAgentToken(token) : null;
    const expectedScope = expectedScopeForPath(req.path);
    if (claims && expectedScope && claims.scope === expectedScope) {
      // Per-resource (featureId/pbiId) check happens in the route handlers.
      (req as express.Request & { agentToken?: AgentTokenClaims }).agentToken = claims;
      return next();
    }
  }

  ensureAuthenticated(req, res, next);
}, apiRoutes);
app.use('/api/azure', ensureAuthenticated, azureCostRoutes);
app.use('/api/skills', ensureAuthenticated, skillsRoutes);
app.use('/api/wiki', ensureAuthenticated, wikiRoutes);
app.use('/api/chat', ensureAuthenticated, chatRoutes);
app.use('/api/interviews', ensureAuthenticated, interviewRoutes);
app.use('/api/notifications', ensureAuthenticated, notificationRoutes);
app.use('/api/workitems', ensureAuthenticated, workitemsFromPrdRoutes);
app.use('/api/admin', adminRouter);
mountAdoMcp(app);

// Serve static files in production
if (process.env.NODE_ENV === 'production') {
  // Serve static assets with cache for versioned files
  app.use(express.static(path.join(__dirname, '../client'), {
    maxAge: '1y', // Cache versioned assets for 1 year (Vite adds hashes to filenames)
    setHeaders: (res, filePath) => {
      // Don't cache index.html to ensure users get the latest version
      if (filePath.endsWith('index.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      }
    }
  }));

  app.get('*', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(path.join(__dirname, '../client/index.html'));
  });
}

async function bootstrapAdmin(): Promise<void> {
  const bootstrapOid = process.env.BOOTSTRAP_ADMIN_OID;
  if (!bootstrapOid) {
    console.log('[bootstrap] BOOTSTRAP_ADMIN_OID not set — skipping admin bootstrap');
    return;
  }

  try {
    const users = await listUsers();
    const hasAdmin = users.some((u) => u.roles.includes('admin'));
    if (hasAdmin) {
      console.log('[bootstrap] Admin role already assigned — skipping bootstrap');
      return;
    }

    // Ensure user row exists, then assign admin role
    await upsertAppUser(bootstrapOid, 'Bootstrap Admin', '');

    // Get the admin role id
    const { db } = await import('./db/drizzle');
    const { appRoles } = await import('./db/schema');
    const { eq } = await import('drizzle-orm');
    const [adminRole] = await db.select().from(appRoles).where(eq(appRoles.name, 'admin'));
    if (!adminRole) {
      console.error('[bootstrap] admin role not found in DB — run migrations first');
      return;
    }

    await assignRole(bootstrapOid, adminRole.id, 'system-bootstrap');
    console.log(`[bootstrap] Assigned admin role to OID ${bootstrapOid}`);
  } catch (err) {
    console.error('[bootstrap] Bootstrap failed:', err);
  }
}

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  
  // Start the feature auto-complete background service
  const featureAutoComplete = getFeatureAutoCompleteService();
  featureAutoComplete.start();
  console.log('Feature auto-complete service started');
  
  // Start the UAT auto-release background service
  const uatAutoRelease = getUatAutoReleaseService();
  uatAutoRelease.start();
  console.log('UAT auto-release service started');

  bootstrapAdmin();

  // Recover in-flight PRD/design-doc/validation watchers lost to a restart,
  // and re-check every 60s for work orphaned by rolling deployments.
  startRecoveryLoop();

  // Graceful shutdown: drain connections on SIGTERM/SIGINT before exiting.
  registerGracefulShutdown(server);
});
