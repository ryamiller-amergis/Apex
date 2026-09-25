import {
  eq,
  and,
  asc,
  count,
  desc,
  inArray,
  lt,
  notExists,
  sql,
  type SQL,
} from 'drizzle-orm';
import { db } from '../db/drizzle';
import {
  agentRuns,
  designPrototypes,
  designPrototypeComments,
  designPlans,
  designDocs,
  prds,
  documentApproverAssignments,
} from '../db/schema';
import type { DesignPlanFeature } from '../../shared/types/designPlan';
import { resolvePrototypeVisualModel, type DesignPrototypeInput } from './bedrockService';
import { sanitizeMockHtml } from '../utils/htmlSanitizer';
import { isAdminUser } from '../utils/rbacHelpers';
import { isAssignedApprover } from './documentApprovalService';
import { notifyAiCompletion } from './aiCompletionNotifier';
import { prototypeUsageCtx } from './artifactUsageContext';
import { resolveAgentRunHardLimitMs } from './agentRunReaperService';
import {
  createPrototypeSpecificationAssembler,
  resolvePrototypeSourceContext,
  type PrototypeDesignContext,
} from './aiRunV2/prototypeSpecificationAssembler';
import {
  createV2AdmissionService,
  visualGenerationRunId,
  visualRunThreadId,
  visualRunThreadPrefix,
  type V2AdmissionService,
} from './aiRunV2/v2AdmissionService';
import {
  buildProjectPrototypeScopingSection,
  buildPrototypePageScreenshotHint,
  buildPrototypePbiSection,
  buildPrototypePlanSection,
  buildPrototypeScopingSection,
  buildPrototypeTargetScreenHint,
} from './designContext/prototypePromptSections';
import {
  componentIndexPaths,
  fetchExistingPageContext,
  getDesignSystemCatalog,
  getScreenInventory,
  isComponentSourcePath,
  type DesignSystemCatalog,
  type DesignSystemAdoTarget,
} from './designSystemService';
import { getMaxviewColorTokens } from './designTokensService';
import { isFeatureEnabled } from './featureFlagService';
import { getFigmaReference } from './figmaReferenceService';
import { getScreenshotByRoute } from './pageScreenshotService';
import {
  resolvePrototypeExtendMode,
  resolvePrototypeContext,
  type PrototypeContext,
} from './prototypeContextService';
import { getRepoCacheDir } from './repoCacheService';
import { BareRepoReader } from './repoRead/bareRepoReader';
import { cacheOptionsFromGrounding, isUsableBareMirror } from './repoRead/mirrorStore';
import { resolveRunGroundingSurface, runGroundingService } from './runGroundingService';
import { getDesignReferences } from './webDesignReferenceService';
import { stampFeatureLinkId } from '../../shared/utils/backlogTransform';
import { resolveUserStoryIWant } from '../../shared/utils/userStory';
import type { RepoReader } from '../../shared/types/repoReader';
import type { ScreenInventoryRoute } from '../../shared/types/designSystem';
import type {
  AiRunV2VisualSpecification,
  PrototypePromptSelection,
  VisualImageBlock,
  VisualUsageAttribution,
} from '../../shared/types/aiRunV2VisualSpec';
import type {
  DesignPrototypeSummary,
  DesignPrototype,
  DesignPrototypeComment,
  DesignPrototypeHistoryEntry,
  DesignPrototypeStateName,
  PbiRequirement,
} from '../../shared/types/designPrototype';

const DEFAULT_DESIGN_PROTOTYPE_MODEL =
  process.env.BEDROCK_UI_MOCK_MODEL_ID
  ?? process.env.BEDROCK_MODEL_ID
  ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

type AcceptanceCriterionEntry =
  | string
  | { given?: string; when?: string; then?: string; value?: string; text?: string; scenario?: string };

interface BacklogItem {
  id?: string;
  type?: string;
  workItemType?: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string | AcceptanceCriterionEntry[];
  acceptance_criteria?: string | AcceptanceCriterionEntry[];
  definitionOfDone?: string[];
  userStory?: {
    persona?: string;
    iWant?: string;
    want?: string;
    soThat?: string;
  };
  /** Apex persona names (e.g. Platform Admin, Developer) this item applies to. */
  userTypes?: string[];
  /** Same control, different behavior per persona group. */
  personaBehaviors?: Array<{ userTypes: string[]; behavior: string }>;
}

export interface BacklogFeature {
  title: string;
  description?: string;
  items?: BacklogItem[];
  pbis?: BacklogItem[];
  designDocId?: string;
  designPrototypeId?: string;
  /** Optional route of an existing MaxView page this feature extends (enables EXTEND mode). */
  route?: string;
}

interface BacklogJson {
  epics?: Array<{
    features?: BacklogFeature[];
  }>;
  features?: BacklogFeature[];
}

export function extractFeatures(backlogJson: unknown): BacklogFeature[] {
  const bj = backlogJson as BacklogJson | null;
  if (!bj) return [];

  const features: BacklogFeature[] = [];

  if (bj.features) {
    features.push(...bj.features);
  }

  if (bj.epics) {
    for (const epic of bj.epics) {
      if (epic.features) {
        features.push(...epic.features);
      }
    }
  }

  return features;
}

/** True for PBI child items; excludes TBIs and other non-PBI work item types. */
function isPbiBacklogItem(item: BacklogItem): boolean {
  if (item.type === 'TBI' || item.workItemType === 'TBI') return false;
  if (item.type === 'PBI' || item.workItemType === 'PBI' || item.workItemType === 'Product Backlog Item') {
    return true;
  }
  // Untyped legacy entries under feature.items are treated as PBIs (TBIs are always typed).
  if (item.type && item.type !== 'PBI') return false;
  return true;
}

/**
 * Normalise a single acceptance-criterion entry to a readable string. Backlog AC can be a
 * plain string, a Gherkin object ({ given, when, then }), or a form-array leak ({ value }).
 */
function formatAcceptanceCriterion(entry: AcceptanceCriterionEntry): string {
  if (typeof entry === 'string') return entry.trim();
  if (!entry || typeof entry !== 'object') return '';

  if (typeof entry.value === 'string' && entry.value.trim()) return entry.value.trim();
  if (typeof entry.text === 'string' && entry.text.trim()) return entry.text.trim();

  const parts: string[] = [];
  if (entry.given?.trim()) parts.push(`Given ${entry.given.trim()}`);
  if (entry.when?.trim()) parts.push(`When ${entry.when.trim()}`);
  if (entry.then?.trim()) parts.push(`Then ${entry.then.trim()}`);
  return parts.join(', ');
}

function formatAcceptanceCriteriaList(lines: string[]): string | undefined {
  const filtered = lines.map(l => l.trim()).filter(Boolean);
  if (filtered.length === 0) return undefined;
  return filtered.length === 1 ? filtered[0] : filtered.map(l => `- ${l}`).join('\n');
}

function extractAcceptanceCriteria(item: BacklogItem): string | undefined {
  const raw = item.acceptanceCriteria ?? item.acceptance_criteria;

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed || undefined;
  }

  if (Array.isArray(raw) && raw.length > 0) {
    return formatAcceptanceCriteriaList(raw.map(formatAcceptanceCriterion));
  }

  if (item.definitionOfDone?.length) {
    return formatAcceptanceCriteriaList(item.definitionOfDone);
  }

  return undefined;
}

function mapBacklogItemToPbiRequirement(item: BacklogItem): PbiRequirement {
  let description = item.description?.trim();
  if (!description && item.userStory) {
    const us = item.userStory;
    description = `As a ${us.persona ?? 'user'}, I want to ${resolveUserStoryIWant(us) || '...'} so that ${us.soThat ?? '...'}`;
  }

  return {
    title: item.title,
    description,
    acceptanceCriteria: extractAcceptanceCriteria(item),
    userTypes: item.userTypes,
    personaBehaviors: item.personaBehaviors,
  };
}

/** Extract only PBI-type child items for a feature (excludes TBIs). */
export function extractPbiRequirements(feature: BacklogFeature): PbiRequirement[] {
  const items = (feature.items ?? feature.pbis ?? []).filter(isPbiBacklogItem);
  return items.map(mapBacklogItemToPbiRequirement);
}

/**
 * Scope PBI requirements to those associated with a feature. When a design plan exists,
 * its per-feature pbiContributions list is the authoritative allowlist (matched by title).
 */
export function scopePbiRequirementsForFeature(
  feature: BacklogFeature,
  planFeature?: DesignPlanFeature,
): PbiRequirement[] {
  const requirements = extractPbiRequirements(feature);
  if (!planFeature?.pbiContributions?.length) return requirements;

  const byTitle = new Map(
    requirements.map(r => [r.title.trim().toLowerCase(), r]),
  );

  return planFeature.pbiContributions.map(contrib => {
    const key = contrib.pbiTitle.trim().toLowerCase();
    const existing = byTitle.get(key);
    if (existing) return existing;
    return {
      title: contrib.pbiTitle,
      description: contrib.contribution,
    };
  });
}

function resolveUserName(_userId: string): string | undefined {
  return undefined;
}

function toSummary(row: typeof designPrototypes.$inferSelect): DesignPrototypeSummary {
  return {
    id: row.id,
    prdId: row.prdId,
    featureName: row.featureName,
    featureIndex: row.featureIndex,
    authorId: row.authorId,
    authorName: resolveUserName(row.authorId),
    model: row.model ?? undefined,
    effort: row.effort ?? undefined,
    status: row.status as DesignPrototypeSummary['status'],
    mockVersion: row.mockVersion,
    reviewerId: row.reviewerId ?? undefined,
    reviewerName: row.reviewerId ? resolveUserName(row.reviewerId) : undefined,
    reviewComment: row.reviewComment ?? undefined,
    reviewedAt: row.reviewedAt ?? undefined,
    generationError: row.generationError ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ── Generation ──────────────────────────────────────────────────────────────

/**
 * How many prototype HTML generations may hit Bedrock at once. Firing every
 * feature in parallel throttles large models (Opus/Sonnet) hard — concurrent
 * calls pile into ThrottlingException, back off, and blow past the per-call
 * timeout. A small cap keeps each call un-throttled so it finishes in normal
 * time. Override via DESIGN_PROTOTYPE_CONCURRENCY (default 2).
 */
const PROTOTYPE_GENERATION_CONCURRENCY = (() => {
  const raw = process.env.DESIGN_PROTOTYPE_CONCURRENCY;
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 2;
})();

/**
 * Run `task` over each item with at most `limit` running concurrently.
 * Resolves when all have settled. Tasks are expected to handle their own errors
 * (each generation persists its own failure state), so rejections are logged.
 */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workerCount = Math.min(limit, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await task(items[index]);
    }
  });
  await Promise.all(workers);
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => HTML_ESCAPES[char]);
}

type PrototypeSkipReason = 'no-ui' | 'no-pbi';

/**
 * Decide whether a feature actually needs an LLM-generated HTML prototype.
 * Features the design plan marked `no-ui` (backend, infra, config, or scheduled
 * jobs) or that have no linked PBIs have nothing to render — generating a mock
 * for them only burns Bedrock output tokens for a "No UI" placeholder. Returning
 * a reason here lets the caller skip the model call entirely.
 */
function resolvePrototypeSkipReason(
  feature: BacklogFeature,
  planFeature?: DesignPlanFeature,
): PrototypeSkipReason | null {
  if (planFeature?.decision === 'no-ui') return 'no-ui';
  if (extractPbiRequirements(feature).length === 0) return 'no-pbi';
  return null;
}

/**
 * Deterministic, self-contained placeholder rendered for features that need no UI
 * prototype. Built locally (zero model tokens) and shown in the review iframe so
 * the feature stays visible and the reviewer understands why no mock exists.
 */
function buildSkippedPrototypeHtml(
  featureName: string,
  reason: PrototypeSkipReason,
  planFeature?: DesignPlanFeature,
): string {
  const heading = reason === 'no-ui' ? 'No User Interface Required' : 'Nothing to Prototype';
  const chip = reason === 'no-ui' ? 'Backend / server-side only' : 'No linked PBIs';
  const explanation = reason === 'no-ui'
    ? 'The design plan classified this feature as backend, infrastructure, configuration, or a scheduled job with no user-facing surface. No prototype was generated, so no AI tokens were spent.'
    : 'This feature has no linked PBIs, so there are no requirements to render. No prototype was generated, so no AI tokens were spent.';

  const context = planFeature?.designBrief?.trim() || planFeature?.rationale?.trim();
  const contextBlock = context
    ? `<div class="ctx"><div class="ctx-label">From the design plan</div><div class="ctx-body">${escapeHtml(context)}</div></div>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(featureName)} — No UI</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif; background: #f4f5f7; color: #1f2430; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 40px; }
  .card { background: #ffffff; border: 1px solid #e3e6ea; border-radius: 12px; max-width: 560px; width: 100%; padding: 40px; text-align: center; box-shadow: 0 1px 3px rgba(16,24,40,0.06); }
  .icon { width: 56px; height: 56px; border-radius: 50%; background: #eef0f4; color: #5b6472; display: flex; align-items: center; justify-content: center; margin: 0 auto 20px; }
  h1 { font-size: 20px; font-weight: 600; margin: 0 0 8px; }
  .feature { font-size: 13px; color: #6b7280; margin: 0 0 16px; }
  .chip { display: inline-block; font-size: 12px; font-weight: 600; color: #5b6472; background: #eef0f4; border-radius: 999px; padding: 4px 12px; margin-bottom: 16px; }
  p.explain { font-size: 14px; line-height: 1.5; color: #4a5160; margin: 0; }
  .ctx { text-align: left; margin-top: 24px; padding: 16px; background: #f8f9fb; border: 1px solid #e3e6ea; border-radius: 8px; }
  .ctx-label { font-size: 11px; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: #8a93a2; margin-bottom: 6px; }
  .ctx-body { font-size: 13px; line-height: 1.5; color: #4a5160; white-space: pre-wrap; }
</style>
</head>
<body>
  <div class="card">
    <div class="icon">
      <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14zM7 7h10v2H7V7zm0 4h10v2H7v-2zm0 4h7v2H7v-2z"/></svg>
    </div>
    <h1>${escapeHtml(heading)}</h1>
    <div class="feature">${escapeHtml(featureName)}</div>
    <div class="chip">${escapeHtml(chip)}</div>
    <p class="explain">${escapeHtml(explanation)}</p>
    ${contextBlock}
  </div>
</body>
</html>`;
}

const V2_TRANSPORT_FLAG = 'ai-runs-v2-transport';

/** A prototype is visual work: one model call producing one HTML artifact. */
const VISUAL_WORKLOAD_LANE = 'visual' as const;

type PendingPrototype = {
  prototypeId: string;
  feature: BacklogFeature;
  planFeature?: DesignPlanFeature;
  generationStartedAt: string;
};

type GenerateInProcess = typeof generateSinglePrototype;

type FeatureFlagEvaluator = (
  key: string,
  context: { userId: string; project: string; caller?: string },
) => Promise<boolean>;

export type PrototypeV2AdmissionState =
  | 'intended'
  | 'absent'
  | 'conflicting';

export type ReconcilePrototypeV2Admission = (input: Readonly<{
  runId: string;
  threadId: string;
  subjectId: string;
  generationStartedAt: string;
}>) => Promise<PrototypeV2AdmissionState>;

export interface GeneratePrototypesDependencies {
  isFeatureEnabled?: FeatureFlagEvaluator;
  admitV2Run?: V2AdmissionService['admit'];
  reconcileV2Admission?: ReconcilePrototypeV2Admission;
  generateInProcess?: GenerateInProcess;
}

async function reconcilePrototypeV2Admission(
  input: Parameters<ReconcilePrototypeV2Admission>[0],
): Promise<PrototypeV2AdmissionState> {
  const rows = await db
    .select({
      id: agentRuns.id,
      threadId: agentRuns.threadId,
      transportVersion: agentRuns.transportVersion,
      executionSnapshot: agentRuns.executionSnapshot,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, input.runId));
  const run = rows[0];
  if (!run) return 'absent';

  const snapshot = run.executionSnapshot as Record<string, unknown> | null;
  return (
    run.threadId === input.threadId
    && run.transportVersion === 'servicebus-blob-v2'
    && snapshot?.workflowClass === 'design-prototype'
    && snapshot.subjectKind === 'design-prototype'
    && snapshot.subjectId === input.subjectId
    && snapshot.generationStartedAt === input.generationStartedAt
  )
    ? 'intended'
    : 'conflicting';
}

/**
 * The route this feature extends, if any. The reviewed plan is authoritative:
 * prefer its route decision over the raw backlog route.
 */
function resolvePrototypeTargetRoute(
  feature: BacklogFeature,
  planFeature?: DesignPlanFeature,
): string | undefined {
  const planRoute = planFeature?.decision === 'update-page'
    ? planFeature.targetRoute?.trim()
    : undefined;
  return planRoute || feature.route?.trim() || undefined;
}

/**
 * Design context a worker cannot read for itself: the catalog and screen
 * inventory come from Azure DevOps, the palette and navigation from bundled
 * assets. Resolved here and frozen into the specification.
 *
 * The reference screenshot travels the same way. `bedrockService` attaches it
 * to the in-process call as a vision input and the prompt tells the model to
 * read it, so a specification without it asks the model to match a screenshot
 * it cannot see. The asset can be absent, in which case the fields stay unset
 * and the worker sends text only, exactly as the in-process path does.
 */
async function loadPrototypeDesignContext(
  componentReader?: RepoReader,
  relevanceText = '',
): Promise<PrototypeDesignContext> {
  const [catalog, screenInventory] = await Promise.all([
    getDesignSystemCatalog({
      ...(componentReader ? { componentReader } : {}),
      relevanceText,
    }),
    getScreenInventory(),
  ]);
  const figma = getFigmaReference();
  return {
    catalog,
    screenInventory,
    colorTokens: getMaxviewColorTokens(),
    navItems: figma.navItems,
    images: figma.tablePageBase64
      ? [
          {
            kind: 'design-reference',
            base64: figma.tablePageBase64,
            mediaType: 'image/png',
            ...(figma.tablePageWidth > 0 ? { width: figma.tablePageWidth } : {}),
            ...(figma.tablePageHeight > 0 ? { height: figma.tablePageHeight } : {}),
          },
        ]
      : [],
  };
}

/**
 * None of it, for a project that has its own design system.
 *
 * `generateDesignPrototypeHtml` skips the catalog, the inventory, the
 * palette, and the Figma reference outright on that branch, and its prompt
 * mentions none of them. The screenshot is the one that matters: carrying it
 * anyway would put a vision input in front of the model that the in-process
 * call never sends.
 */
async function loadProjectPrototypeDesignContext(): Promise<PrototypeDesignContext> {
  return {
    catalog: undefined,
    screenInventory: undefined,
    colorTokens: undefined,
    navItems: [],
    images: [],
  };
}

/** The component files the design-system catalog already walks, uncapped. */
async function resolveComponentSourcePaths(reader: RepoReader): Promise<string[]> {
  for (const folder of componentIndexPaths()) {
    try {
      const paths = (await reader.listDir(folder))
        .filter(entry => !entry.isFolder)
        .map(entry => entry.path)
        .filter(isComponentSourcePath);
      if (paths.length > 0) return paths;
    } catch {
      // Component folder layouts differ per repo; try the next candidate.
    }
  }
  return [];
}

/**
 * Repository source for the specification, read from the same bare mirror a
 * background worker would use. Best effort: with no active target grounding,
 * or no mirror fetched on this instance, there is nothing to read. The
 * specification is still complete — a new-page prompt has never carried
 * component source — so this degrades context rather than blocking the run.
 */
async function resolvePrototypeRepoSource(
  prdId: string,
): Promise<{ reader: RepoReader; sourcePaths: string[] } | null> {
  try {
    const surface = await resolveRunGroundingSurface('prd', prdId);
    if (!surface) return null;

    const grounding = (await runGroundingService.getGroundings(surface.run))
      .find(row => row.repoRole === 'target' && row.isActive);
    if (!grounding?.groundedSha) return null;

    const cacheOptions = cacheOptionsFromGrounding(grounding);
    const mirrorPath = getRepoCacheDir(cacheOptions);
    if (!isUsableBareMirror(mirrorPath)) return null;

    const reader = new BareRepoReader({
      identity: {
        provider: cacheOptions.provider,
        project: grounding.project,
        repo: grounding.repository,
        sha: grounding.groundedSha,
      },
      mirrorPath,
    });
    return { reader, sourcePaths: await resolveComponentSourcePaths(reader) };
  } catch (err) {
    console.warn(`[designPrototypeService] Repository source unavailable for PRD ${prdId}:`, err);
    return null;
  }
}

type ResolvedPrototypeExtendInputs = Readonly<{
  targetRoute: string | undefined;
  existingPageContext: string;
  extendMode: boolean;
  targetScreenHint: string;
  pageScreenshotHint: string;
  pageScreenshot?: { base64: string; mediaType: string };
  images: ReadonlyArray<VisualImageBlock>;
}>;

function prototypeFeatureText(feature: BacklogFeature): string {
  return [
    feature.title,
    feature.description,
    ...extractPbiRequirements(feature).flatMap((pbi) => [
      pbi.title,
      pbi.description,
      pbi.acceptanceCriteria,
    ]),
  ]
    .filter((part): part is string => Boolean(part))
    .join(' ');
}

function prototypeAdoTarget(
  projectContext: PrototypeContext | null,
): DesignSystemAdoTarget | undefined {
  const extend = projectContext?.extend;
  return extend
    ? {
        provider: extend.provider,
        adoProject: extend.adoProject,
        repo: extend.repo,
        branch: extend.branch,
        inventoryPath: extend.screenInventoryPath ?? undefined,
      }
    : undefined;
}

/**
 * Resolve every route-specific EXTEND input before admission. A visual worker
 * has neither database access for screenshots nor repository credentials for
 * page source, so an immutable specification must carry the finished context.
 */
async function resolvePrototypeExtendInputs(params: {
  feature: BacklogFeature;
  planFeature?: DesignPlanFeature;
  projectContext: PrototypeContext | null;
}): Promise<ResolvedPrototypeExtendInputs> {
  const targetRoute = resolvePrototypeTargetRoute(
    params.feature,
    params.planFeature,
  );
  if (!targetRoute) {
    return {
      targetRoute: undefined,
      existingPageContext: '',
      extendMode: false,
      targetScreenHint: '',
      pageScreenshotHint: '',
      images: [],
    };
  }

  let pageScreenshot:
    | { base64: string; mediaType: string; width?: number; height?: number }
    | undefined;
  try {
    const screenshot = await getScreenshotByRoute(targetRoute);
    if (screenshot) {
      pageScreenshot = {
        base64: screenshot.imageBase64,
        mediaType: screenshot.mediaType,
        ...(screenshot.width != null && screenshot.width > 0
          ? { width: screenshot.width }
          : {}),
        ...(screenshot.height != null && screenshot.height > 0
          ? { height: screenshot.height }
          : {}),
      };
    }
  } catch (error) {
    console.warn(
      `[designPrototypeService] Page screenshot lookup failed for ${targetRoute}:`,
      error,
    );
  }

  const target = prototypeAdoTarget(params.projectContext);
  let existingPageContext = '';
  try {
    existingPageContext = await fetchExistingPageContext(
      targetRoute,
      prototypeFeatureText(params.feature),
      target,
    );
  } catch (error) {
    console.warn(
      `[designPrototypeService] Existing page context lookup failed for ${targetRoute}:`,
      error,
    );
  }

  let screenInventory: ScreenInventoryRoute[] = [];
  try {
    if (target?.inventoryPath) {
      screenInventory = await getScreenInventory(target);
    } else if (!params.projectContext) {
      screenInventory = await getScreenInventory();
    }
  } catch (error) {
    console.warn(
      `[designPrototypeService] Screen inventory lookup failed for ${targetRoute}:`,
      error,
    );
  }

  const { extendMode, attachScreenshot } = resolvePrototypeExtendMode({
    targetRoute,
    existingPageContext,
    pageScreenshot,
  });
  const targetScreenHint = buildPrototypeTargetScreenHint({
    extendMode,
    targetRoute,
    screenInventory,
  });
  const pageScreenshotHint = buildPrototypePageScreenshotHint({
    extendMode,
    hasPageScreenshot: Boolean(pageScreenshot),
  });
  const images: VisualImageBlock[] =
    attachScreenshot && pageScreenshot
      ? [
          {
            kind: 'existing-page',
            base64: pageScreenshot.base64,
            mediaType:
              pageScreenshot.mediaType === 'image/jpeg'
                ? 'image/jpeg'
                : 'image/png',
            ...(pageScreenshot.width !== undefined
              ? { width: pageScreenshot.width }
              : {}),
            ...(pageScreenshot.height !== undefined
              ? { height: pageScreenshot.height }
              : {}),
          },
        ]
      : [];

  return {
    targetRoute,
    existingPageContext,
    extendMode,
    targetScreenHint,
    pageScreenshotHint,
    ...(pageScreenshot
      ? {
          pageScreenshot: {
            base64: pageScreenshot.base64,
            mediaType: pageScreenshot.mediaType,
          },
        }
      : {}),
    images,
  };
}

function buildPrototypePromptInputs(
  feature: BacklogFeature,
  planFeature: DesignPlanFeature | undefined,
  projectContext: PrototypeContext | null,
  extend: ResolvedPrototypeExtendInputs,
): Record<string, unknown> {
  return {
    featureName: feature.title,
    featureDescription: feature.description ?? '',
    planSection: buildPrototypePlanSection({
      plan: planFeatureToInput(planFeature),
      extendMode: extend.extendMode,
      targetRoute: extend.targetRoute,
    }),
    pbiSection: buildPrototypePbiSection(extractPbiRequirements(feature)),
    scopingSection: projectContext
      ? buildProjectPrototypeScopingSection({
          extendMode: extend.extendMode,
          featureName: feature.title,
          targetRoute: extend.targetRoute,
          pageScreenshot: extend.pageScreenshot,
          existingPageContext: extend.existingPageContext,
          targetScreenHint: extend.targetScreenHint,
          pageScreenshotHint: extend.pageScreenshotHint,
        })
      : buildPrototypeScopingSection({
          extendMode: extend.extendMode,
          targetRoute: extend.targetRoute,
          pageScreenshot: extend.pageScreenshot,
          existingPageContext: extend.existingPageContext,
          targetScreenHint: extend.targetScreenHint,
          pageScreenshotHint: extend.pageScreenshotHint,
        }),
    extendMode: extend.extendMode,
    targetRoute: extend.targetRoute ?? null,
    existingPageContext: extend.existingPageContext,
    targetScreenHint: extend.targetScreenHint,
    pageScreenshotHint: extend.pageScreenshotHint,
  };
}

/**
 * The design system this project prototypes against, or null for the bundled
 * MaxView one. A worker cannot answer this: the skill lives in the project's
 * own repository behind credentials App Service holds.
 */
type PrototypeBranchResolution =
  | Readonly<{ status: 'resolved'; projectContext: PrototypeContext | null }>
  | Readonly<{ status: 'unresolved'; reason: string }>;

async function resolvePrototypeBranch(params: {
  project: string;
  skillSettingsId: string | null;
  skillRepoConfigured: boolean;
}): Promise<PrototypeBranchResolution> {
  try {
    const projectContext = await resolvePrototypeContext(
      params.project,
      params.skillSettingsId,
    );
    if (projectContext) return { status: 'resolved', projectContext };

    // A project that configured a skill repo and cannot be read is a
    // configuration error the in-process path reports onto the prototype
    // row. There is no design system to freeze into a specification, so let
    // the path that can write that error take the run.
    if (params.skillRepoConfigured) {
      return { status: 'unresolved', reason: 'its design-system skill could not be read' };
    }
    return { status: 'resolved', projectContext: null };
  } catch (err) {
    return {
      status: 'unresolved',
      reason: `resolving its design system failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

/**
 * Live web design references, which only the project branch carries and only
 * where the project turned them on. The search needs an API key, so it is
 * run here and the result travels on the specification. A failed search
 * leaves the section out, exactly as it does in process.
 */
async function resolvePrototypeWebReferences(params: {
  enabled: boolean;
  feature: BacklogFeature;
  appName: string;
}): Promise<string | undefined> {
  if (!params.enabled) return undefined;

  try {
    const references = await getDesignReferences({
      featureName: params.feature.title,
      featureDescription: params.feature.description,
      designSystemName: params.appName,
    });
    return references || undefined;
  } catch (err) {
    console.warn(
      `[designPrototypeService] Web design references failed for "${params.feature.title}":`,
      err,
    );
    return undefined;
  }
}

/**
 * Which of the two prototype prompts this run is for, with everything that
 * prompt reads. The MaxView branch needs nothing beyond its name; the
 * project branch carries its design system and, per feature, its references.
 */
async function resolvePrototypePromptSelection(params: {
  projectContext: PrototypeContext | null;
  feature: BacklogFeature;
  webReferencesEnabled: boolean;
  extendMode: boolean;
}): Promise<PrototypePromptSelection> {
  const { projectContext } = params;
  if (!projectContext) return { branch: 'maxview' };

  const webReferences = await resolvePrototypeWebReferences({
    enabled: params.webReferencesEnabled && !params.extendMode,
    feature: params.feature,
    appName: projectContext.appName,
  });

  return {
    branch: 'project-design-system',
    appName: projectContext.appName,
    designSystemMarkdown: projectContext.designSystemMarkdown,
    extendMode: params.extendMode,
    ...(webReferences !== undefined ? { webReferences } : {}),
  };
}

/**
 * Admit each pending prototype onto the V2 visual lane, falling back to the
 * in-process path per prototype so one refused admission cannot leave a row
 * stuck in `generating`.
 */
async function admitPendingPrototypesToV2(params: {
  prdId: string;
  project: string;
  userId: string;
  skillSettingsId: string | null;
  modelId: string;
  maxTokens?: number;
  timeoutMs?: number;
  pending: PendingPrototype[];
  skillRepoConfigured: boolean;
  webReferencesEnabled: boolean;
  admitV2Run: V2AdmissionService['admit'];
  reconcileV2Admission: ReconcilePrototypeV2Admission;
  generateInProcess: GenerateInProcess;
}): Promise<void> {
  const branch = await resolvePrototypeBranch({
    project: params.project,
    skillSettingsId: params.skillSettingsId,
    skillRepoConfigured: params.skillRepoConfigured,
  });
  const projectContext = branch.status === 'resolved' ? branch.projectContext : null;

  // The project prompt has no repository-source section to put a component
  // read into, so the mirror is only worth reading for the MaxView branch.
  const source =
    branch.status === 'resolved' && !projectContext
      ? await resolvePrototypeRepoSource(params.prdId)
      : null;
  const assembler = createPrototypeSpecificationAssembler({
    reader: source?.reader,
    loadDesignContext: projectContext
      ? loadProjectPrototypeDesignContext
      : (input) =>
          loadPrototypeDesignContext(
            source?.reader,
            input.sourceRelevanceText,
          ),
  });
  const timeoutAt = new Date(Date.now() + resolveAgentRunHardLimitMs()).toISOString();

  // A worker holds no policy: it can read neither the project override nor
  // the environment the app default is tuned by, so the effective values are
  // resolved here and every specification carries a concrete number.
  const model = resolvePrototypeVisualModel({
    modelId: params.modelId,
    maxTokens: params.maxTokens,
    timeoutMs: params.timeoutMs,
  });

  await runWithConcurrency(
    params.pending,
    PROTOTYPE_GENERATION_CONCURRENCY,
    async ({ prototypeId, feature, planFeature, generationStartedAt }) => {
      const fallBackInProcess = (reason: string): void => {
        console.warn(
          `[designPrototypeService] Prototype ${prototypeId} stays in process — ${reason}`,
        );
        void params.generateInProcess(
          prototypeId,
          feature,
          params.modelId,
          params.maxTokens,
          planFeature,
          params.timeoutMs,
          params.project,
          params.skillSettingsId,
          params.prdId,
        ).catch(err => {
          console.error(
            `[designPrototypeService] Background generation failed for ${prototypeId}:`,
            err,
          );
        });
      };

      if (branch.status === 'unresolved') {
        fallBackInProcess(branch.reason);
        return;
      }

      const usage: VisualUsageAttribution = {
        feature: 'design-prototype',
        project: params.project,
        userId: params.userId,
      };
      const threadId = visualRunThreadId(
        'design-prototype',
        prototypeId,
      );
      const runId = visualGenerationRunId(
        'design-prototype',
        prototypeId,
        generationStartedAt,
      );
      const admissionIdentity = {
        runId,
        threadId,
        subjectId: prototypeId,
        generationStartedAt,
      };
      let admissionAttempted = false;

      try {
        const extend = await resolvePrototypeExtendInputs({
          feature,
          planFeature,
          projectContext,
        });
        const prototypePrompt = await resolvePrototypePromptSelection({
          projectContext,
          feature,
          webReferencesEnabled: params.webReferencesEnabled,
          extendMode: extend.extendMode,
        });
        const specification: AiRunV2VisualSpecification = await assembler.assemble({
          prototypeId,
          prototypePrompt,
          promptInputs: buildPrototypePromptInputs(
            feature,
            planFeature,
            projectContext,
            extend,
          ),
          sourcePaths: source?.sourcePaths ?? [],
          sourceRelevanceText: prototypeFeatureText(feature),
          images: extend.images,
          model,
          usage,
        });

        admissionAttempted = true;
        const admitted = await params.admitV2Run({
          runId,
          threadId,
          projectId: params.project,
          workloadLane: VISUAL_WORKLOAD_LANE,
          capacityClass: 'batch',
          timeoutAt,
          specification: specification as unknown as Record<string, unknown>,
          executionSnapshot: {
            workflowClass: 'design-prototype',
            subjectKind: 'design-prototype',
            subjectId: prototypeId,
            generationStartedAt,
          },
        });
        if (!admitted) {
          throw new Error('V2 admission returned no result');
        }
        switch (admitted.status) {
          case 'dispatched':
            return;
          case 'active_run_conflict':
            if (
              admitted.existingRunId === runId
              && admitted.existingTransportVersion === 'servicebus-blob-v2'
            ) {
              return;
            }
            fallBackInProcess(
              `admission conflicted with unrelated run ${admitted.existingRunId}`,
            );
            return;
          default: {
            const unhandled: never = admitted;
            throw new Error(
              `Unsupported V2 admission result: ${String(unhandled)}`,
            );
          }
        }
      } catch (err) {
        console.error(
          `[designPrototypeService] V2 admission failed for ${prototypeId}:`,
          err,
        );
        if (!admissionAttempted) {
          fallBackInProcess('V2 preparation failed before admission');
          return;
        }
        try {
          const state = await params.reconcileV2Admission(admissionIdentity);
          if (state === 'absent') {
            fallBackInProcess('V2 admission rollback was confirmed');
          } else {
            console.warn(
              `[designPrototypeService] Prototype ${prototypeId} will not start in process `
                + `because V2 reconciliation returned ${state}`,
            );
          }
        } catch (reconcileError) {
          console.error(
            `[designPrototypeService] Could not reconcile V2 admission for ${prototypeId}; `
              + 'leaving it on the durable path to avoid duplicate generation:',
            reconcileError,
          );
        }
      }
    },
  );
}

export async function generatePrototypesForPrd(
  prdId: string,
  dependencies: GeneratePrototypesDependencies = {},
): Promise<string[]> {
  const evaluateFlag = dependencies.isFeatureEnabled ?? isFeatureEnabled;
  const admitV2Run =
    dependencies.admitV2Run ?? ((input) => createV2AdmissionService().admit(input));
  const reconcileV2Admission =
    dependencies.reconcileV2Admission ?? reconcilePrototypeV2Admission;
  const generateInProcess = dependencies.generateInProcess ?? generateSinglePrototype;

  const prd = await db.query.prds.findFirst({ where: eq(prds.id, prdId) });
  if (!prd) throw new Error(`PRD ${prdId} not found`);

  const { resolveSkillConfig } = await import('./projectSettingsService');
  const skillConfig = await resolveSkillConfig({ project: prd.project, settingsId: prd.skillSettingsId ?? undefined });
  const prototypeModel = skillConfig?.designPrototypeBedrockModelId ?? DEFAULT_DESIGN_PROTOTYPE_MODEL;
  const prototypeMaxTokens = skillConfig?.designPrototypeBedrockMaxTokens ?? undefined;
  const prototypeTimeoutMs = skillConfig?.designPrototypeBedrockTimeoutMs ?? undefined;

  const features = extractFeatures(prd.backlogJson);
  if (features.length === 0) {
    console.warn(`[designPrototypeService] No features found in PRD ${prdId} backlogJson`);
    return [];
  }

  // Load the reviewed/edited design plan (when present) so its decisions steer generation.
  const planRow = await db.query.designPlans.findFirst({ where: eq(designPlans.prdId, prdId) });
  const planFeatures = planRow?.features ?? [];

  // Idempotent (re)generation: skip features that already have a prototype row so
  // re-running only fills in the missing ones (e.g. after a delete) and never
  // creates duplicates. The first generation has no existing rows → generates all.
  const existingRows = await db
    .select({ featureIndex: designPrototypes.featureIndex })
    .from(designPrototypes)
    .where(eq(designPrototypes.prdId, prdId));
  const existingIndices = new Set(existingRows.map(r => r.featureIndex));

  const ids: string[] = [];
  const pending: PendingPrototype[] = [];

  for (let i = 0; i < features.length; i++) {
    if (existingIndices.has(i)) continue;
    const feature = features[i];
    const planFeature = planFeatures.find(f => f.featureIndex === i);
    const skipReason = resolvePrototypeSkipReason(feature, planFeature);

    if (skipReason) {
      // No UI / no PBIs → skip the expensive Bedrock call. Store a deterministic
      // placeholder and auto-approve so the feature stays visible without blocking
      // the reviewer or burning tokens.
      const now = new Date().toISOString();
      const html = buildSkippedPrototypeHtml(feature.title, skipReason, planFeature);
      const historyEntry: DesignPrototypeHistoryEntry = { version: 1, html, createdAt: now };
      const [row] = await db
        .insert(designPrototypes)
        .values({
          prdId,
          featureName: feature.title,
          featureIndex: i,
          authorId: prd.authorId,
          status: 'approved',
          mockHtml: html,
          mockVersion: 1,
          history: [historyEntry],
          reviewComment: skipReason === 'no-ui'
            ? 'Auto-approved: backend-only feature with no user-facing UI.'
            : 'Auto-approved: feature has no linked PBIs to prototype.',
          reviewedAt: now,
          updatedAt: now,
        })
        .returning({ id: designPrototypes.id });
      ids.push(row.id);
      console.log(
        `[designPrototypeService] Skipped generation for feature "${feature.title}" (${skipReason}) — auto-approved, no tokens spent`,
      );
      continue;
    }

    const generationStartedAt = new Date().toISOString();
    const [row] = await db
      .insert(designPrototypes)
      .values({
        prdId,
        featureName: feature.title,
        featureIndex: i,
        authorId: prd.authorId,
        model: prototypeModel,
        status: 'generating',
        updatedAt: generationStartedAt,
      })
      .returning({ id: designPrototypes.id });
    ids.push(row.id);
    pending.push({
      prototypeId: row.id,
      feature,
      planFeature,
      generationStartedAt,
    });
  }

  if (pending.length > 0) {
    let useV2Transport = false;
    try {
      useV2Transport = await evaluateFlag(V2_TRANSPORT_FLAG, {
        userId: prd.authorId,
        project: prd.project,
        caller: 'design-prototype',
      });
    } catch {
      // An unreadable flag keeps the proven in-process path.
      useV2Transport = false;
    }

    // Retain enabled once the visual lane carries production prototype traffic.
    // @feature-flag:ai-runs-v2-transport start winner=enabled
    if (useV2Transport) {
      // @feature-flag:ai-runs-v2-transport enabled-start
      // Admission is a blob write and two row writes, so it is awaited; the
      // model call itself happens on the worker.
      await admitPendingPrototypesToV2({
        prdId,
        project: prd.project,
        userId: prd.authorId,
        skillSettingsId: prd.skillSettingsId ?? null,
        modelId: prototypeModel,
        maxTokens: prototypeMaxTokens,
        timeoutMs: prototypeTimeoutMs,
        pending,
        skillRepoConfigured: Boolean(skillConfig?.skillRepo?.trim()),
        webReferencesEnabled: Boolean(skillConfig?.prototypeWebReferencesEnabled),
        admitV2Run,
        reconcileV2Admission,
        generateInProcess,
      });
      // @feature-flag:ai-runs-v2-transport enabled-end
    } else {
      // @feature-flag:ai-runs-v2-transport disabled-start
      // Generate with bounded concurrency so we don't fire every feature at Bedrock
      // at once (which throttles large models and causes timeouts). Runs in the
      // background — the route returns immediately and the UI polls per-prototype.
      runWithConcurrency(pending, PROTOTYPE_GENERATION_CONCURRENCY, async ({ prototypeId, feature, planFeature }) =>
        generateInProcess(prototypeId, feature, prototypeModel, prototypeMaxTokens, planFeature, prototypeTimeoutMs, prd.project, prd.skillSettingsId ?? null, prdId).catch(err => {
          console.error(`[designPrototypeService] Background generation failed for ${prototypeId}:`, err);
        }),
      ).catch(err => {
        console.error(`[designPrototypeService] Prototype generation batch failed for PRD ${prdId}:`, err);
      });
      // @feature-flag:ai-runs-v2-transport disabled-end
    }
    // @feature-flag:ai-runs-v2-transport end
  }

  // Stamp all newly created prototype IDs into the backlog JSON features
  let updatedBacklog = prd.backlogJson;
  const allCreated: Array<{ protoId: string; featureIndex: number }> = [];
  for (let i = 0; i < features.length; i++) {
    if (existingIndices.has(i)) continue;
    const matchingId = ids[allCreated.length];
    if (matchingId) allCreated.push({ protoId: matchingId, featureIndex: i });
  }
  for (const { protoId, featureIndex: fi } of allCreated) {
    updatedBacklog = stampFeatureLinkId(updatedBacklog, fi, 'designPrototypeId', protoId);
  }
  if (allCreated.length > 0) {
    await db.update(prds).set({ backlogJson: updatedBacklog as any, updatedAt: new Date().toISOString() }).where(eq(prds.id, prdId));
  }

  // Auto-approved (skipped) features have no reviewer step, so kick off their
  // design docs immediately here. UI-generating features get triggered via reviewPrototype.
  const autoApprovedIds = ids.filter(id => !pending.some(p => p.prototypeId === id));
  for (const protoId of autoApprovedIds) {
    const protoRow = await db.query.designPrototypes.findFirst({
      where: eq(designPrototypes.id, protoId),
      columns: { featureIndex: true },
    });
    if (protoRow) {
      triggerDesignDocForPrototype(protoId, protoRow.featureIndex).catch(err => {
        console.error(`[designPrototypeService] triggerDesignDocForPrototype failed for auto-approved prototype ${protoId}:`, err);
      });
    }
  }

  return ids;
}

function planFeatureToInput(planFeature?: DesignPlanFeature): DesignPrototypeInput['plan'] | undefined {
  if (!planFeature) return undefined;
  return {
    designBrief: planFeature.designBrief,
    decision: planFeature.decision,
    layoutPattern: planFeature.layoutPattern,
    targetPageTitle: planFeature.targetPageTitle,
    primaryComponents: planFeature.primaryComponents,
    states: planFeature.states,
    pbiContributions: planFeature.pbiContributions,
    rationale: planFeature.rationale,
    notes: planFeature.notes,
  };
}

async function generateSinglePrototype(
  prototypeId: string,
  feature: BacklogFeature,
  modelId?: string,
  maxTokens?: number,
  planFeature?: DesignPlanFeature,
  timeoutMs?: number,
  project?: string,
  skillSettingsId?: string | null,
  prdId?: string,
): Promise<void> {
  try {
    const { generateDesignPrototypeHtml } = await import('./bedrockService');

    const pbis = extractPbiRequirements(feature);
    const targetRoute = resolvePrototypeTargetRoute(feature, planFeature);
    const extendMode = Boolean(targetRoute);

    let pageScreenshot: { base64: string; mediaType: string } | undefined;
    if (targetRoute) {
      try {
        const ss = await getScreenshotByRoute(targetRoute);
        if (ss) pageScreenshot = { base64: ss.imageBase64, mediaType: ss.mediaType };
      } catch (err) {
        console.warn('[designPrototypeService] Page screenshot lookup failed:', err);
      }
    }

    // Resolve project-specific prototype context (design system from the project's own repo).
    // When absent (or unresolvable), the legacy MaxView fallback path runs inside bedrockService.
    let prototypeContext: import('./prototypeContextService').PrototypeContext | undefined;
    let webReferences: string | undefined;
    if (project) {
      try {
        const { resolvePrototypeContext } = await import('./prototypeContextService');
        const resolved = await resolvePrototypeContext(project, skillSettingsId);
        if (resolved) {
          prototypeContext = resolved;
          console.log(`[designPrototypeService] Using project-specific design system for "${feature.title}" (${project}, isProjectSpecific=${resolved.isProjectSpecific})`);
        } else {
          const { resolveSkillConfig } = await import('./projectSettingsService');
          const cfg = await resolveSkillConfig({ project, settingsId: skillSettingsId ?? undefined });
          if (cfg?.skillRepo?.trim()) {
            throw new Error(
              `Could not load the design-system skill for project "${project}" from ${cfg.skillRepo}. Check Prototype Design System path and that the file exists on the skill branch.`,
            );
          }
        }
      } catch (err: any) {
        if (typeof err?.message === 'string' && err.message.startsWith('Could not load the design-system skill')) {
          throw err;
        }
        console.warn(`[designPrototypeService] resolvePrototypeContext failed for "${project}": ${err.message}`);
      }
    }

    // Resolve live web design references (NEW-page only, toggle-gated).
    if (prototypeContext && !extendMode) {
      try {
        const { resolveSkillConfig } = await import('./projectSettingsService');
        const cfg = project ? await resolveSkillConfig({ project, settingsId: skillSettingsId ?? undefined }) : null;
        if (cfg?.prototypeWebReferencesEnabled) {
          const { getDesignReferences } = await import('./webDesignReferenceService');
          webReferences = await getDesignReferences({
            featureName: feature.title,
            featureDescription: feature.description,
            designSystemName: prototypeContext.appName,
          });
        }
      } catch (err: any) {
        console.warn(`[designPrototypeService] Web design references failed for "${feature.title}": ${err.message}`);
      }
    }

    let sourceContext:
      | Awaited<ReturnType<typeof resolvePrototypeSourceContext>>
      | undefined;
    let maxViewDesignContext: PrototypeDesignContext | undefined;
    if (!prototypeContext && prdId) {
      const source = await resolvePrototypeRepoSource(prdId);
      [sourceContext, maxViewDesignContext] = await Promise.all([
        resolvePrototypeSourceContext({
          reader: source?.reader,
          sourcePaths: source?.sourcePaths ?? [],
          sourceRelevanceText: prototypeFeatureText(feature),
        }),
        loadPrototypeDesignContext(
          source?.reader,
          prototypeFeatureText(feature),
        ),
      ]);
    }

    const rawHtml = await generateDesignPrototypeHtml({
      featureName: feature.title,
      featureDescription: feature.description,
      pbis,
      targetRoute,
      pageScreenshot,
      plan: planFeatureToInput(planFeature),
      prototypeContext,
      webReferences,
      sourceFiles: sourceContext?.sourceFiles,
      omittedSourcePaths: sourceContext?.omittedSourcePaths,
      designSystemCatalog: maxViewDesignContext?.catalog as
        | DesignSystemCatalog
        | undefined,
      screenInventory: maxViewDesignContext?.screenInventory as
        | ScreenInventoryRoute[]
        | undefined,
    }, modelId, maxTokens, timeoutMs, prototypeUsageCtx(project, prototypeId));

    const html = sanitizeMockHtml(rawHtml);

    // Only check for the MaxView purple-annotation convention when using the legacy path.
    // Project-specific (NEW-page) prototypes don't use the MaxView purple delta marker.
    const isLegacyPath = !prototypeContext?.isProjectSpecific;
    const hasAnnotation = /#a46bff/.test(html) && /NEW:/i.test(html);
    const hasFeatureMarkers = /<!--\s*NEW_FEATURE:START\s*-->/.test(html)
      && /<!--\s*NEW_FEATURE:END\s*-->/.test(html);
    if (isLegacyPath && (!hasAnnotation || !hasFeatureMarkers)) {
      const missing: string[] = [];
      if (!hasAnnotation) missing.push('purple annotation border');
      if (!hasFeatureMarkers) missing.push('NEW_FEATURE comment markers');
      console.warn(
        `[designPrototypeService] Prototype for "${feature.title}" is missing: ${missing.join(', ')}. ` +
        'Reviewer may not be able to distinguish new vs existing content.',
      );
    }

    const now = new Date().toISOString();
    const historyEntry: DesignPrototypeHistoryEntry = {
      version: 1,
      html,
      createdAt: now,
    };

    await db
      .update(designPrototypes)
      .set({
        mockHtml: html,
        mockVersion: 1,
        history: [historyEntry],
        status: 'pending_review',
        generationError: null,
        updatedAt: now,
      })
      .where(eq(designPrototypes.id, prototypeId));

    notifyAiCompletion('design_prototype_generated', prototypeId, { title: feature.title }).catch(err =>
      console.error(`[designPrototype] AI notification failed (id=${prototypeId}):`, err),
    );
  } catch (err: any) {
    console.error(`[designPrototypeService] Generation error for ${prototypeId}:`, err);
    await db
      .update(designPrototypes)
      .set({
        status: 'generation_failed',
        generationError: err.message ?? 'Unknown error',
        updatedAt: new Date().toISOString(),
      })
      .where(eq(designPrototypes.id, prototypeId));
  }
}

// ── Regeneration ────────────────────────────────────────────────────────────

export async function regeneratePrototype(
  prototypeId: string,
  feedback: string,
  targetStates?: DesignPrototypeStateName[],
): Promise<void> {
  const proto = await db.query.designPrototypes.findFirst({
    where: eq(designPrototypes.id, prototypeId),
  });
  if (!proto) throw new Error(`Prototype ${prototypeId} not found`);
  if (!proto.mockHtml) throw new Error('No existing HTML to regenerate from');

  await db
    .update(designPrototypes)
    .set({ status: 'regenerating', updatedAt: new Date().toISOString() })
    .where(eq(designPrototypes.id, prototypeId));

  try {
    const { regenerateDesignPrototypeHtml } = await import('./bedrockService');

    const prd = await db.query.prds.findFirst({ where: eq(prds.id, proto.prdId) });
    // Re-resolve the feature's target route so regenerations stay in EXTEND mode.
    const feature = prd ? extractFeatures(prd.backlogJson)[proto.featureIndex] : undefined;
    const targetRoute = feature?.route?.trim() || undefined;
    const { resolveSkillConfig } = await import('./projectSettingsService');
    const skillConfig = prd ? await resolveSkillConfig({ project: prd.project, settingsId: prd.skillSettingsId ?? undefined }) : null;
    // Prefer the regen-specific model; fall back to the generation model.
    const prototypeModel = skillConfig?.designPrototypeRegenBedrockModelId
      ?? skillConfig?.designPrototypeBedrockModelId
      ?? undefined;
    const prototypeMaxTokens = skillConfig?.designPrototypeRegenBedrockMaxTokens
      ?? skillConfig?.designPrototypeBedrockMaxTokens
      ?? undefined;
    const prototypeTimeoutMs = skillConfig?.designPrototypeBedrockTimeoutMs ?? undefined;

    // Resolve project-specific prototype context for project-driven regeneration.
    let regenProtoContext: import('./prototypeContextService').PrototypeContext | undefined;
    if (prd?.project) {
      try {
        const { resolvePrototypeContext } = await import('./prototypeContextService');
        const resolved = await resolvePrototypeContext(prd.project, prd.skillSettingsId ?? undefined);
        if (resolved) regenProtoContext = resolved;
      } catch (err: any) {
        console.warn(`[designPrototypeService] resolvePrototypeContext (regen) failed: ${err.message}`);
      }
    }

    // Resolve web references for regen (NEW-page only, same rule as initial generation).
    // This keeps the web-inspiration section consistent across generations.
    const regenExtendMode = Boolean(targetRoute);
    let regenWebReferences: string | undefined;
    if (regenProtoContext && !regenExtendMode && prd?.project) {
      try {
        const { resolveSkillConfig } = await import('./projectSettingsService');
        const cfg = await resolveSkillConfig({ project: prd.project, settingsId: prd.skillSettingsId ?? undefined });
        if (cfg?.prototypeWebReferencesEnabled) {
          const { getDesignReferences } = await import('./webDesignReferenceService');
          const feature = prd ? extractFeatures(prd.backlogJson)[proto.featureIndex] : undefined;
          regenWebReferences = await getDesignReferences({
            featureName: feature?.title ?? prototypeId,
            featureDescription: feature?.description,
            designSystemName: regenProtoContext.appName,
          });
        }
      } catch (err: any) {
        console.warn(`[designPrototypeService] Web design references (regen) failed: ${err.message}`);
      }
    }

    const comments = await db
      .select()
      .from(designPrototypeComments)
      .where(
        and(
          eq(designPrototypeComments.prototypeId, prototypeId),
          eq(designPrototypeComments.resolved, false),
        )
      );
    const unresolvedTexts = comments.map(c => c.text);

    let regenScreenshot: { base64: string; mediaType: string } | undefined;
    if (targetRoute) {
      try {
        const ss = await getScreenshotByRoute(targetRoute);
        if (ss) regenScreenshot = { base64: ss.imageBase64, mediaType: ss.mediaType };
      } catch (err) {
        console.warn('[designPrototypeService] Page screenshot lookup (regen) failed:', err);
      }
    }

    const rawHtml = await regenerateDesignPrototypeHtml(
      proto.mockHtml,
      feedback,
      unresolvedTexts,
      prototypeModel,
      prototypeMaxTokens,
      targetRoute,
      undefined,
      targetStates,
      prototypeTimeoutMs,
      regenScreenshot,
      prototypeUsageCtx(prd?.project, prototypeId),
      regenProtoContext,
      regenWebReferences,
    );

    const html = sanitizeMockHtml(rawHtml);
    const newVersion = proto.mockVersion + 1;
    const now = new Date().toISOString();

    const currentEntry: DesignPrototypeHistoryEntry = {
      version: proto.mockVersion,
      html: proto.mockHtml,
      feedback,
      createdAt: now,
    };

    const newEntry: DesignPrototypeHistoryEntry = {
      version: newVersion,
      html,
      createdAt: now,
    };

    const updatedHistory = [...proto.history];
    const existingIdx = updatedHistory.findIndex(h => h.version === proto.mockVersion);
    if (existingIdx >= 0) {
      updatedHistory[existingIdx] = { ...updatedHistory[existingIdx], feedback };
    } else {
      updatedHistory.push(currentEntry);
    }
    updatedHistory.push(newEntry);

    await db
      .update(designPrototypes)
      .set({
        mockHtml: html,
        mockVersion: newVersion,
        history: updatedHistory,
        status: 'pending_review',
        reviewerId: null,
        reviewComment: null,
        reviewedAt: null,
        generationError: null,
        updatedAt: now,
      })
      .where(eq(designPrototypes.id, prototypeId));
  } catch (err: any) {
    console.error(`[designPrototypeService] Regeneration error for ${prototypeId}:`, err);
    await db
      .update(designPrototypes)
      .set({
        status: 'generation_failed',
        generationError: err.message ?? 'Unknown error',
        updatedAt: new Date().toISOString(),
      })
      .where(eq(designPrototypes.id, prototypeId));
  }
}

export async function retryPrototype(prototypeId: string): Promise<void> {
  const proto = await db.query.designPrototypes.findFirst({
    where: eq(designPrototypes.id, prototypeId),
  });
  if (!proto) throw new Error(`Prototype ${prototypeId} not found`);

  const prd = await db.query.prds.findFirst({ where: eq(prds.id, proto.prdId) });
  if (!prd) throw new Error(`PRD ${proto.prdId} not found`);

  const features = extractFeatures(prd.backlogJson);
  const feature = features[proto.featureIndex];
  if (!feature) throw new Error(`Feature at index ${proto.featureIndex} not found`);

  const planRow = await db.query.designPlans.findFirst({ where: eq(designPlans.prdId, proto.prdId) });
  const planFeature = planRow?.features?.find(f => f.featureIndex === proto.featureIndex);

  const { resolveSkillConfig } = await import('./projectSettingsService');
  const skillConfig = await resolveSkillConfig({ project: prd.project, settingsId: prd.skillSettingsId ?? undefined });
  const prototypeModel = skillConfig?.designPrototypeBedrockModelId ?? DEFAULT_DESIGN_PROTOTYPE_MODEL;
  const prototypeMaxTokens = skillConfig?.designPrototypeBedrockMaxTokens ?? undefined;
  const prototypeTimeoutMs = skillConfig?.designPrototypeBedrockTimeoutMs ?? undefined;

  await db
    .update(designPrototypes)
    .set({
      status: 'generating',
      model: prototypeModel,
      generationError: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(designPrototypes.id, prototypeId));

  generateSinglePrototype(prototypeId, feature, prototypeModel, prototypeMaxTokens, planFeature, prototypeTimeoutMs, prd.project, prd.skillSettingsId ?? null, proto.prdId).catch(err => {
    console.error(`[designPrototypeService] Retry generation failed for ${prototypeId}:`, err);
  });
}

// ── Stuck-generation recovery ─────────────────────────────────────────────────

/**
 * Flip design prototypes that have been stuck in a transient status
 * (`generating`/`regenerating`) for longer than `thresholdMs` to
 * `generation_failed`. Prototypes are one-shot Bedrock calls with no chat thread
 * to rehydrate, so a server restart or a hung model call orphans the row forever.
 * Marking them failed surfaces the existing "Retry Generation" affordance.
 *
 * The threshold must comfortably exceed normal generation time so a slow-but-live
 * generation is never reset out from under itself. Returns the number reset.
 */
export async function failStalePrototypes(thresholdMs: number): Promise<number> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - thresholdMs).toISOString();
  const activeV2RunBeforeDeadline = sql`
    SELECT 1
    FROM ${agentRuns}
    WHERE ${agentRuns.transportVersion} = ${'servicebus-blob-v2'}
      AND ${agentRuns.threadId} =
        ${visualRunThreadPrefix('design-prototype')} || ${designPrototypes.id}::text
      AND ${agentRuns.status} IN ('queued', 'dispatched', 'running')
      AND ${agentRuns.timeoutAt} > ${now.toISOString()}::timestamptz
  `;
  const reset = await db
    .update(designPrototypes)
    .set({
      status: 'generation_failed',
      generationError:
        'Generation was interrupted (likely a server restart or a timed-out model call). Click Retry to run it again.',
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        inArray(designPrototypes.status, ['generating', 'regenerating']),
        lt(designPrototypes.updatedAt, cutoff),
        // V2 owns this row until its persisted admission deadline. Terminal
        // runs do not match, so the harvest above or this fallback settles it.
        notExists(activeV2RunBeforeDeadline),
      ),
    )
    .returning({ id: designPrototypes.id, featureName: designPrototypes.featureName });

  for (const row of reset) {
    console.warn(
      `[designPrototypeService] Reset stale prototype "${row.featureName}" (id=${row.id}) to generation_failed`,
    );
  }
  return reset.length;
}

/**
 * Manual unblock: force a prototype currently stuck `generating`/`regenerating`
 * to `generation_failed` so the user doesn't have to wait for the recovery loop.
 * The existing "Retry Generation" button then re-runs it from scratch.
 */
export async function resetStuckPrototype(prototypeId: string): Promise<void> {
  const proto = await db.query.designPrototypes.findFirst({
    where: eq(designPrototypes.id, prototypeId),
  });
  if (!proto) {
    throw Object.assign(new Error(`Prototype ${prototypeId} not found`), { status: 404 });
  }
  if (proto.status !== 'generating' && proto.status !== 'regenerating') {
    throw Object.assign(
      new Error(`Cannot reset a prototype in status '${proto.status}'`),
      { status: 409 },
    );
  }

  await db
    .update(designPrototypes)
    .set({
      status: 'generation_failed',
      generationError: 'Generation reset by user. Click Retry to run it again.',
      updatedAt: new Date().toISOString(),
    })
    .where(eq(designPrototypes.id, prototypeId));
}

// ── CRUD ────────────────────────────────────────────────────────────────────

export async function listPrototypesForPrd(prdId: string): Promise<DesignPrototypeSummary[]> {
  const rows = await db
    .select()
    .from(designPrototypes)
    .where(eq(designPrototypes.prdId, prdId))
    .orderBy(asc(designPrototypes.featureIndex));

  return rows.map(toSummary);
}

export async function listPrototypes(opts: {
  status?: string;
  project?: string;
  author?: string;
  requestUserId?: string;
}): Promise<DesignPrototypeSummary[]> {
  const conditions: SQL[] = [];
  if (opts.status) {
    conditions.push(eq(designPrototypes.status, opts.status));
  }
  if (opts.project) {
    conditions.push(eq(prds.project, opts.project));
  }
  if (opts.author === 'me' && opts.requestUserId) {
    conditions.push(eq(designPrototypes.authorId, opts.requestUserId));
  }

  const rows = await db
    .select({
      proto: designPrototypes,
      prdTitle: prds.title,
    })
    .from(designPrototypes)
    .innerJoin(prds, eq(designPrototypes.prdId, prds.id))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(designPrototypes.updatedAt));

  return rows.map(r => ({ ...toSummary(r.proto), prdTitle: r.prdTitle }));
}

export async function deletePrototype(id: string): Promise<void> {
  await db.delete(designPrototypes).where(eq(designPrototypes.id, id));
}

export async function updatePrototypeHtml(id: string, html: string): Promise<void> {
  const proto = await db.query.designPrototypes.findFirst({
    where: eq(designPrototypes.id, id),
  });
  if (!proto) throw Object.assign(new Error(`Prototype ${id} not found`), { status: 404 });

  const now = new Date().toISOString();

  // Push the current version to history so the reviewer can undo boundary edits.
  const updatedHistory = [...(proto.history ?? [])];
  if (proto.mockHtml) {
    const existingIdx = updatedHistory.findIndex(h => h.version === proto.mockVersion);
    if (existingIdx < 0) {
      updatedHistory.push({
        version: proto.mockVersion,
        html: proto.mockHtml,
        feedback: 'Before boundary edit',
        createdAt: now,
      });
    }
  }

  const newVersion = proto.mockVersion + 1;
  updatedHistory.push({ version: newVersion, html, createdAt: now });

  await db
    .update(designPrototypes)
    .set({
      mockHtml: html,
      mockVersion: newVersion,
      history: updatedHistory,
      updatedAt: now,
    })
    .where(eq(designPrototypes.id, id));
}

export async function getPrototype(id: string): Promise<DesignPrototype | null> {
  const row = await db.query.designPrototypes.findFirst({
    where: eq(designPrototypes.id, id),
  });
  if (!row) return null;

  const prd = await db.query.prds.findFirst({ where: eq(prds.id, row.prdId) });
  const features = prd ? extractFeatures(prd.backlogJson) : [];
  const feature = features[row.featureIndex];
  const planRow = await db.query.designPlans.findFirst({ where: eq(designPlans.prdId, row.prdId) });
  const planFeature = planRow?.features?.find(f => f.featureIndex === row.featureIndex);
  const pbiRequirements = feature
    ? scopePbiRequirementsForFeature(feature, planFeature)
    : [];

  return {
    ...toSummary(row),
    mockHtml: row.mockHtml,
    history: row.history ?? [],
    pbiRequirements,
  };
}

// ── Review ──────────────────────────────────────────────────────────────────

export async function reviewPrototype(
  prototypeId: string,
  reviewerId: string,
  action: 'approve' | 'revision_requested',
  comment?: string,
): Promise<void> {
  const proto = await db.query.designPrototypes.findFirst({
    where: eq(designPrototypes.id, prototypeId),
  });
  if (!proto) throw new Error(`Prototype ${prototypeId} not found`);
  if (proto.status !== 'pending_review') throw Object.assign(new Error(`Cannot review a prototype in status '${proto.status}'`), { status: 409 });

  // Only a designated design-prototype approver (or an admin) may approve/reject.
  // These approvers are distinct from PRD approvers; everyone else can view only.
  const admin = await isAdminUser(reviewerId);
  const assigned = await isAssignedApprover(proto.prdId, 'design_prototype', reviewerId);
  if (!assigned && !admin) {
    throw Object.assign(new Error('You are not a designated design prototype approver'), { status: 403 });
  }

  const now = new Date().toISOString();
  await db
    .update(designPrototypes)
    .set({
      status: action === 'approve' ? 'reviewer_approved' : 'revision_requested',
      reviewerId,
      reviewComment: comment ?? null,
      reviewedAt: now,
      updatedAt: now,
    })
    .where(eq(designPrototypes.id, prototypeId));

  // Record in document_approver_assignments so the Approvals modal reflects real status.
  const existingAssignment = await db.select({ id: documentApproverAssignments.id })
    .from(documentApproverAssignments)
    .where(and(
      eq(documentApproverAssignments.documentId, proto.prdId),
      eq(documentApproverAssignments.documentType, 'design_prototype'),
      eq(documentApproverAssignments.approverUserId, reviewerId),
    ))
    .limit(1);

  if (existingAssignment.length > 0) {
    await db.update(documentApproverAssignments)
      .set({ status: action === 'approve' ? 'approved' : 'revision_requested', respondedAt: now })
      .where(eq(documentApproverAssignments.id, existingAssignment[0].id));
  } else {
    await db.insert(documentApproverAssignments).values({
      documentId: proto.prdId,
      documentType: 'design_prototype',
      approverUserId: reviewerId,
      assignedBy: reviewerId,
      status: action === 'approve' ? 'approved' : 'revision_requested',
      respondedAt: now,
    });
  }
}

export async function reopenPrototypeForReview(prototypeId: string): Promise<void> {
  const proto = await db.query.designPrototypes.findFirst({
    where: eq(designPrototypes.id, prototypeId),
  });
  if (!proto) {
    throw Object.assign(new Error(`Prototype ${prototypeId} not found`), { status: 404 });
  }
  if (proto.status !== 'approved') {
    throw Object.assign(
      new Error(`Cannot reopen a prototype in status '${proto.status}'`),
      { status: 409 },
    );
  }

  const existingDoc = await db
    .select({ id: designDocs.id })
    .from(designDocs)
    .where(and(
      eq(designDocs.designPrototypeId, prototypeId),
      eq(designDocs.featureIndex, proto.featureIndex),
    ))
    .limit(1);

  if (existingDoc.length > 0) {
    throw Object.assign(
      new Error('Cannot reopen — a design doc has already been created for this prototype feature'),
      { status: 409 },
    );
  }

  await db
    .update(designPrototypes)
    .set({
      status: 'pending_review',
      reviewerId: null,
      reviewComment: null,
      reviewedAt: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(designPrototypes.id, prototypeId));
}

/**
 * Idempotently kicks off a design doc for a single prototype feature.
 * Called when a prototype is approved (either manually reviewed or auto-approved).
 * Safe to call multiple times — delegates idempotency to startSingleFeatureDesignDocWatcher.
 */
export async function triggerDesignDocForPrototype(prototypeId: string, featureIndex: number): Promise<void> {
  const proto = await db.query.designPrototypes.findFirst({
    where: eq(designPrototypes.id, prototypeId),
    columns: { prdId: true },
  });
  if (!proto) {
    console.error(`[designPrototypeService] triggerDesignDocForPrototype: prototype ${prototypeId} not found`);
    return;
  }

  const prd = await db.query.prds.findFirst({
    where: eq(prds.id, proto.prdId),
    columns: { interviewId: true },
  });

  const { startSingleFeatureDesignDocWatcher } = await import('./designDocService');
  await startSingleFeatureDesignDocWatcher(prototypeId, featureIndex, proto.prdId, prd?.interviewId ?? null);
}

// ── Comments ────────────────────────────────────────────────────────────────

export async function listComments(prototypeId: string): Promise<DesignPrototypeComment[]> {
  const rows = await db
    .select()
    .from(designPrototypeComments)
    .where(eq(designPrototypeComments.prototypeId, prototypeId))
    .orderBy(asc(designPrototypeComments.createdAt));

  return rows.map(r => ({
    id: r.id,
    prototypeId: r.prototypeId,
    authorId: r.authorId,
    authorName: resolveUserName(r.authorId),
    text: r.text,
    pinX: r.pinX,
    pinY: r.pinY,
    mockVersion: r.mockVersion,
    resolved: r.resolved,
    resolvedBy: r.resolvedBy,
    createdAt: r.createdAt,
  }));
}

export async function getUnresolvedCommentCount(prototypeId: string): Promise<number> {
  const [result] = await db
    .select({ value: count() })
    .from(designPrototypeComments)
    .where(
      and(
        eq(designPrototypeComments.prototypeId, prototypeId),
        eq(designPrototypeComments.resolved, false),
      ),
    );

  return Number(result?.value ?? 0);
}

export async function addComment(
  prototypeId: string,
  authorId: string,
  text: string,
  mockVersion: number,
  pinX?: number,
  pinY?: number,
): Promise<DesignPrototypeComment> {
  const [row] = await db
    .insert(designPrototypeComments)
    .values({
      prototypeId,
      authorId,
      text,
      mockVersion,
      pinX: pinX ?? null,
      pinY: pinY ?? null,
    })
    .returning();

  return {
    id: row.id,
    prototypeId: row.prototypeId,
    authorId: row.authorId,
    authorName: resolveUserName(row.authorId),
    text: row.text,
    pinX: row.pinX,
    pinY: row.pinY,
    mockVersion: row.mockVersion,
    resolved: row.resolved,
    resolvedBy: row.resolvedBy,
    createdAt: row.createdAt,
  };
}

export async function resolveComment(commentId: string, resolvedBy: string): Promise<void> {
  await db
    .update(designPrototypeComments)
    .set({ resolved: true, resolvedBy })
    .where(eq(designPrototypeComments.id, commentId));
}
