import fs from 'fs/promises';
import path from 'path';
import { and, asc, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import type { RunCheckResult } from '../../shared/types/agentRunLifecycle';
import type { ChatThread, ChatThreadKickoff, ChatThreadSummary } from '../../shared/types/chat';
import {
  BUILD_BRIEF_MARKDOWN_PATH,
  BUILD_MANIFEST_PATH,
  NEW_PRODUCT_PROTOTYPE_MARKER,
  PRODUCT_BUILD_AGENT_OUTPUT_PATH,
  PRODUCT_MARKDOWN_PATH,
  parseProductBuildBrief,
  renderProductBuildArtifacts,
  type ProductBuild,
  type ProductBuildBrief,
  type ProductBuildStatus,
  type ProductBuildSummary,
} from '../../shared/types/productBuild';
import type { SkillProvider } from '../../shared/types/projectSettings';
import { RFP_APPS_ADO_PROJECT } from '../../shared/types/rfpIntake';
import type { UiLabDesign } from '../../shared/types/uiLab';
import { db } from '../db/drizzle';
import { agentRuns, appUsers, chatMessages, devSessions, productBuilds, rfpRequests } from '../db/schema';
import { sanitizeMockHtml } from '../utils/htmlSanitizer';
import { AzureDevOpsService } from './azureDevOps';
import { CloudAgentConflictError, CloudAgentEligibilityError } from './cloudAgentService';
import { createThread, getThread, sendMessage } from './chatAgentService';
import { PRODUCT_DISCOVERY_SKILL_PATH, SETUP_CHAT_MODEL } from './newProjectSkillSeedService';
import { listSkillConfigsForProject } from './projectSettingsService';
import { getUserProjectRoles } from './rbacService';
import { pushProductBuildArtifacts } from './productBuildArtifactPush';
import { queueProductImplementation } from './productImplementationQueue';
import { createDesign, getDesign, runGeneration, runRegeneration } from './uiLabService';

export const PRODUCT_PROTOTYPE_HTML_PATH = 'docs/product/prototype.html';
export const PRODUCT_BUILD_REVIEWER_NAME = 'Ryan Miller';
export const PRODUCT_DISCOVERY_KICKOFF = "Let's get started. Read PRODUCT.md, summarize it, and propose the smallest usable initial build that fits one pull request.";
const PRODUCT_PROMPT_LIMIT = 4000;

/** Azure Repos pull request URLs end in /pullrequest/<id>. */
export function pullRequestIdFromUrl(prUrl: string): number | null {
  const match = /\/pullrequest\/(\d+)(?:[/?#]|$)/i.exec(prUrl.trim());
  if (!match) return null;
  const id = Number(match[1]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export class ProductBuildError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = 'ProductBuildError';
  }
}

/** What the cloud bundle needs in order to queue implementation of one approved build. */
export interface ProductImplementationRequest {
  buildId: string;
  project: string;
  repoName: string;
  rfpRequestId: string | null;
  requesterId: string;
  reviewerId: string;
  brief: ProductBuildBrief;
}

export interface ProductImplementationReceipt {
  adoWorkItemId: number | null;
  devSessionId: string | null;
  agentRunId: string | null;
}

export type QueueImplementation = (request: ProductImplementationRequest) => Promise<ProductImplementationReceipt>;

export interface ProductBuildRfpContext {
  id: string;
  ownerId: string;
  title: string;
  request: string;
  problem: string;
  audience: string;
  status: string;
  approvedAt: string | null;
  approvedRepoName: string | null;
  apexProject: string | null;
  proposal: {
    document?: {
      kind?: string;
      sections?: {
        executiveSummary?: string;
        scope?: string[];
      };
    };
  } | null;
}

export interface ProductBuildSkillConfig {
  id: string;
  skillRepo: string;
  skillBranch: string;
  skillProvider?: SkillProvider;
}

export interface NewInitialProductBuild {
  project: string;
  rfpRequestId: string;
  requesterId: string;
}

export interface NewFollowUpProductBuild {
  project: string;
  rfpRequestId: string;
  requesterId: string;
}

export interface ProductBuildPatch {
  status?: ProductBuildStatus;
  chatThreadId?: string | null;
  uiLabDesignId?: string | null;
  prototypeVersion?: number | null;
  devSessionId?: string | null;
  agentRunId?: string | null;
  brief?: ProductBuildBrief | null;
  reviewerId?: string | null;
  adoWorkItemId?: number | null;
  prUrl?: string | null;
  errorMessage?: string | null;
  approvedAt?: string | null;
  prOpenedAt?: string | null;
  mergedAt?: string | null;
}

export interface ProductBuildRunRefresh {
  runStatus: string | null;
  prUrl: string | null;
  errorMessage: string | null;
}

export interface ProductBuildSetupStatus {
  active: true;
  phase: 'build';
  skillPath: string;
  model: string;
  candidates: { userId: string; displayName: string; email: string }[];
  foundationAnswers: string[];
  project: string;
  build: ProductBuild;
  chatThreadId: string | null;
  thread: ChatThreadSummary | null;
  design: UiLabDesign | null;
  history: ProductBuildSummary[];
}

export interface ProductBuildDeps {
  now: () => Date;
  getRoles: (userId: string, project: string) => Promise<string[]>;
  findApprovedRfp: (project: string) => Promise<ProductBuildRfpContext | null>;
  readProductFile: (repoName: string) => Promise<string | null>;
  findInitialBuild: (rfpRequestId: string) => Promise<ProductBuild | null>;
  listBuilds: (rfpRequestId: string) => Promise<ProductBuild[]>;
  findBuild: (buildId: string) => Promise<ProductBuild | null>;
  insertInitialBuild: (input: NewInitialProductBuild) => Promise<ProductBuild>;
  insertFollowUpBuild: (input: NewFollowUpProductBuild) => Promise<ProductBuild>;
  readPullRequestStatus: (repoName: string, prUrl: string) => Promise<'open' | 'abandoned' | 'merged' | null>;
  updateBuild: (buildId: string, patch: ProductBuildPatch) => Promise<ProductBuild>;
  listSkillConfigs: (project: string) => Promise<ProductBuildSkillConfig[]>;
  createThread: (
    userId: string,
    kickoff: ChatThreadKickoff,
    options?: { kickoffMessage?: string; skipAutoKickoff?: boolean },
  ) => Promise<ChatThread>;
  sendFirstMessage: (threadId: string, text: string) => Promise<void>;
  readRunChecks: (runIds: string[]) => Promise<Record<string, RunCheckResult[]>>;
  readFirstUserMessages: (threadIds: string[]) => Promise<Record<string, string>>;
  getThread: (threadId: string) => Promise<ChatThread | null>;
  readAgentBrief: (workspaceDir: string) => Promise<string | null>;
  createDesign: (
    project: string,
    authorId: string,
    req: { title: string; prompt: string },
  ) => Promise<UiLabDesign>;
  getDesign: (designId: string) => Promise<UiLabDesign | null>;
  runGeneration: (designId: string, onToken: (chunk: string) => void, userId?: string) => Promise<void>;
  runRegeneration: (
    designId: string,
    req: { feedback: string },
    onToken: (chunk: string) => void,
    userId?: string,
  ) => Promise<void>;
  findReviewer: () => Promise<{ oid: string; displayName: string } | null>;
  getActorName: (userId: string) => Promise<string>;
  readRepositoryFile: (repoName: string, branch: string, path: string) => Promise<string | null>;
  pushFiles: (input: {
    repoName: string;
    branch: string;
    changes: { path: string; content: string }[];
  }) => Promise<void>;
  queueImplementation: QueueImplementation;
  refreshImplementation: (build: ProductBuild) => Promise<ProductBuildRunRefresh | null>;
}

export interface ProductBuildService {
  getSetup: (project: string, userId: string) => Promise<ProductBuildSetupStatus>;
  startNext: (project: string, userId: string, prompt: unknown) => Promise<ProductBuildSetupStatus>;
  sync: (buildId: string, userId: string) => Promise<ProductBuildSetupStatus>;
  regenerate: (buildId: string, userId: string, feedback: unknown) => Promise<ProductBuildSetupStatus>;
  approve: (buildId: string, userId: string) => Promise<ProductBuildSetupStatus>;
}

interface OpenProductRfp extends ProductBuildRfpContext {
  approvedAt: string;
  approvedRepoName: string;
  apexProject: string;
}

export async function findProductBuildReviewer(
  lookup: (displayName: string) => Promise<{ oid: string; displayName: string | null } | null>,
): Promise<{ oid: string; displayName: string } | null> {
  const row = await lookup(PRODUCT_BUILD_REVIEWER_NAME);
  if (!row?.oid || row.displayName !== PRODUCT_BUILD_REVIEWER_NAME) return null;
  return { oid: row.oid, displayName: row.displayName };
}

export async function readProductBuildBriefFile(workspaceDir: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(workspaceDir, PRODUCT_BUILD_AGENT_OUTPUT_PATH), 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    throw err;
  }
}

function toProductBuild(row: typeof productBuilds.$inferSelect): ProductBuild {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    project: row.project,
    rfpRequestId: row.rfpRequestId,
    chatThreadId: row.chatThreadId,
    uiLabDesignId: row.uiLabDesignId,
    prototypeVersion: row.prototypeVersion,
    devSessionId: row.devSessionId,
    agentRunId: row.agentRunId,
    brief: row.brief ?? null,
    requesterId: row.requesterId,
    reviewerId: row.reviewerId,
    adoWorkItemId: row.adoWorkItemId,
    prUrl: row.prUrl,
    errorMessage: row.errorMessage,
    approvedAt: row.approvedAt,
    prOpenedAt: row.prOpenedAt,
    mergedAt: row.mergedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toRfpContext(row: typeof rfpRequests.$inferSelect): ProductBuildRfpContext {
  const document = row.proposal?.document;
  return {
    id: row.id,
    ownerId: row.ownerId,
    title: row.title,
    request: row.request,
    problem: row.problem,
    audience: row.audience,
    status: row.status,
    approvedAt: row.approvedAt,
    approvedRepoName: row.approvedRepoName,
    apexProject: row.apexProject,
    proposal: document ? { document } : null,
  };
}

function isUniqueViolation(err: unknown): boolean {
  const code = err as { code?: string; cause?: { code?: string } } | null;
  return code?.code === '23505' || code?.cause?.code === '23505';
}

export function productBuildPatchFromRun(
  build: ProductBuild,
  snapshot: ProductBuildRunRefresh,
  nowIso: string,
): ProductBuildPatch | null {
  if (snapshot.runStatus === 'failed' || snapshot.runStatus === 'cancelled') {
    const errorMessage = snapshot.runStatus === 'cancelled'
      ? 'The implementation run was cancelled.'
      : (snapshot.errorMessage?.trim()
        ? `The implementation run failed. ${snapshot.errorMessage.trim()}`
        : 'The implementation run failed.');
    const patch: ProductBuildPatch = { status: 'failed', errorMessage };
    if (snapshot.prUrl) {
      patch.prUrl = snapshot.prUrl;
      if (!build.prOpenedAt) patch.prOpenedAt = nowIso;
    }
    if (
      build.status === 'failed'
      && build.errorMessage === errorMessage
      && (patch.prUrl === undefined || build.prUrl === patch.prUrl)
    ) {
      return null;
    }
    return patch;
  }

  if (snapshot.prUrl) {
    if (build.status === 'pr-open' && build.prUrl === snapshot.prUrl) return null;
    return {
      status: 'pr-open',
      prUrl: snapshot.prUrl,
      prOpenedAt: build.prOpenedAt ?? nowIso,
      errorMessage: null,
    };
  }

  if (build.status === 'building' && !build.errorMessage) return null;
  return { status: 'building', errorMessage: null };
}

async function refreshProductBuildImplementation(build: ProductBuild): Promise<ProductBuildRunRefresh | null> {
  if (!build.agentRunId && !build.devSessionId) return null;
  let runStatus: string | null = null;
  let prUrl: string | null = null;
  let errorMessage: string | null = null;

  if (build.agentRunId) {
    const run = await db.query.agentRuns.findFirst({
      where: eq(agentRuns.id, build.agentRunId),
      columns: { status: true, cloudPrUrl: true, lastError: true },
    });
    if (run) {
      runStatus = run.status;
      prUrl = run.cloudPrUrl ?? null;
      errorMessage = run.lastError ?? null;
    }
  }

  if (build.devSessionId) {
    const devSession = await db.query.devSessions.findFirst({
      where: eq(devSessions.id, build.devSessionId),
      columns: { currentRunPrUrl: true, currentRunId: true },
    });
    if (!prUrl && devSession?.currentRunPrUrl) prUrl = devSession.currentRunPrUrl;
    if (!runStatus && devSession?.currentRunId) {
      const current = await db.query.agentRuns.findFirst({
        where: eq(agentRuns.id, devSession.currentRunId),
        columns: { status: true, cloudPrUrl: true, lastError: true },
      });
      if (current) {
        runStatus = current.status;
        prUrl = prUrl ?? current.cloudPrUrl ?? null;
        errorMessage = errorMessage ?? current.lastError ?? null;
      }
    }
  }

  if (!runStatus && !prUrl) return null;
  return { runStatus, prUrl, errorMessage };
}

function requireProductPrompt(prompt: unknown): string {
  const text = typeof prompt === 'string' ? prompt.trim() : '';
  if (!text) {
    throw new ProductBuildError('Describe what you want to add or change.', 400, 'PROMPT_REQUIRED');
  }
  if (text.length > PRODUCT_PROMPT_LIMIT) {
    throw new ProductBuildError('That request is too long.', 400, 'PROMPT_REQUIRED');
  }
  return text;
}

function withCurrentBuild(builds: ProductBuild[], current: ProductBuild): ProductBuild[] {
  const next = builds.some((item) => item.id === current.id)
    ? builds.map((item) => (item.id === current.id ? current : item))
    : [current, ...builds];
  return next.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
}

function toProductBuildSummary(
  build: ProductBuild,
  request: string | null,
  checks: RunCheckResult[],
): ProductBuildSummary {
  const slice = build.brief?.initialBuild;
  const written = request?.trim() || '';
  return {
    id: build.id,
    kind: build.kind,
    status: build.status,
    request: written || slice?.summary || '',
    summary: slice?.summary ?? '',
    createdAt: build.createdAt,
    mergedAt: build.mergedAt,
    outOfScope: slice?.outOfScope ?? [],
    deferred: slice?.deferred ?? [],
    designId: build.uiLabDesignId,
    chatThreadId: build.chatThreadId,
    adoWorkItemId: build.adoWorkItemId,
    agentRunId: build.agentRunId,
    prUrl: build.prUrl,
    checks,
  };
}

export async function readProductBuildRunChecks(runIds: string[]): Promise<Record<string, RunCheckResult[]>> {
  const ids = [...new Set(runIds.filter((id) => id.trim()))];
  if (ids.length === 0) return {};
  const rows = await db.query.agentRuns.findMany({
    where: inArray(agentRuns.id, ids),
    columns: { id: true, checkResults: true },
  });
  const checks: Record<string, RunCheckResult[]> = {};
  for (const row of rows) checks[row.id] = row.checkResults ?? [];
  return checks;
}

export async function readFirstVisibleUserMessages(threadIds: string[]): Promise<Record<string, string>> {
  const ids = [...new Set(threadIds.filter((id) => id.trim()))];
  if (ids.length === 0) return {};
  const rows = await db
    .select({
      threadId: chatMessages.threadId,
      text: chatMessages.text,
    })
    .from(chatMessages)
    .where(and(
      inArray(chatMessages.threadId, ids),
      eq(chatMessages.role, 'user'),
      eq(chatMessages.hidden, false),
    ))
    .orderBy(asc(chatMessages.ts));
  const first: Record<string, string> = {};
  for (const row of rows) {
    const text = row.text.trim();
    if (text && first[row.threadId] === undefined) first[row.threadId] = text;
  }
  return first;
}

const defaultDeps: ProductBuildDeps = {
  now: () => new Date(),
  getRoles: (userId, project) => getUserProjectRoles(userId, project),
  findApprovedRfp: async (project) => {
    const row = await db.query.rfpRequests.findFirst({
      where: and(
        eq(rfpRequests.apexProject, project),
        isNotNull(rfpRequests.approvedAt),
        ne(rfpRequests.status, 'archived'),
      ),
    });
    return row ? toRfpContext(row) : null;
  },
  readProductFile: (repoName) => new AzureDevOpsService(RFP_APPS_ADO_PROJECT).getRepositoryFile(
    RFP_APPS_ADO_PROJECT,
    repoName,
    PRODUCT_MARKDOWN_PATH,
  ),
  findInitialBuild: async (rfpRequestId) => {
    const row = await db.query.productBuilds.findFirst({
      where: and(eq(productBuilds.rfpRequestId, rfpRequestId), eq(productBuilds.kind, 'initial')),
    });
    return row ? toProductBuild(row) : null;
  },
  listBuilds: async (rfpRequestId) => {
    const rows = await db.query.productBuilds.findMany({
      where: eq(productBuilds.rfpRequestId, rfpRequestId),
    });
    return rows
      .map(toProductBuild)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
  },
  findBuild: async (buildId) => {
    const row = await db.query.productBuilds.findFirst({ where: eq(productBuilds.id, buildId) });
    return row ? toProductBuild(row) : null;
  },
  insertInitialBuild: async (input) => {
    const rows = await db.insert(productBuilds).values({
      kind: 'initial',
      status: 'discovery',
      project: input.project,
      rfpRequestId: input.rfpRequestId,
      requesterId: input.requesterId,
    }).returning();
    return toProductBuild(rows[0]);
  },
  insertFollowUpBuild: async (input) => {
    const rows = await db.insert(productBuilds).values({
      kind: 'feature',
      status: 'discovery',
      project: input.project,
      rfpRequestId: input.rfpRequestId,
      requesterId: input.requesterId,
    }).returning();
    return toProductBuild(rows[0]);
  },
  readPullRequestStatus: async (repoName, prUrl) => {
    const pullRequestId = pullRequestIdFromUrl(prUrl);
    if (!pullRequestId) return null;
    try {
      return await new AzureDevOpsService(RFP_APPS_ADO_PROJECT).getPullRequestStatus(
        repoName,
        RFP_APPS_ADO_PROJECT,
        pullRequestId,
      );
    } catch {
      return null;
    }
  },
  updateBuild: async (buildId, patch) => {
    const rows = await db.update(productBuilds).set({
      ...patch,
      updatedAt: new Date().toISOString(),
    }).where(eq(productBuilds.id, buildId)).returning();
    if (!rows[0]) throw new ProductBuildError('This product build was not found.', 404, 'BUILD_NOT_FOUND');
    return toProductBuild(rows[0]);
  },
  listSkillConfigs: (project) => listSkillConfigsForProject(project),
  createThread: (userId, kickoff, options) => createThread(userId, kickoff, options),
  sendFirstMessage: (threadId, text) => sendMessage(threadId, text),
  readRunChecks: readProductBuildRunChecks,
  readFirstUserMessages: readFirstVisibleUserMessages,
  getThread: (threadId) => getThread(threadId),
  readAgentBrief: readProductBuildBriefFile,
  createDesign: (project, authorId, req) => createDesign(project, authorId, req),
  getDesign: (designId) => getDesign(designId),
  runGeneration: (designId, onToken, userId) => runGeneration(designId, onToken, userId),
  runRegeneration: (designId, req, onToken, userId) => runRegeneration(designId, req, onToken, userId),
  findReviewer: () => findProductBuildReviewer(async (displayName) => {
    const row = await db.query.appUsers.findFirst({
      where: eq(appUsers.displayName, displayName),
      columns: { oid: true, displayName: true },
    });
    return row ?? null;
  }),
  getActorName: async (userId) => {
    const row = await db.query.appUsers.findFirst({
      where: eq(appUsers.oid, userId),
      columns: { displayName: true },
    });
    return row?.displayName?.trim() || userId;
  },
  readRepositoryFile: (repoName, branch, path) => new AzureDevOpsService(RFP_APPS_ADO_PROJECT).getRepositoryFile(
    RFP_APPS_ADO_PROJECT,
    repoName,
    path,
    branch,
  ),
  pushFiles: (input) => new AzureDevOpsService(RFP_APPS_ADO_PROJECT).pushRepositoryFiles(
    RFP_APPS_ADO_PROJECT,
    input.repoName,
    input.branch,
    'Approve the initial product build',
    input.changes,
  ),
  queueImplementation: (request) => queueProductImplementation(request),
  refreshImplementation: refreshProductBuildImplementation,
};

export function createProductBuildService(deps: ProductBuildDeps): ProductBuildService {
  function requireOpenRfp(row: ProductBuildRfpContext | null): OpenProductRfp {
    if (!row || !row.approvedAt || !row.approvedRepoName || !row.apexProject || row.status === 'archived') {
      throw new ProductBuildError('This project does not have an approved product request.', 404, 'RFP_NOT_FOUND');
    }
    return row as OpenProductRfp;
  }

  async function authorize(userId: string, rfp: OpenProductRfp): Promise<void> {
    if (rfp.ownerId === userId) return;
    const roles = await deps.getRoles(userId, rfp.apexProject);
    if (!roles.includes('admin')) {
      throw new ProductBuildError(
        'Only the approved requester or a project admin can build this product.',
        403,
        'FORBIDDEN',
      );
    }
  }

  async function requireAuthorizedBuild(buildId: string, userId: string): Promise<{ build: ProductBuild; rfp: OpenProductRfp }> {
    const build = await deps.findBuild(buildId);
    if (!build) throw new ProductBuildError('This product build was not found.', 404, 'BUILD_NOT_FOUND');
    const rfp = requireOpenRfp(await deps.findApprovedRfp(build.project));
    if (build.rfpRequestId !== rfp.id) {
      throw new ProductBuildError('This product build was not found.', 404, 'BUILD_NOT_FOUND');
    }
    await authorize(userId, rfp);
    return { build, rfp };
  }

  function present(
    build: ProductBuild,
    thread: ChatThread | null,
    design: UiLabDesign | null,
    history: ProductBuildSummary[],
  ): ProductBuildSetupStatus {
    return {
      active: true,
      phase: 'build',
      skillPath: PRODUCT_DISCOVERY_SKILL_PATH,
      model: SETUP_CHAT_MODEL,
      candidates: [],
      foundationAnswers: [],
      project: build.project,
      build,
      chatThreadId: build.chatThreadId,
      thread: thread ? toThreadSummary(thread) : null,
      design,
      history,
    };
  }

  async function historyFor(build: ProductBuild, listed?: ProductBuild[]): Promise<ProductBuildSummary[]> {
    const source = listed ?? (build.rfpRequestId ? await deps.listBuilds(build.rfpRequestId) : [build]);
    const builds = withCurrentBuild(source, build);
    const runIds = builds.flatMap((item) => (item.agentRunId ? [item.agentRunId] : []));
    const threadIds = builds.flatMap((item) => (item.chatThreadId ? [item.chatThreadId] : []));
    const [checksByRun, requestsByThread] = await Promise.all([
      deps.readRunChecks(runIds),
      deps.readFirstUserMessages(threadIds),
    ]);
    return builds.map((item) => toProductBuildSummary(
      item,
      item.chatThreadId ? requestsByThread[item.chatThreadId] ?? null : null,
      item.agentRunId ? checksByRun[item.agentRunId] ?? [] : [],
    ));
  }

  async function ensureInitialBuild(rfp: OpenProductRfp, userId: string): Promise<ProductBuild> {
    const existing = await deps.findInitialBuild(rfp.id);
    if (existing) return existing;
    try {
      return await deps.insertInitialBuild({
        project: rfp.apexProject,
        rfpRequestId: rfp.id,
        requesterId: userId,
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const raced = await deps.findInitialBuild(rfp.id);
      if (!raced) throw err;
      return raced;
    }
  }

  async function discoveryKickoff(rfp: OpenProductRfp, kind: ProductBuild['kind']): Promise<ChatThreadKickoff> {
    const configs = await deps.listSkillConfigs(rfp.apexProject);
    const config = configs.find((item) => item.skillRepo.trim() && item.skillBranch.trim());
    if (!config) {
      throw new ProductBuildError('This project has no skill repository configured.', 409, 'SKILL_CONFIG_MISSING');
    }
    return {
      project: rfp.apexProject,
      repo: config.skillRepo,
      branch: config.skillBranch,
      skillBranch: config.skillBranch,
      skillProvider: config.skillProvider ?? 'ado',
      skillPath: PRODUCT_DISCOVERY_SKILL_PATH,
      model: SETUP_CHAT_MODEL,
      skillSettingsId: config.id,
      pillLabel: 'Product discovery',
      pillDescription: kind === 'initial'
        ? 'Choose the smallest build that fits one pull request.'
        : 'Choose the next feature that fits one pull request.',
      freeformContext: requestContext(rfp),
    };
  }

  async function ensureThread(
    build: ProductBuild,
    rfp: OpenProductRfp,
    userId: string,
  ): Promise<{ build: ProductBuild; thread: ChatThread | null }> {
    if (build.chatThreadId) {
      return { build, thread: await deps.getThread(build.chatThreadId) };
    }
    const thread = await deps.createThread(userId, await discoveryKickoff(rfp, build.kind), (
      build.kind === 'initial'
        ? { kickoffMessage: PRODUCT_DISCOVERY_KICKOFF }
        : { skipAutoKickoff: true }
    ));
    const saved = await deps.updateBuild(build.id, { chatThreadId: thread.id });
    return { build: saved, thread };
  }

  async function reconcile(
    build: ProductBuild,
    userId: string,
    thread: ChatThread | null,
    repoName: string,
  ): Promise<{ build: ProductBuild; design: UiLabDesign | null }> {
    let current = build;
    if (current.status === 'discovery') {
      const raw = thread?.workspaceDir ? await deps.readAgentBrief(thread.workspaceDir) : null;
      if (raw?.trim()) {
        try {
          const brief = parseProductBuildBrief(raw);
          current = await deps.updateBuild(current.id, {
            brief,
            status: 'brief-confirmed',
            errorMessage: null,
          });
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          current = await deps.updateBuild(current.id, {
            errorMessage: `The product build brief could not be read: ${detail}`,
          });
          return { build: current, design: null };
        }
      }
    }

    if (current.status === 'brief-confirmed' && current.brief && !current.uiLabDesignId) {
      const design = await startPrototype(current, userId);
      current = await deps.updateBuild(current.id, {
        uiLabDesignId: design.id,
        status: 'prototype',
        prototypeVersion: design.version,
        errorMessage: null,
      });
      const buildId = current.id;
      void deps.runGeneration(design.id, () => undefined, userId).catch((err) => {
        const detail = err instanceof Error ? err.message : String(err);
        void deps.updateBuild(buildId, {
          errorMessage: `The prototype could not be generated: ${detail}`,
        }).catch(() => undefined);
      });
      return { build: current, design };
    }

    const design = current.uiLabDesignId ? await deps.getDesign(current.uiLabDesignId) : null;
    return { build: await applyRunRefresh(current, repoName), design };
  }

  async function applyRunRefresh(build: ProductBuild, repoName: string): Promise<ProductBuild> {
    if (build.status !== 'approved' && build.status !== 'building' && build.status !== 'pr-open') {
      return build;
    }
    let current = build;
    if (build.agentRunId || build.devSessionId) {
      const snapshot = await deps.refreshImplementation(build);
      if (snapshot) {
        const patch = productBuildPatchFromRun(build, snapshot, deps.now().toISOString());
        if (patch) current = await deps.updateBuild(build.id, patch);
      }
    }
    if (current.status !== 'pr-open' || !current.prUrl) return current;
    const prStatus = await deps.readPullRequestStatus(repoName, current.prUrl);
    if (prStatus !== 'merged') return current;
    return deps.updateBuild(current.id, {
      status: 'merged',
      errorMessage: null,
      mergedAt: current.mergedAt ?? deps.now().toISOString(),
    });
  }

  async function startPrototype(build: ProductBuild, userId: string): Promise<UiLabDesign> {
    const brief = build.brief;
    const slice = brief?.initialBuild;
    if (!brief || !slice) {
      throw new ProductBuildError('Confirm the build brief before prototyping it.', 409, 'BRIEF_REQUIRED');
    }
    try {
      return await deps.createDesign(build.project, userId, {
        title: slice.summary,
        prompt: prototypePrompt(brief),
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await deps.updateBuild(build.id, { errorMessage: `The prototype could not be started: ${detail}` });
      throw new ProductBuildError(`The prototype could not be started: ${detail}`, 502, 'PROTOTYPE_FAILED');
    }
  }

  async function loadPresentation(build: ProductBuild, listed?: ProductBuild[]): Promise<ProductBuildSetupStatus> {
    const thread = build.chatThreadId ? await deps.getThread(build.chatThreadId) : null;
    const design = build.uiLabDesignId ? await deps.getDesign(build.uiLabDesignId) : null;
    return present(build, thread, design, await historyFor(build, listed));
  }

  return {
    async getSetup(project, userId) {
      const rfp = requireOpenRfp(await deps.findApprovedRfp(project));
      await authorize(userId, rfp);
      let productFile: string | null;
      try {
        productFile = await deps.readProductFile(rfp.approvedRepoName);
      } catch {
        throw new ProductBuildError('The repository could not be read.', 502, 'REPO_UNAVAILABLE');
      }
      if (productFile === null) {
        throw new ProductBuildError('PRODUCT.md is not in the repository yet.', 409, 'FOUNDATION_OPEN');
      }
      const builds = await deps.listBuilds(rfp.id);
      const open = builds.find((item) => item.status !== 'merged') ?? null;
      const selected = open ?? (builds.length === 0 ? await ensureInitialBuild(rfp, userId) : null);
      if (!selected) return loadPresentation(builds[0], builds);
      const ensured = await ensureThread(selected, rfp, userId);
      const reconciled = await reconcile(ensured.build, userId, ensured.thread, rfp.approvedRepoName);
      return present(
        reconciled.build,
        ensured.thread,
        reconciled.design,
        await historyFor(reconciled.build, builds),
      );
    },

    async startNext(project, userId, prompt) {
      const text = requireProductPrompt(prompt);
      const rfp = requireOpenRfp(await deps.findApprovedRfp(project));
      await authorize(userId, rfp);
      const builds = await deps.listBuilds(rfp.id);
      const open = builds.find((item) => item.status !== 'merged') ?? null;
      if (open?.kind === 'initial' || (!open && builds[0]?.status !== 'merged')) {
        throw new ProductBuildError(
          'Merge the current pull request before starting the next feature.',
          409,
          'BUILD_IN_PROGRESS',
        );
      }
      let current = open ?? await deps.insertFollowUpBuild({
        project: rfp.apexProject,
        rfpRequestId: rfp.id,
        requesterId: userId,
      });
      let thread: ChatThread | null = current.chatThreadId ? await deps.getThread(current.chatThreadId) : null;
      if (!current.chatThreadId) {
        thread = await deps.createThread(userId, await discoveryKickoff(rfp, current.kind), {
          skipAutoKickoff: true,
        });
        current = await deps.updateBuild(current.id, { chatThreadId: thread.id });
        await deps.sendFirstMessage(thread.id, text);
      }
      const reconciled = await reconcile(current, userId, thread, rfp.approvedRepoName);
      return present(
        reconciled.build,
        thread,
        reconciled.design,
        await historyFor(reconciled.build, builds),
      );
    },

    async sync(buildId, userId) {
      const { build, rfp } = await requireAuthorizedBuild(buildId, userId);
      const thread = build.chatThreadId ? await deps.getThread(build.chatThreadId) : null;
      const reconciled = await reconcile(build, userId, thread, rfp.approvedRepoName);
      return present(
        reconciled.build,
        thread,
        reconciled.design,
        await historyFor(reconciled.build),
      );
    },

    async regenerate(buildId, userId, feedback) {
      const { build } = await requireAuthorizedBuild(buildId, userId);
      if (typeof feedback !== 'string' || !feedback.trim()) {
        throw new ProductBuildError('Describe the prototype change.', 400, 'FEEDBACK_REQUIRED');
      }
      const trimmed = feedback.trim();
      if (trimmed.length > 4000) {
        throw new ProductBuildError('That change is too long.', 400, 'FEEDBACK_REQUIRED');
      }
      if (!build.uiLabDesignId) {
        throw new ProductBuildError('The prototype is not ready to change.', 409, 'PROTOTYPE_NOT_READY');
      }
      try {
        await deps.runRegeneration(build.uiLabDesignId, { feedback: trimmed }, () => undefined, userId);
      } catch (err) {
        if (err instanceof ProductBuildError) throw err;
        const detail = err instanceof Error ? err.message : String(err);
        throw new ProductBuildError(detail, 502, 'PROTOTYPE_REGEN_FAILED');
      }
      const design = await deps.getDesign(build.uiLabDesignId);
      const saved = await deps.updateBuild(build.id, {
        prototypeVersion: design?.version ?? build.prototypeVersion,
        errorMessage: null,
      });
      return present(
        saved,
        saved.chatThreadId ? await deps.getThread(saved.chatThreadId) : null,
        design,
        await historyFor(saved),
      );
    },

    async approve(buildId, userId) {
      const { build, rfp } = await requireAuthorizedBuild(buildId, userId);
      if (build.approvedAt) return loadPresentation(build);

      const brief = requireBrief(build);
      const design = await requireReadyDesign(deps, build);
      const sanitized = sanitizeMockHtml(design.html ?? '');
      if (!sanitized) {
        throw new ProductBuildError('The prototype is not ready to approve.', 409, 'PROTOTYPE_NOT_READY');
      }
      const reviewer = await deps.findReviewer();
      if (!reviewer) {
        const message = `${PRODUCT_BUILD_REVIEWER_NAME} is not an Apex user, so this build cannot be approved yet.`;
        await deps.updateBuild(build.id, { errorMessage: message });
        throw new ProductBuildError(message, 409, 'REVIEWER_NOT_FOUND');
      }

      const actorName = (await deps.getActorName(userId)).trim() || userId;
      const confirmedAt = deps.now().toISOString();
      const stamped = stampBrief(brief, actorName, confirmedAt);
      const artifacts = renderProductBuildArtifacts(stamped);
      try {
        await pushProductBuildArtifacts({
          repoName: rfp.approvedRepoName,
          branch: 'main',
          changes: [
            { path: PRODUCT_MARKDOWN_PATH, content: artifacts[PRODUCT_MARKDOWN_PATH] },
            { path: BUILD_BRIEF_MARKDOWN_PATH, content: artifacts[BUILD_BRIEF_MARKDOWN_PATH] },
            { path: PRODUCT_PROTOTYPE_HTML_PATH, content: sanitized },
            { path: BUILD_MANIFEST_PATH, content: artifacts[BUILD_MANIFEST_PATH] },
          ],
        }, {
          readRepositoryFile: deps.readRepositoryFile,
          pushFiles: deps.pushFiles,
        });
      } catch (err) {
        throw approvalFailure(err, 'The approved files could not be saved to the repository.');
      }
      let receipt;
      try {
        receipt = await deps.queueImplementation({
          buildId: build.id,
          project: build.project,
          repoName: rfp.approvedRepoName,
          rfpRequestId: build.rfpRequestId,
          requesterId: build.requesterId,
          reviewerId: reviewer.oid,
          brief: stamped,
        });
      } catch (err) {
        throw approvalFailure(err, 'Approval saved the files but did not start the build.');
      }
      const saved = await deps.updateBuild(build.id, {
        brief: stamped,
        reviewerId: reviewer.oid,
        status: receipt.agentRunId ? 'building' : 'approved',
        approvedAt: confirmedAt,
        adoWorkItemId: receipt.adoWorkItemId,
        devSessionId: receipt.devSessionId,
        agentRunId: receipt.agentRunId,
        errorMessage: null,
      });
      return present(
        saved,
        saved.chatThreadId ? await deps.getThread(saved.chatThreadId) : null,
        design,
        await historyFor(saved),
      );
    },
  };
}

function approvalFailure(err: unknown, summary: string): ProductBuildError {
  if (err instanceof ProductBuildError) return err;
  if (err instanceof CloudAgentEligibilityError || err instanceof CloudAgentConflictError) {
    return new ProductBuildError(err.message, err.statusCode, 'IMPLEMENTATION_NOT_STARTED');
  }
  const detail = err instanceof Error ? err.message : String(err);
  const compact = detail.replace(/\s+/g, ' ').trim();
  const clipped = compact.length > 240 ? `${compact.slice(0, 240)}…` : compact;
  console.error('[product-build] approval failed', detail);
  return new ProductBuildError(
    clipped ? `${summary} ${clipped}` : summary,
    502,
    'APPROVAL_FAILED',
  );
}

function requireBrief(build: ProductBuild): ProductBuildBrief {
  if (!build.brief) {
    throw new ProductBuildError('Confirm the build brief before approving it.', 409, 'BRIEF_REQUIRED');
  }
  try {
    const brief = parseProductBuildBrief(build.brief);
    if (brief.singlePr.fitsSinglePr !== true) {
      throw new ProductBuildError('Trim the brief until it fits one pull request.', 409, 'NOT_SINGLE_PR');
    }
    return brief;
  } catch (err) {
    if (err instanceof ProductBuildError) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw new ProductBuildError(detail, 409, 'BRIEF_INVALID');
  }
}

async function requireReadyDesign(deps: ProductBuildDeps, build: ProductBuild): Promise<UiLabDesign> {
  if (!build.uiLabDesignId) {
    throw new ProductBuildError('The prototype is not ready to approve.', 409, 'PROTOTYPE_NOT_READY');
  }
  const design = await deps.getDesign(build.uiLabDesignId);
  if (!design || design.status !== 'ready' || !design.html?.trim()) {
    throw new ProductBuildError('The prototype is not ready to approve.', 409, 'PROTOTYPE_NOT_READY');
  }
  return design;
}

function stampBrief(brief: ProductBuildBrief, confirmedBy: string, confirmedAt: string): ProductBuildBrief {
  try {
    const stamped = parseProductBuildBrief({ ...brief, confirmedBy, confirmedAt });
    if (stamped.singlePr.fitsSinglePr !== true) {
      throw new ProductBuildError('Trim the brief until it fits one pull request.', 409, 'NOT_SINGLE_PR');
    }
    return stamped;
  } catch (err) {
    if (err instanceof ProductBuildError) throw err;
    const detail = err instanceof Error ? err.message : String(err);
    throw new ProductBuildError(detail, 409, 'BRIEF_INVALID');
  }
}

function prototypePrompt(brief: ProductBuildBrief): string {
  const slice = brief.initialBuild;
  const personas = slice.personas.map((item) => `${item.name} — ${item.goal}`).join('; ');
  const screens = slice.screens.map((item) => `${item.name} — ${item.purpose}`).join('; ');
  const data = slice.data.map((item) => `${item.name} — ${item.fields.join(', ')}`).join('; ');
  const integrations = slice.integrations.map((item) => `${item.name} — ${item.purpose}`).join('; ');
  const criteria = slice.acceptanceCriteria.map((item) => `${item.id} — ${item.statement}`).join('; ');
  return [
    `${NEW_PRODUCT_PROTOTYPE_MARKER}${brief.product.name}". Design only this application. Do not copy another product's name, navigation, pages, or visual style.`,
    `Who it is for: ${brief.product.audience}`,
    'Prototype only this initial build. Leave deferred and out-of-scope work out of the screens.',
    `Summary: ${slice.summary}`,
    `Core workflow: ${slice.coreWorkflow}`,
    `Visual direction: ${slice.visualDirection}`,
    `Auth: ${slice.auth}`,
    `Personas: ${personas || 'None.'}`,
    `Screens: ${screens || 'None.'}`,
    `Data: ${data || 'None.'}`,
    `Integrations: ${integrations || 'None.'}`,
    `Non-functional requirements: ${slice.nonFunctionalRequirements.join('; ') || 'None.'}`,
    `Acceptance criteria: ${criteria || 'None.'}`,
    `Out of scope: ${slice.outOfScope.join('; ') || 'None.'}`,
    `Deferred: ${slice.deferred.join('; ') || 'None.'}`,
  ].join('\n');
}

function requestContext(rfp: ProductBuildRfpContext): string {
  const lines = [
    'Approved product request. Use this as background. PRODUCT.md is the north star and is broader than this build. The build brief is one pull request.',
    `Title: ${rfp.title}`,
    `Request: ${rfp.request}`,
    `Problem: ${rfp.problem}`,
    `Audience: ${rfp.audience}`,
  ];
  const document = rfp.proposal?.document;
  if (document?.kind === 'proposal') {
    if (document.sections?.executiveSummary) {
      lines.push(`Proposal summary: ${document.sections.executiveSummary}`);
    }
    if (document.sections?.scope?.length) {
      lines.push(`Proposal scope: ${document.sections.scope.join('; ')}`);
    }
  }
  return lines.join('\n');
}

function toThreadSummary(thread: ChatThread): ChatThreadSummary {
  return {
    id: thread.id,
    userId: thread.userId,
    title: thread.kickoff.pillLabel?.trim() || 'Product discovery',
    status: thread.status,
    kickoff: {
      project: thread.kickoff.project,
      repo: thread.kickoff.repo,
      skillPath: thread.kickoff.skillPath,
      pillLabel: thread.kickoff.pillLabel,
      pillDescription: thread.kickoff.pillDescription,
    },
    flagged: thread.flagged,
    flaggedAt: thread.flaggedAt,
    createdAt: thread.createdAt,
    lastActivityAt: thread.lastActivityAt,
  };
}

const defaultService = createProductBuildService(defaultDeps);

export function getProductBuildSetup(project: string, userId: string): Promise<ProductBuildSetupStatus> {
  return defaultService.getSetup(project, userId);
}

export function startNextProductBuild(
  project: string,
  userId: string,
  prompt: unknown,
): Promise<ProductBuildSetupStatus> {
  return defaultService.startNext(project, userId, prompt);
}

export function syncProductBuild(buildId: string, userId: string): Promise<ProductBuildSetupStatus> {
  return defaultService.sync(buildId, userId);
}

export function regenerateProductPrototype(
  buildId: string,
  userId: string,
  feedback: unknown,
): Promise<ProductBuildSetupStatus> {
  return defaultService.regenerate(buildId, userId, feedback);
}

export function approveProductBuild(buildId: string, userId: string): Promise<ProductBuildSetupStatus> {
  return defaultService.approve(buildId, userId);
}
