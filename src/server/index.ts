import './services/telemetry';
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
import reviewCommentRoutes from './routes/reviewComments';
import deploymentOutcomesRouter from './routes/deploymentOutcomes';
import designPrototypeRoutes from './routes/designPrototypes';
import designPlanRoutes from './routes/designPlans';
import pageScreenshotRoutes from './routes/pageScreenshots';
import { mountAdoMcp } from './mcp/ado/express';
import { ensureAuthenticated } from './middleware/auth';
import { handleIncoming } from './services/teamsBotService';
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
import platformAdminRouter from './routes/platformAdmin';
import devWorkbenchRoutes from './routes/devWorkbench';
import standupRouter from './routes/standup';
import { standupScheduler } from './services/standupScheduler';

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

// Telemetry config — unauthenticated so the frontend can init App Insights before login
app.get('/api/telemetry-config', (_req, res) => {
  res.json({
    connectionString: process.env.APPLICATIONINSIGHTS_CONNECTION_STRING || null,
  });
});

// Bot Framework messaging endpoint — Teams sends requests with its own auth, not session cookies
app.post('/api/messages', (req, res) => handleIncoming(req, res));

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

// Health check paths are unauthenticated — used by Azure slot-swap warmup and
// external monitoring. req.path is relative to /api (prefix is stripped by Express).
const unauthenticatedPaths = ['/health', '/health/db', '/health/agents'];

app.use('/api', (req, res, next) => {
  const isLocalhost = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';
  const isInternalPath = internalOnlyPaths.some(p => req.path.startsWith(p));
  const isHealthPath = unauthenticatedPaths.some(p => req.path === p);

  if (isHealthPath) return next();

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
app.use('/api/design-prototypes', ensureAuthenticated, designPrototypeRoutes);
app.use('/api/design-plans', ensureAuthenticated, designPlanRoutes);
app.use('/api/page-screenshots', ensureAuthenticated, pageScreenshotRoutes);
app.use('/api/workitems', ensureAuthenticated, workitemsFromPrdRoutes);
app.use('/api/review-comments', ensureAuthenticated, reviewCommentRoutes);
app.use('/api/deployment-outcomes', ensureAuthenticated, deploymentOutcomesRouter);
app.use('/api/platform-admin', ensureAuthenticated, platformAdminRouter);
app.use('/api/dev-workbench', ensureAuthenticated, devWorkbenchRoutes);
app.use('/api/standup', ensureAuthenticated, standupRouter);
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

// Global error-handling middleware — sends unhandled errors to App Insights
app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const { telemetryClient } = require('./services/telemetry');
  if (telemetryClient) {
    telemetryClient.trackException({
      exception: err instanceof Error ? err : new Error(String(err)),
      properties: { path: req.path, method: req.method },
    });
  }
  const status = err.status ?? 500;
  res.status(status).json({ error: err.message ?? 'Internal server error' });
});

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
  
  // Start the feature auto-complete background service after a 2-minute delay
  // to avoid bursting ADO calls at the same time as UAT auto-release on boot.
  setTimeout(() => {
    const featureAutoComplete = getFeatureAutoCompleteService();
    featureAutoComplete.start();
    console.log('Feature auto-complete service started');
  }, 2 * 60 * 1000);
  
  // Start the UAT auto-release background service
  const uatAutoRelease = getUatAutoReleaseService();
  uatAutoRelease.start();
  console.log('UAT auto-release service started');

  standupScheduler.start();
  console.log('Standup scheduler started');

  bootstrapAdmin();

  // Recover in-flight PRD/design-doc/validation watchers lost to a restart,
  // and re-check every 60s for work orphaned by rolling deployments.
  startRecoveryLoop();

  // Graceful shutdown: drain connections on SIGTERM/SIGINT before exiting.
  registerGracefulShutdown(server);
});
