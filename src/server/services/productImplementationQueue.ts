import { eq, sql } from 'drizzle-orm';
import {
  BUILD_BRIEF_MARKDOWN_PATH,
  BUILD_MANIFEST_PATH,
  PRODUCT_MARKDOWN_PATH,
  type ProductBuildBrief,
} from '../../shared/types/productBuild';
import { RFP_APPS_ADO_PROJECT } from '../../shared/types/rfpIntake';
import { db } from '../db/drizzle';
import { productBuilds } from '../db/schema';
import { AzureDevOpsService } from './azureDevOps';
import { startCloudAgentRun, type StartCloudAgentRunInput } from './cloudAgentService';
import type { ProductImplementationReceipt, ProductImplementationRequest } from './productBuildService';

const PRODUCT_PROTOTYPE_PATH = 'docs/product/prototype.html';
const PRODUCT_BUILD_ASSIGNEE = 'Ryan Miller';

export interface ProductFeatureSpec {
  adoProject: string;
  /** Apex - Apps uses the Basic process, which has Issue and no Feature. */
  type: 'Issue';
  title: string;
  description: string;
  acceptanceCriteriaHtml: string;
  tags: string[];
  assignedTo: string;
  idempotencyTag: string;
}

export interface ProductImplementationQueueDeps {
  withLock: <T>(buildId: string, work: () => Promise<T>) => Promise<T>;
  readIds: (buildId: string) => Promise<ProductImplementationReceipt | null>;
  saveIds: (buildId: string, ids: ProductImplementationReceipt) => Promise<void>;
  findFeatureByIdempotencyTag: (spec: ProductFeatureSpec) => Promise<number | null>;
  createFeature: (spec: ProductFeatureSpec) => Promise<number>;
  startRun: (input: StartCloudAgentRunInput) => Promise<{ sessionId: string; runId: string }>;
}

export function escapeWiqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

export function productBuildFeatureIdempotencyTag(buildId: string): string {
  const sanitized = buildId
    .trim()
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `apex-product-build-${sanitized || 'unknown'}`;
}

export function buildFeatureIdempotencyTagWiql(adoProject: string, idempotencyTag: string): string {
  return [
    'SELECT [System.Id] FROM WorkItems',
    `WHERE [System.TeamProject] = '${escapeWiqlLiteral(adoProject)}'`,
    "AND [System.WorkItemType] = 'Issue'",
    `AND [System.Tags] CONTAINS '${escapeWiqlLiteral(idempotencyTag)}'`,
  ].join(' ');
}

export async function findOrCreateProductFeature(
  spec: ProductFeatureSpec,
  deps: {
    findByTag: (spec: ProductFeatureSpec) => Promise<number | null>;
    create: (spec: ProductFeatureSpec) => Promise<number>;
  },
): Promise<number> {
  const existing = await deps.findByTag(spec);
  if (existing) return existing;
  return deps.create(spec);
}

export function productBuildImplementationLockKey(buildId: string): string {
  return `product-build:${buildId}`;
}

export function buildProductImplementationPrompt(request: ProductImplementationRequest): string {
  return [
    'Read the approved product artifacts on main and implement only that build.',
    `Repository: ${RFP_APPS_ADO_PROJECT}/${request.repoName}.`,
    `Read ${PRODUCT_MARKDOWN_PATH}, ${BUILD_BRIEF_MARKDOWN_PATH}, ${PRODUCT_PROTOTYPE_PATH}, and ${BUILD_MANIFEST_PATH}.`,
    'PRODUCT.md is context. The build brief and manifest are the scope of this pull request.',
    'If application code is already on main, extend it. Do not replace it.',
    'Invoke the product-implementation skill and follow it.',
    'Do not commit, push, or open a pull request. The runner does that.',
  ].join('\n');
}

export function buildProductFeatureSpec(request: ProductImplementationRequest): ProductFeatureSpec {
  const idempotencyTag = productBuildFeatureIdempotencyTag(request.buildId);
  return {
    adoProject: RFP_APPS_ADO_PROJECT,
    type: 'Issue',
    title: request.brief.initialBuild.summary,
    description: featureDescription(request),
    acceptanceCriteriaHtml: acceptanceHtml(request.brief),
    tags: ['apex', 'product-build', idempotencyTag],
    assignedTo: PRODUCT_BUILD_ASSIGNEE,
    idempotencyTag,
  };
}

export async function queueProductImplementation(
  request: ProductImplementationRequest,
  deps: ProductImplementationQueueDeps = defaultQueueDeps,
): Promise<ProductImplementationReceipt> {
  return deps.withLock(request.buildId, async () => {
    const current = await deps.readIds(request.buildId);
    if (current?.adoWorkItemId && current.devSessionId && current.agentRunId) {
      return {
        adoWorkItemId: current.adoWorkItemId,
        devSessionId: current.devSessionId,
        agentRunId: current.agentRunId,
      };
    }

    let adoWorkItemId = current?.adoWorkItemId ?? null;
    let devSessionId = current?.devSessionId ?? null;
    let agentRunId = current?.agentRunId ?? null;

    if (!adoWorkItemId) {
      const featureSpec = buildProductFeatureSpec(request);
      adoWorkItemId = await findOrCreateProductFeature(featureSpec, {
        findByTag: deps.findFeatureByIdempotencyTag,
        create: deps.createFeature,
      });
      await deps.saveIds(request.buildId, { adoWorkItemId, devSessionId, agentRunId });
    }

    if (!devSessionId || !agentRunId) {
      const started = await deps.startRun(buildStartInput(request, adoWorkItemId));
      devSessionId = started.sessionId;
      agentRunId = started.runId;
      await deps.saveIds(request.buildId, { adoWorkItemId, devSessionId, agentRunId });
    }

    return { adoWorkItemId, devSessionId, agentRunId };
  });
}

function buildStartInput(request: ProductImplementationRequest, workItemId: number): StartCloudAgentRunInput {
  return {
    userId: request.reviewerId,
    project: request.project,
    workItemId,
    workItemTitle: request.brief.initialBuild.summary,
    initiatorName: PRODUCT_BUILD_ASSIGNEE,
    adoUserToken: null,
    isSuperAdmin: false,
    item: {
      workItemType: 'Issue',
      state: 'New',
      tags: 'apex; product-build',
    },
    systemTriggered: true,
    promptOverride: buildProductImplementationPrompt(request),
    workItemProject: RFP_APPS_ADO_PROJECT,
    draftPullRequest: true,
    requiredReviewerId: request.reviewerId,
    allowServiceAccountPullRequest: true,
    enforceChecks: true,
  };
}

function featureDescription(request: ProductImplementationRequest): string {
  const repo = `${RFP_APPS_ADO_PROJECT}/${request.repoName}`;
  const files: Array<[string, string]> = [
    [PRODUCT_MARKDOWN_PATH, 'Product context. It is broader than this pull request.'],
    [BUILD_BRIEF_MARKDOWN_PATH, 'The scope of this pull request.'],
    [PRODUCT_PROTOTYPE_PATH, 'The approved screen prototype.'],
    [BUILD_MANIFEST_PATH, 'The same slice in structured form.'],
  ];
  const items = files.map(([filePath, why]) => (
    `<li><code>${escapeHtml(filePath)}</code> on <code>main</code> in <code>${escapeHtml(repo)}</code>. ${escapeHtml(why)}</li>`
  )).join('');
  const label = request.brief.kind === 'initial' ? 'initial build' : request.brief.kind;
  return `<p>Approved ${escapeHtml(label)} for ${escapeHtml(request.brief.product.name)}. These files are already on main in ${escapeHtml(repo)}.</p><ul>${items}</ul>`;
}

function acceptanceHtml(brief: ProductBuildBrief): string {
  const items = brief.initialBuild.acceptanceCriteria
    .map((item) => `<li><strong>${escapeHtml(item.id)}</strong> ${escapeHtml(item.statement)}</li>`)
    .join('');
  return `<ul>${items}</ul>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function withProductBuildLock<T>(buildId: string, work: () => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${productBuildImplementationLockKey(buildId)}))`);
    return work();
  });
}

async function readProductBuildIds(buildId: string): Promise<ProductImplementationReceipt | null> {
  const row = await db.query.productBuilds.findFirst({
    where: eq(productBuilds.id, buildId),
    columns: { adoWorkItemId: true, devSessionId: true, agentRunId: true },
  });
  if (!row) return null;
  return {
    adoWorkItemId: row.adoWorkItemId,
    devSessionId: row.devSessionId,
    agentRunId: row.agentRunId,
  };
}

async function saveProductBuildIds(buildId: string, ids: ProductImplementationReceipt): Promise<void> {
  await db.update(productBuilds).set({
    adoWorkItemId: ids.adoWorkItemId,
    devSessionId: ids.devSessionId,
    agentRunId: ids.agentRunId,
    updatedAt: new Date().toISOString(),
  }).where(eq(productBuilds.id, buildId));
}

function appsAdo(spec: ProductFeatureSpec): AzureDevOpsService {
  return new AzureDevOpsService(spec.adoProject, spec.adoProject);
}

async function findFeatureByIdempotencyTag(spec: ProductFeatureSpec): Promise<number | null> {
  const ado = appsAdo(spec);
  const result = await ado.queryWorkItemsByWiql({
    wiql: buildFeatureIdempotencyTagWiql(spec.adoProject, spec.idempotencyTag),
  });
  const first = result.items[0];
  if (!first?.id) return null;
  return first.id;
}

const defaultQueueDeps: ProductImplementationQueueDeps = {
  withLock: withProductBuildLock,
  readIds: readProductBuildIds,
  saveIds: saveProductBuildIds,
  findFeatureByIdempotencyTag,
  createFeature: async (spec) => {
    const created = await appsAdo(spec).createWorkItemForPrd({
      type: spec.type,
      title: spec.title,
      description: spec.description,
      acceptanceCriteriaHtml: spec.acceptanceCriteriaHtml,
      tags: spec.tags,
      assignedTo: spec.assignedTo,
    });
    return created.id;
  },
  startRun: async (input) => {
    const started = await startCloudAgentRun(input);
    return { sessionId: started.sessionId, runId: started.runId };
  },
};
