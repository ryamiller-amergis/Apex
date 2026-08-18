import { telemetryClient } from './services/telemetry';
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
import adrRoutes from './routes/adr';
import notificationRoutes from './routes/notifications';
import reviewCommentRoutes from './routes/reviewComments';
import deploymentOutcomesRouter from './routes/deploymentOutcomes';
import designPrototypeRoutes from './routes/designPrototypes';
import designPlanRoutes from './routes/designPlans';
import pageScreenshotRoutes from './routes/pageScreenshots';
import { mountAdoMcp } from './mcp/ado/express';
import { mountGitHubMcp } from './mcp/github/express';
import { mountMaxviewMcp } from './mcp/maxview/express';
import { ensureAuthenticated } from './middleware/auth';
import {
  observabilityCaptureMiddleware,
  captureServerError,
  startObservabilityCapture,
  stopObservabilityCapture,
} from './middleware/observabilityCapture';
import {
  startObservabilityOperations,
  stopObservabilityOperations,
} from './services/observabilityOperationsService';
import {
  startJourneyAggregation,
  stopJourneyAggregation,
} from './services/journeyAggregationScheduler';
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
import { startReaper, stopReaper } from './services/agentRunReaperService';
import {
  startAdmissionGovernorScheduler,
  stopAdmissionGovernorScheduler,
} from './services/admissionGovernorScheduler';
import { initPgNotify, shutdownPgNotify } from './services/pgNotifyService';
import {
  initInteractiveLiveBus,
  shutdownInteractiveLiveBus,
} from './services/interactiveLiveBus';
import platformAdminRouter from './routes/platformAdmin';
import devWorkbenchRoutes from './routes/devWorkbench';
import standupRouter from './routes/standup';
import featureFlagRoutes from './routes/featureFlags';
import observabilityRoutes from './routes/observability';
import featureRequestRoutes from './routes/featureRequests';
import apexWorkItemsRoutes from './routes/apexWorkItems';
import askApexRoutes from './routes/askApex';
import { standupScheduler } from './services/standupScheduler';
import { aiCostScheduler } from './services/aiCostScheduler';
import { apiKeyExpiryNotificationScheduler } from './services/apiKeyExpiryNotificationScheduler';
import { foundationSkillScanScheduler } from './services/foundationSkillScanScheduler';
import { groundingMaintenanceScheduler } from './services/groundingMaintenanceScheduler';
import { workBoardScheduler } from './services/workBoardScheduler';
import { createSessionOptions, createSessionStore } from './sessionStore';
import {
  isInteractiveGatewayEnabled,
  mountInteractiveGateway,
} from './services/interactiveGatewayHost';
import uiLabRoutes from './routes/uiLab';
import pdfRoutes from './routes/pdf';
import aiCostRoutes from './routes/aiCost';
import e2eSetupRoutes from './routes/e2eSetup';
import designModuleRoutes from './routes/designModule';
import loadTestsRoutes from './routes/loadTests';
import loadTestTargetsRoutes from './routes/loadTestTargets';
import apiKeysRoutes from './routes/apiKeys';
import publicRoutes from './routes/public';
import loadTestRunsInternalRoutes from './routes/loadTestRunsInternal';
import aiRunsInternalRoutes from './routes/aiRunsInternal';
import foundationSkillsAuthorizeRoutes from './routes/foundationSkillsAuthorize';
import profileRoutes from './routes/profile';
import walkthroughsRoutes from './routes/walkthroughs';
import { startPdfProcessingPoller } from './services/pdfAssemblyService';
import { startLoadTestRunReaper } from './services/loadTestRunService';

// ── E2E mode guard ────────────────────────────────────────────────────────────
// When E2E_MODE=true, background services and schedulers are suppressed so
// Playwright tests get a deterministic, side-effect-free server. This flag is
// categorically rejected in production to prevent accidental misuse.
const isE2EMode = process.env.E2E_MODE === 'true';
if (isE2EMode) {
  if (process.env.NODE_ENV === 'production') {
    console.error('[startup] E2E_MODE=true is not permitted when NODE_ENV=production. Exiting.');
    process.exit(1);
  }
  console.log('[startup] E2E mode active — background services, schedulers, and integrations are disabled.');
}

const app = express();
const PORT = process.env.PORT || 3001;

// Trust proxy - required for Azure App Service
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// Middleware
app.use(cors({
  origin: process.env.NODE_ENV === 'production'
    ? [
        'https://app-scrum-dev.azurewebsites.net',
        'https://app-apex-prd.azurewebsites.net',
        'https://apex.amergis.com',
      ]
    : ['http://localhost:3000', 'http://localhost:5173'],
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Production sessions default to PostgreSQL so OAuth state and authenticated
// sessions survive instance recycling. SESSION_STORE=file keeps the established
// Azure Files-backed store available as an emergency fallback.
const { store: sessionStore } = createSessionStore();
// FEAT-007: capture the session + passport handlers so the interactive
// WebSocket gateway can replay the same auth chain on upgrade requests.
const sessionMiddleware = session(createSessionOptions(sessionStore));
const passportInitializeMiddleware = passport.initialize();
const passportSessionMiddleware = passport.session();
app.use(sessionMiddleware);

// Initialize Passport
app.use(passportInitializeMiddleware);
app.use(passportSessionMiddleware);

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

// Load-test runner ingest/validate — session-free; auth is requireLoadTestRunnerAuth
// on loadTestRunsInternalRoutes (LT_RUNNER_CALLBACK_TOKEN or runner MI JWT).
const loadTestRunnerCallbackPaths = ['/internal/load-test-runs'];
// AI runner ingest — session-free; requireAiRunnerAuth validates callback identity.
const aiRunnerCallbackPaths = ['/internal/ai-runs'];

// @apex/skills CLI entitlement lookup — session-free because the CLI runs on
// developer machines and in CI with no Apex session. Read-only and returns no
// secrets; reading the package itself still requires an Azure Artifacts token.
const foundationSkillCliPaths = ['/internal/foundation-skills'];

// Public API-key auth — session-free; requirePublicApiKey validates Bearer keys
// on publicRoutes (mounted at /api/public).
const publicApiPaths = ['/public'];

app.use('/api', observabilityCaptureMiddleware);
app.use('/api', (req, res, next) => {
  const isLocalhost = req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';
  const isInternalPath = internalOnlyPaths.some(p => req.path.startsWith(p));
  const isHealthPath = unauthenticatedPaths.some(p => req.path === p);
  const isLoadTestRunnerCallback = loadTestRunnerCallbackPaths.some((p) =>
    req.path.startsWith(p),
  );
  const isAiRunnerCallback = aiRunnerCallbackPaths.some((p) =>
    req.path.startsWith(p),
  );
  const isFoundationSkillCli = foundationSkillCliPaths.some((p) =>
    req.path.startsWith(p),
  );
  const isPublicApi = publicApiPaths.some((p) => req.path.startsWith(p));

  if (
    isHealthPath
    || isLoadTestRunnerCallback
    || isAiRunnerCallback
    || isFoundationSkillCli
    || isPublicApi
  ) return next();

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
app.use('/api/ai-cost', ensureAuthenticated, aiCostRoutes);
app.use('/api/skills', ensureAuthenticated, skillsRoutes);
app.use('/api/wiki', ensureAuthenticated, wikiRoutes);
app.use('/api/chat', ensureAuthenticated, chatRoutes);
app.use('/api/interviews', ensureAuthenticated, interviewRoutes);
app.use('/api/adr', ensureAuthenticated, adrRoutes);
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
app.use('/api/feature-flags', ensureAuthenticated, featureFlagRoutes);
app.use('/api/observability', ensureAuthenticated, observabilityRoutes);
app.use('/api/ui-lab', ensureAuthenticated, uiLabRoutes);
app.use('/api/pdf', pdfRoutes);
app.use('/api/feature-requests', ensureAuthenticated, featureRequestRoutes);
app.use('/api/apex-work-items', ensureAuthenticated, apexWorkItemsRoutes);
app.use('/api/profile', ensureAuthenticated, profileRoutes);
app.use('/api/ask-apex', ensureAuthenticated, askApexRoutes);
app.use('/api/design-modules', ensureAuthenticated, designModuleRoutes);
app.use('/api/projects/:projectId/load-tests', ensureAuthenticated, loadTestsRoutes);
app.use('/api/projects/:projectId/load-test-targets', ensureAuthenticated, loadTestTargetsRoutes);
app.use('/api/projects/:projectId/api-keys', ensureAuthenticated, apiKeysRoutes);
app.use('/api/projects/:projectId/walkthroughs', ensureAuthenticated, walkthroughsRoutes);
// Public API — session-free; auth is Bearer API key (FEAT-002).
app.use('/api/public', publicRoutes);
// Runner ingest — session-free; auth is LT_RUNNER_CALLBACK_TOKEN (FEAT-007 / A-009).
app.use('/api/internal/load-test-runs', loadTestRunsInternalRoutes);
// AI runner ingest — session-free; auth is runner MI + AiRun.Runner (or local test token).
app.use('/api/internal/ai-runs', aiRunsInternalRoutes);
// @apex/skills CLI entitlement lookup — session-free, read-only, no secrets returned.
app.use('/api/internal/foundation-skills', foundationSkillsAuthorizeRoutes);
app.use('/api/admin', adminRouter);
mountAdoMcp(app);
mountGitHubMcp(app);
mountMaxviewMcp(app);

// E2E seed/reset endpoints — only active when E2E_MODE=true (already verified
// earlier that this flag cannot be set in production).
if (isE2EMode) {
  app.use('/e2e', e2eSetupRoutes);
}

// Serve static files in production
if (process.env.NODE_ENV === 'production') {
  // Serve static assets with cache for versioned files
  app.use(express.static(path.join(__dirname, '../client'), {
    maxAge: '1y', // Cache versioned assets for 1 year (Vite adds hashes to filenames)
    setHeaders: (res, filePath) => {
      // Don't cache shell or changelog — both must reflect the latest deploy
      if (filePath.endsWith('index.html') || filePath.endsWith('CHANGELOG.json')) {
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
  captureServerError(req, err, res);
  if (telemetryClient) {
    telemetryClient.trackException({
      exception: err instanceof Error ? err : new Error(String(err)),
      properties: { path: req.path, method: req.method },
    });
  }
  if (res.headersSent) {
    console.error('[error-handler] Response already sent for', req.method, req.path, err);
    return;
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

  // FEAT-007: interactive WebSocket agent gateway (Dapr actor tier). Off by
  // default; when enabled it authenticates upgrades with the same session +
  // passport chain and streams the thread's durable run events.
  if (isInteractiveGatewayEnabled()) {
    mountInteractiveGateway(server, {
      sessionMiddleware,
      passportInitialize: passportInitializeMiddleware,
      passportSession: passportSessionMiddleware,
    });
    // FEAT-007: subscribe the gateway to the Redis live bus (ephemeral actor→
    // client fan-out). No-op when REDIS_* is unset — replay + poll cover it.
    initInteractiveLiveBus().catch((err) =>
      console.error('[startup] initInteractiveLiveBus failed:', err.message),
    );
    server.once('close', () => {
      void shutdownInteractiveLiveBus();
    });
    console.log('[FEAT-007] Interactive WebSocket gateway mounted');
  }

  if (isE2EMode) {
    // E2E mode: skip all background services so tests run against a clean,
    // side-effect-free server. Graceful shutdown still registers so the process
    // exits cleanly when Playwright tears down the web server.
    console.log('[E2E] Server ready — background services suppressed.');
    registerGracefulShutdown(server);
    return;
  }

  startObservabilityCapture().catch((err) =>
    console.error('[startup] observability capture failed to start:', err),
  );
  startObservabilityOperations();
  startJourneyAggregation();
  server.once('close', () => {
    void stopObservabilityCapture();
    stopObservabilityOperations();
    stopJourneyAggregation();
  });

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

  aiCostScheduler.start();
  console.log('AI cost scheduler started');

  apiKeyExpiryNotificationScheduler.start();
  console.log('API key expiry notification scheduler started');

  foundationSkillScanScheduler.start();
  console.log('Foundation skill scan scheduler started');

  groundingMaintenanceScheduler.start();
  console.log('Grounding maintenance scheduler started');

  workBoardScheduler.start();
  console.log('Work board due-soon scheduler started');

  startPdfProcessingPoller();

  bootstrapAdmin();

  // Recover in-flight PRD/design-doc/validation watchers lost to a restart,
  // and re-check every 60s for work orphaned by rolling deployments.
  startRecoveryLoop();
  startReaper();
  startAdmissionGovernorScheduler();
  server.once('close', stopAdmissionGovernorScheduler);
  startLoadTestRunReaper();
  initPgNotify().catch((err) => console.error('[startup] initPgNotify failed:', err.message));

  // Graceful shutdown: drain connections on SIGTERM/SIGINT before exiting.
  registerGracefulShutdown(server);
});
