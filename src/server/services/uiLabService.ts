import { db } from '../db/drizzle';
import {
  agentRuns,
  uiLabDesigns,
  uiLabComments,
  uiLabDesignShares,
} from '../db/schema';
import { and, eq, desc, inArray } from 'drizzle-orm';
import { sanitizeMockHtml } from '../utils/htmlSanitizer';
import {
  generateUiLabDesign,
  editUiLabDesign,
  extractHtml,
  resolveUiLabDesignReference,
  resolveUiLabPromptInput,
  resolveUiLabVisualModel,
} from './uiLabBedrockService';
import { getSkillConfig } from './projectSettingsService';
import { createNotification } from './notificationService';
import { getUserPermissions } from './rbacService';
import { getUserGroupNames } from './groupService';
import { isFeatureEnabled } from './featureFlagService';
import { resolveAgentRunHardLimitMs } from './agentRunReaperService';
import {
  createV2AdmissionService,
  visualGenerationRunId,
  visualRunThreadId,
  type V2AdmissionService,
} from './aiRunV2/v2AdmissionService';
import { buildUiLabVisualSpecification } from './aiRunV2/visualSpecificationBuilder';
import {
  observeUiLabV2Run,
  type ObserveUiLabV2Run,
} from './uiLabV2Stream';
import * as shareRepo from './uiLabShareRepository';
import type {
  UiLabDesign,
  UiLabDesignSummary,
  UiLabComment,
  UiLabShare,
  UiLabShareTarget,
  CreateUiLabDesignRequest,
  RegenerateUiLabDesignRequest,
  AddUiLabCommentRequest,
  UiLabHistoryEntry,
  UiLabEffectiveAccess,
} from '../../shared/types/uiLab';
import {
  capabilitiesForAccess,
  UI_LAB_SHARE_NOTIFICATION_TYPE,
  uiLabShareDeepLink,
  uiLabShareDedupeKey,
} from '../../shared/types/uiLab';

export class UiLabNotFoundError extends Error {
  readonly status = 404;
  constructor(message = 'UI Lab design not found') {
    super(message);
    this.name = 'UiLabNotFoundError';
  }
}

export class UiLabForbiddenError extends Error {
  readonly status = 403;
  constructor(message = 'Forbidden') {
    super(message);
    this.name = 'UiLabForbiddenError';
  }
}

export class UiLabValidationError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'UiLabValidationError';
  }
}

const UI_LAB_V2_TRANSPORT_FLAG = 'ui-lab-v2-transport';
const VISUAL_WORKLOAD_LANE = 'visual' as const;

export type UiLabV2AdmissionState =
  | 'intended'
  | 'absent'
  | 'conflicting';

export type ReconcileUiLabV2Admission = (input: Readonly<{
  runId: string;
  threadId: string;
  subjectId: string;
  generationStartedAt: string;
}>) => Promise<UiLabV2AdmissionState>;

type FeatureFlagEvaluator = (
  key: string,
  context: { userId: string; project: string; caller?: string },
) => Promise<boolean>;

export type UiLabGenerationDependencies = Readonly<{
  isFeatureEnabled?: FeatureFlagEvaluator;
  admitV2Run?: V2AdmissionService['admit'];
  reconcileV2Admission?: ReconcileUiLabV2Admission;
  observeV2Run?: ObserveUiLabV2Run;
  now?: () => Date;
  resolveHardLimitMs?: () => number;
  afterEventId?: string;
  onTransport?: (transport: 'v1' | 'v2') => void;
}>;

function toDesign(row: Record<string, unknown>): UiLabDesign {
  return row as unknown as UiLabDesign;
}

function toComment(row: Record<string, unknown>): UiLabComment {
  return row as unknown as UiLabComment;
}

function withAccess(design: UiLabDesign, access: UiLabEffectiveAccess): UiLabDesign {
  return {
    ...design,
    effectiveAccess: access,
    capabilities: capabilitiesForAccess(access),
  };
}

function toShare(
  row: shareRepo.UiLabDesignShareRow,
  project: string,
  granteeName: string | null = null,
): UiLabShare {
  return {
    id: row.id,
    designId: row.designId,
    granteeId: row.granteeId,
    granteeName,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    link: uiLabShareDeepLink(row.designId, project),
  };
}

export async function listDesigns(project: string): Promise<UiLabDesignSummary[]> {
  const rows = await db
    .select({
      id: uiLabDesigns.id,
      project: uiLabDesigns.project,
      authorId: uiLabDesigns.authorId,
      title: uiLabDesigns.title,
      prompt: uiLabDesigns.prompt,
      targetRoute: uiLabDesigns.targetRoute,
      status: uiLabDesigns.status,
      version: uiLabDesigns.version,
      generationError: uiLabDesigns.generationError,
      createdAt: uiLabDesigns.createdAt,
      updatedAt: uiLabDesigns.updatedAt,
    })
    .from(uiLabDesigns)
    .where(eq(uiLabDesigns.project, project))
    .orderBy(desc(uiLabDesigns.createdAt));

  return rows as unknown as UiLabDesignSummary[];
}

/**
 * Designs in `project` that were explicitly shared with `actorUserId`.
 *
 * Returns an empty list for a non-member so the caller cannot enumerate designs
 * in a project they were removed from — the same membership rule
 * `resolveDesignAccess` applies to shared access.
 */
export async function listSharedDesigns(
  project: string,
  actorUserId: string,
): Promise<UiLabDesignSummary[]> {
  if (!(await shareRepo.isCurrentProjectMember(project, actorUserId))) return [];

  const rows = await db
    .select({
      id: uiLabDesigns.id,
      project: uiLabDesigns.project,
      authorId: uiLabDesigns.authorId,
      title: uiLabDesigns.title,
      prompt: uiLabDesigns.prompt,
      targetRoute: uiLabDesigns.targetRoute,
      status: uiLabDesigns.status,
      version: uiLabDesigns.version,
      generationError: uiLabDesigns.generationError,
      createdAt: uiLabDesigns.createdAt,
      updatedAt: uiLabDesigns.updatedAt,
    })
    .from(uiLabDesignShares)
    .innerJoin(uiLabDesigns, eq(uiLabDesignShares.designId, uiLabDesigns.id))
    .where(and(
      eq(uiLabDesignShares.granteeId, actorUserId),
      eq(uiLabDesigns.project, project),
    ))
    .orderBy(desc(uiLabDesigns.createdAt));

  return rows as unknown as UiLabDesignSummary[];
}

export async function getDesign(id: string): Promise<UiLabDesign | null> {
  const rows = await db.select().from(uiLabDesigns).where(eq(uiLabDesigns.id, id)).limit(1);
  return rows[0] ? toDesign(rows[0] as Record<string, unknown>) : null;
}

/** Resolve the owning project for a design id, or null when it doesn't exist. */
export async function getDesignProject(id: string): Promise<string | null> {
  const rows = await db
    .select({ project: uiLabDesigns.project })
    .from(uiLabDesigns)
    .where(eq(uiLabDesigns.id, id))
    .limit(1);
  return rows[0]?.project ?? null;
}

/** Resolve the owning project for a comment id (via its design), or null when it doesn't exist. */
export async function getCommentProject(commentId: string): Promise<string | null> {
  const rows = await db
    .select({ project: uiLabDesigns.project })
    .from(uiLabComments)
    .innerJoin(uiLabDesigns, eq(uiLabComments.designId, uiLabDesigns.id))
    .where(eq(uiLabComments.id, commentId))
    .limit(1);
  return rows[0]?.project ?? null;
}

/**
 * Resolve live effective access for a design.
 * - manage: super admin, or ui-lab:manage + UI/UX (or admin:roles)
 * - workspace: ui-lab:view + UI/UX (or admin:roles)
 * - shared: named grant + ui-lab:view + current project membership (UI/UX not required)
 */
export async function resolveDesignAccess(
  designId: string,
  actorUserId: string,
  options: { isSuperAdmin?: boolean } = {},
): Promise<{ design: UiLabDesign; access: UiLabEffectiveAccess }> {
  const design = await getDesign(designId);
  if (!design) throw new UiLabNotFoundError();

  if (options.isSuperAdmin) {
    return { design: withAccess(design, 'manage'), access: 'manage' };
  }

  const permissions = await getUserPermissions(actorUserId, design.project);
  if (!permissions.has('ui-lab:view')) {
    throw new UiLabForbiddenError();
  }

  const groups = await getUserGroupNames(actorUserId);
  const inUiUx = groups.includes('UI/UX') || permissions.has('admin:roles');

  if (inUiUx) {
    const access: UiLabEffectiveAccess = permissions.has('ui-lab:manage') ? 'manage' : 'workspace';
    return { design: withAccess(design, access), access };
  }

  const share = await shareRepo.findShare(design.id, actorUserId);
  if (!share) throw new UiLabForbiddenError();

  const isMember = await shareRepo.isCurrentProjectMember(design.project, actorUserId);
  if (!isMember) throw new UiLabForbiddenError();

  return { design: withAccess(design, 'shared'), access: 'shared' };
}

export async function requireManageAccess(
  designId: string,
  actorUserId: string,
  options: { isSuperAdmin?: boolean } = {},
): Promise<UiLabDesign> {
  const { design, access } = await resolveDesignAccess(designId, actorUserId, options);
  if (access !== 'manage') throw new UiLabForbiddenError();
  return design;
}

export async function createDesign(
  project: string,
  authorId: string,
  req: CreateUiLabDesignRequest,
): Promise<UiLabDesign> {
  const now = new Date().toISOString();
  const rows = await db
    .insert(uiLabDesigns)
    .values({
      project,
      authorId,
      title: req.title,
      prompt: req.prompt,
      targetRoute: req.targetRoute ?? null,
      status: 'generating',
      version: 1,
      history: [],
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return withAccess(toDesign(rows[0] as Record<string, unknown>), 'manage');
}

export async function deleteDesign(id: string): Promise<void> {
  await db.delete(uiLabDesigns).where(eq(uiLabDesigns.id, id));
}

/**
 * Persist a manual HTML edit (boundary editor). Sanitizes the document,
 * bumps the version, and appends history so prior source remains recoverable.
 */
export async function saveHtml(
  id: string,
  html: string,
  options: { feedback?: string } = {},
): Promise<UiLabDesign> {
  const design = await getDesign(id);
  if (!design) throw new UiLabNotFoundError();

  const sanitized = sanitizeMockHtml(extractHtml(html));
  const newVersion = design.version + 1;
  const now = new Date().toISOString();
  const historyEntry: UiLabHistoryEntry = {
    version: newVersion,
    html: sanitized,
    feedback: options.feedback ?? 'Boundary edit',
    createdAt: now,
  };
  const existingHistory: UiLabHistoryEntry[] = Array.isArray(design.history) ? design.history : [];

  const rows = await db
    .update(uiLabDesigns)
    .set({
      html: sanitized,
      version: newVersion,
      history: [...existingHistory, historyEntry],
      status: 'ready',
      generationError: null,
      updatedAt: now,
    })
    .where(eq(uiLabDesigns.id, id))
    .returning();

  return toDesign(rows[0] as Record<string, unknown>);
}

export async function reconcileUiLabV2Admission(
  input: Parameters<ReconcileUiLabV2Admission>[0],
): Promise<UiLabV2AdmissionState> {
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
    && snapshot?.workflowClass === 'ui-lab'
    && snapshot.subjectKind === 'ui-lab-screen'
    && snapshot.subjectId === input.subjectId
    && snapshot.generationStartedAt === input.generationStartedAt
  )
    ? 'intended'
    : 'conflicting';
}

async function runGenerationInProcess(input: {
  design: UiLabDesign;
  skillConfig: Awaited<ReturnType<typeof getSkillConfig>> | null;
  modelId?: string;
  maxTokens?: number;
  timeoutMs?: number;
  temperature?: number;
  onToken: (chunk: string, eventId?: string) => void;
  userId?: string;
}): Promise<void> {
  const { design } = input;
  await db
    .update(uiLabDesigns)
    .set({
      status: 'streaming',
      model: input.modelId ?? null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(uiLabDesigns.id, design.id));

  try {
    const rawHtml = await generateUiLabDesign({
      prompt: design.prompt,
      targetRoute: design.targetRoute,
      modelId: input.modelId,
      maxTokens: input.maxTokens,
      timeoutMs: input.timeoutMs,
      temperature: input.temperature,
      onToken: input.onToken,
      project: design.project,
      userId: input.userId,
      uiLabSkillPath: input.skillConfig?.uiLabSkillPath ?? undefined,
      skillRepo: input.skillConfig?.skillRepo ?? undefined,
      skillBranch: input.skillConfig?.skillBranch ?? undefined,
      skillProvider: input.skillConfig?.skillProvider ?? undefined,
    });

    const html = sanitizeMockHtml(extractHtml(rawHtml));
    const now = new Date().toISOString();
    const historyEntry: UiLabHistoryEntry = {
      version: 1,
      html,
      prompt: design.prompt,
      createdAt: now,
    };

    await db
      .update(uiLabDesigns)
      .set({
        status: 'ready',
        html,
        version: 1,
        history: [historyEntry],
        generationError: null,
        updatedAt: now,
      })
      .where(eq(uiLabDesigns.id, design.id));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .update(uiLabDesigns)
      .set({
        status: 'generation_failed',
        generationError: msg,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(uiLabDesigns.id, design.id));
    throw err;
  }
}

async function failClaimedUiLabGeneration(
  designId: string,
  generationStartedAt: string,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  await db
    .update(uiLabDesigns)
    .set({
      status: 'generation_failed',
      generationError: message,
      updatedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(uiLabDesigns.id, designId),
        eq(uiLabDesigns.status, 'streaming'),
        eq(uiLabDesigns.updatedAt, generationStartedAt),
      ),
    );
}

async function runGenerationV2(input: {
  design: UiLabDesign;
  skillConfig: Awaited<ReturnType<typeof getSkillConfig>> | null;
  modelId?: string;
  maxTokens?: number;
  timeoutMs?: number;
  temperature?: number;
  onToken: (chunk: string, eventId?: string) => void;
  onTransport?: (transport: 'v1' | 'v2') => void;
  userId?: string;
  dependencies: Required<Pick<
    UiLabGenerationDependencies,
    | 'admitV2Run'
    | 'reconcileV2Admission'
    | 'observeV2Run'
    | 'now'
    | 'resolveHardLimitMs'
  >> & Pick<UiLabGenerationDependencies, 'afterEventId'>;
}): Promise<boolean> {
  const { design, dependencies } = input;
  const threadId = visualRunThreadId('ui-lab-screen', design.id);

  if (design.status === 'streaming') {
    const generationStartedAt = new Date(design.updatedAt).toISOString();
    const runId = visualGenerationRunId(
      'ui-lab-screen',
      design.id,
      generationStartedAt,
    );
    const state = await dependencies.reconcileV2Admission({
      runId,
      threadId,
      subjectId: design.id,
      generationStartedAt,
    });
    if (state !== 'intended') return false;
    input.onTransport?.('v2');
    await dependencies.observeV2Run({
      designId: design.id,
      runId,
      threadId,
      generationStartedAt,
      onToken: input.onToken,
      afterEventId: input.dependencies.afterEventId,
    });
    return true;
  }

  let specification;
  try {
    const [promptInput, designReference] = await Promise.all([
      resolveUiLabPromptInput({
        userPrompt: design.prompt,
        targetRoute: design.targetRoute,
        project: design.project,
        uiLabSkillPath: input.skillConfig?.uiLabSkillPath ?? undefined,
        skillRepo: input.skillConfig?.skillRepo ?? undefined,
        skillBranch: input.skillConfig?.skillBranch ?? undefined,
        skillProvider: input.skillConfig?.skillProvider ?? undefined,
      }),
      Promise.resolve(resolveUiLabDesignReference()),
    ]);
    specification = buildUiLabVisualSpecification({
      designId: design.id,
      userPrompt: promptInput.userPrompt,
      targetRoute: promptInput.targetRoute,
      designSystemName: promptInput.designSystemName,
      skillMarkdown: promptInput.skillMarkdown,
      componentIndex: promptInput.componentIndex,
      existingPageContext: promptInput.existingPageContext,
      colorTokens: promptInput.colorTokens,
      catalog: promptInput.catalog,
      screenInventory: promptInput.screenInventory,
      navItems: designReference.navItems,
      images: designReference.images,
      model: resolveUiLabVisualModel({
        modelId: input.modelId,
        maxTokens: input.maxTokens,
        timeoutMs: input.timeoutMs,
        temperature: input.temperature,
      }),
      usage: {
        feature: 'ui-lab',
        project: design.project,
        userId: input.userId,
      },
    });
  } catch {
    return false;
  }

  const generationStartedAt = dependencies.now().toISOString();
  const claimed = await db
    .update(uiLabDesigns)
    .set({
      status: 'streaming',
      model: specification.model.modelId,
      generationError: null,
      updatedAt: generationStartedAt,
    })
    .where(
      and(
        eq(uiLabDesigns.id, design.id),
        eq(uiLabDesigns.updatedAt, design.updatedAt),
        inArray(uiLabDesigns.status, ['generating', 'generation_failed']),
      ),
    )
    .returning({ id: uiLabDesigns.id });
  if (claimed.length !== 1) {
    throw new Error(`UI Lab design ${design.id} generation was already claimed`);
  }

  const runId = visualGenerationRunId(
    'ui-lab-screen',
    design.id,
    generationStartedAt,
  );
  const admissionIdentity = {
    runId,
    threadId,
    subjectId: design.id,
    generationStartedAt,
  };
  let admissionResponseReceived = false;
  try {
    const admitted = await dependencies.admitV2Run({
      runId,
      threadId,
      projectId: design.project,
      workloadLane: VISUAL_WORKLOAD_LANE,
      capacityClass: 'interactive',
      timeoutAt: new Date(
        dependencies.now().getTime() + dependencies.resolveHardLimitMs(),
      ).toISOString(),
      specification: specification as unknown as Record<string, unknown>,
      executionSnapshot: {
        workflowClass: 'ui-lab',
        subjectKind: 'ui-lab-screen',
        subjectId: design.id,
        generationStartedAt,
      },
    });
    admissionResponseReceived = true;
    switch (admitted.status) {
      case 'dispatched':
        break;
      case 'active_run_conflict':
        if (
          admitted.existingRunId !== runId
          || admitted.existingTransportVersion !== 'servicebus-blob-v2'
        ) {
          throw new Error(
            `UI Lab V2 admission conflicted with run ${admitted.existingRunId}`,
          );
        }
        break;
      default: {
        const unhandled: never = admitted;
        throw new Error(`Unsupported UI Lab admission: ${String(unhandled)}`);
      }
    }
  } catch (error) {
    let state: UiLabV2AdmissionState;
    try {
      state = await dependencies.reconcileV2Admission(admissionIdentity);
    } catch {
      await failClaimedUiLabGeneration(
        design.id,
        generationStartedAt,
        error,
      );
      throw error;
    }
    if (state === 'intended') {
      // The durable run won even though its admission response was ambiguous.
    } else if (state === 'absent' && !admissionResponseReceived) {
      return false;
    } else {
      await failClaimedUiLabGeneration(
        design.id,
        generationStartedAt,
        error,
      );
      throw error;
    }
  }

  input.onTransport?.('v2');
  await dependencies.observeV2Run({
    designId: design.id,
    runId,
    threadId,
    generationStartedAt,
    onToken: input.onToken,
    afterEventId: input.dependencies.afterEventId,
  });
  return true;
}

/** Called by the SSE route. Streams tokens via onToken, then persists the final result. */
export async function runGeneration(
  designId: string,
  onToken: (chunk: string, eventId?: string) => void,
  userId?: string,
  dependencies: UiLabGenerationDependencies = {},
): Promise<void> {
  const design = await getDesign(designId);
  if (!design) throw new Error(`UI Lab design ${designId} not found`);
  if (dependencies.afterEventId && design.status === 'ready') return;
  if (dependencies.afterEventId && design.status === 'generation_failed') {
    throw new Error(design.generationError ?? 'Generation failed');
  }

  let skillConfig = null;
  try {
    skillConfig = await getSkillConfig(design.project);
  } catch {
    // non-fatal — use defaults
  }

  const modelId = skillConfig?.uiLabBedrockModelId ?? undefined;
  const maxTokens = skillConfig?.uiLabBedrockMaxTokens ?? undefined;
  const timeoutMs = skillConfig?.uiLabBedrockTimeoutMs ?? undefined;
  const temperature = skillConfig?.uiLabBedrockTemperature ?? undefined;
  const evaluateFlag = dependencies.isFeatureEnabled ?? isFeatureEnabled;
  let useV2Transport = false;
  try {
    useV2Transport = await evaluateFlag(UI_LAB_V2_TRANSPORT_FLAG, {
      userId: design.authorId,
      project: design.project,
      caller: 'ui-lab',
    });
  } catch {
    useV2Transport = false;
  }

  // Retain enabled after UI Lab V2 has held full rollout for two stable sprints.
  // @feature-flag:ui-lab-v2-transport start winner=enabled
  if (useV2Transport) {
    // @feature-flag:ui-lab-v2-transport enabled-start
    const handled = await runGenerationV2({
      design,
      skillConfig,
      modelId,
      maxTokens,
      timeoutMs,
      temperature,
      onToken,
      onTransport: dependencies.onTransport,
      userId,
      dependencies: {
        admitV2Run:
          dependencies.admitV2Run
          ?? ((admission) => createV2AdmissionService().admit(admission)),
        reconcileV2Admission:
          dependencies.reconcileV2Admission ?? reconcileUiLabV2Admission,
        observeV2Run: dependencies.observeV2Run ?? observeUiLabV2Run,
        now: dependencies.now ?? (() => new Date()),
        resolveHardLimitMs:
          dependencies.resolveHardLimitMs ?? resolveAgentRunHardLimitMs,
        afterEventId: dependencies.afterEventId,
      },
    });
    if (!handled) {
      dependencies.onTransport?.('v1');
      await runGenerationInProcess({
        design,
        skillConfig,
        modelId,
        maxTokens,
        timeoutMs,
        temperature,
        onToken,
        userId,
      });
    }
    // @feature-flag:ui-lab-v2-transport enabled-end
  } else {
    // @feature-flag:ui-lab-v2-transport disabled-start
    dependencies.onTransport?.('v1');
    await runGenerationInProcess({
      design,
      skillConfig,
      modelId,
      maxTokens,
      timeoutMs,
      temperature,
      onToken,
      userId,
    });
    // @feature-flag:ui-lab-v2-transport disabled-end
  }
  // @feature-flag:ui-lab-v2-transport end
}

/** Called by the SSE route for regeneration. */
export async function runRegeneration(
  designId: string,
  req: RegenerateUiLabDesignRequest,
  onToken: (chunk: string) => void,
  userId?: string,
): Promise<void> {
  const design = await getDesign(designId);
  if (!design) throw new Error(`UI Lab design ${designId} not found`);
  if (!design.html) throw new Error('Design has no HTML to regenerate from');

  let skillConfig = null;
  try {
    skillConfig = await getSkillConfig(design.project);
  } catch {
    // non-fatal
  }

  const modelId = skillConfig?.uiLabRegenBedrockModelId ?? skillConfig?.uiLabBedrockModelId ?? undefined;
  const maxTokens = skillConfig?.uiLabRegenBedrockMaxTokens ?? skillConfig?.uiLabBedrockMaxTokens ?? undefined;
  const timeoutMs = skillConfig?.uiLabBedrockTimeoutMs ?? undefined;
  const temperature = skillConfig?.uiLabBedrockTemperature ?? undefined;

  await db
    .update(uiLabDesigns)
    .set({ status: 'streaming', updatedAt: new Date().toISOString() })
    .where(eq(uiLabDesigns.id, designId));

  try {
    const rawHtml = await editUiLabDesign({
      currentHtml: design.html,
      instruction: req.feedback,
      selectedSelector: req.selectedSelector,
      selectedHtml: req.selectedHtml,
      targetRoute: design.targetRoute,
      featureText: design.prompt,
      modelId,
      maxTokens: maxTokens ?? undefined,
      timeoutMs: timeoutMs ?? undefined,
      temperature: temperature ?? undefined,
      onToken,
      project: design.project,
      userId,
      uiLabSkillPath: skillConfig?.uiLabSkillPath ?? undefined,
      skillRepo: skillConfig?.skillRepo ?? undefined,
      skillBranch: skillConfig?.skillBranch ?? undefined,
      skillProvider: skillConfig?.skillProvider ?? undefined,
    });

    const html = sanitizeMockHtml(extractHtml(rawHtml));
    const newVersion = design.version + 1;
    const now = new Date().toISOString();
    const historyEntry: UiLabHistoryEntry = {
      version: newVersion,
      html,
      feedback: req.feedback,
      selectedSelector: req.selectedSelector ?? undefined,
      createdAt: now,
    };

    const existingHistory: UiLabHistoryEntry[] = Array.isArray(design.history) ? design.history : [];

    await db
      .update(uiLabDesigns)
      .set({
        status: 'ready',
        html,
        version: newVersion,
        history: [...existingHistory, historyEntry],
        generationError: null,
        updatedAt: now,
      })
      .where(eq(uiLabDesigns.id, designId));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .update(uiLabDesigns)
      .set({
        status: 'generation_failed',
        generationError: msg,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(uiLabDesigns.id, designId));
    throw err;
  }
}

export async function listComments(designId: string): Promise<UiLabComment[]> {
  const rows = await db
    .select()
    .from(uiLabComments)
    .where(eq(uiLabComments.designId, designId))
    .orderBy(uiLabComments.createdAt);
  return rows.map((r) => toComment(r as Record<string, unknown>));
}

export async function addComment(
  designId: string,
  authorId: string,
  req: AddUiLabCommentRequest,
): Promise<UiLabComment> {
  const now = new Date().toISOString();
  const rows = await db
    .insert(uiLabComments)
    .values({
      designId,
      authorId,
      text: req.text,
      pinX: req.pinX ?? null,
      pinY: req.pinY ?? null,
      version: req.version,
      resolved: false,
      createdAt: now,
    })
    .returning();
  return toComment(rows[0] as Record<string, unknown>);
}

export async function resolveComment(commentId: string, resolvedBy: string): Promise<void> {
  await db
    .update(uiLabComments)
    .set({ resolved: true, resolvedBy })
    .where(eq(uiLabComments.id, commentId));
}

export async function reopenComment(commentId: string): Promise<void> {
  await db
    .update(uiLabComments)
    .set({ resolved: false, resolvedBy: null })
    .where(eq(uiLabComments.id, commentId));
}

export async function listDesignShares(
  designId: string,
  actorUserId: string,
  options: { isSuperAdmin?: boolean } = {},
): Promise<UiLabShare[]> {
  const design = await requireManageAccess(designId, actorUserId, options);
  const shares = await shareRepo.listShares(design.id);
  const names = await shareRepo.getDisplayNamesByIds(shares.map((s) => s.granteeId));
  return shares.map((s) => toShare(s, design.project, names.get(s.granteeId) ?? null));
}

export async function listDesignShareTargets(
  designId: string,
  query: string,
  actorUserId: string,
  options: { isSuperAdmin?: boolean } = {},
): Promise<UiLabShareTarget[]> {
  const design = await requireManageAccess(designId, actorUserId, options);
  const members = await shareRepo.listShareTargets(design.project, query ?? '', actorUserId);
  const shares = await shareRepo.listShares(design.id);
  const sharedIds = new Set(shares.map((s) => s.granteeId));
  return members.map((member) => ({
    userId: member.userId,
    displayName: member.displayName,
    email: member.email,
    alreadyShared: sharedIds.has(member.userId),
  }));
}

async function notifyNewShare(
  design: UiLabDesign,
  share: UiLabShare,
  actorUserId: string,
): Promise<void> {
  try {
    const names = await shareRepo.getDisplayNamesByIds([actorUserId]);
    const actorName = names.get(actorUserId) ?? 'A teammate';
    await createNotification(
      share.granteeId,
      {
        type: UI_LAB_SHARE_NOTIFICATION_TYPE,
        title: 'UI Lab design shared with you',
        body: `${actorName} shared "${design.title}" with view access`,
        link: share.link,
      },
      { dedupeKey: uiLabShareDedupeKey(share.id) },
    );
  } catch (err) {
    console.error('[uiLabService] new-share notification failed (share preserved):', err);
  }
}

export async function createDesignShare(
  designId: string,
  granteeId: string,
  actorUserId: string,
  options: { isSuperAdmin?: boolean } = {},
): Promise<UiLabShare> {
  const design = await requireManageAccess(designId, actorUserId, options);
  const trimmed = typeof granteeId === 'string' ? granteeId.trim() : '';
  if (!trimmed) throw new UiLabValidationError('granteeId is required');
  if (trimmed === actorUserId) {
    throw new UiLabValidationError('Cannot share a design with yourself');
  }

  const isMember = await shareRepo.isCurrentProjectMember(design.project, trimmed);
  if (!isMember) {
    throw new UiLabValidationError('Grantee must be a current project member');
  }

  const { share: row, created } = await shareRepo.upsertShare(design.id, trimmed, actorUserId);
  const names = await shareRepo.getDisplayNamesByIds([row.granteeId]);
  const share = toShare(row, design.project, names.get(row.granteeId) ?? null);
  if (created) {
    await notifyNewShare(design, share, actorUserId);
  }
  return share;
}

export async function revokeDesignShare(
  designId: string,
  granteeId: string,
  actorUserId: string,
  options: { isSuperAdmin?: boolean } = {},
): Promise<void> {
  const design = await requireManageAccess(designId, actorUserId, options);
  const trimmed = typeof granteeId === 'string' ? granteeId.trim() : '';
  if (!trimmed) throw new UiLabValidationError('granteeId is required');
  const removed = await shareRepo.deleteShare(design.id, trimmed);
  if (!removed) throw new UiLabNotFoundError('UI Lab share not found');
}
