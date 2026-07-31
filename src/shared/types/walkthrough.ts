/**
 * Shared Walkthrough domain contracts (FEAT-001).
 * Lifecycle, steps, nullable anchors, targeting, progress, commands, and reports.
 * FEAT-002 adds renderer definition / callback contracts and registry-backed anchor validation.
 */

import { validateRegisteredAnchor, type WalkthroughAnchorRegistryEntry } from '../walkthroughAnchors';
import { isWalkthroughRoute } from '../walkthroughRoutes';

// ── Lifecycle & status ────────────────────────────────────────────────────────

export type WalkthroughLifecycle = 'draft' | 'published' | 'unpublished' | 'archived';

/** Persisted progress statuses only — never store `acknowledged`. */
export type WalkthroughProgressStatus = 'seen' | 'completed' | 'dismissed';

export type WalkthroughTargetRuleType = 'project' | 'group' | 'everyone' | 'user';

export type WalkthroughAnchorPlacement =
  | 'top'
  | 'bottom'
  | 'left'
  | 'right'
  | 'top-start'
  | 'top-end'
  | 'bottom-start'
  | 'bottom-end';

export type WalkthroughPublishMode = 'fresh' | 'silent' | 'reshow';

export type WalkthroughDomainErrorCode =
  | 'WALKTHROUGH_NOT_FOUND'
  | 'INVALID_TRANSITION'
  | 'INVALID_TARGET'
  | 'REVISION_CONFLICT'
  | 'INACCESSIBLE'
  | 'INVALID_PROGRESS'
  | 'VALIDATION_ERROR';

export class WalkthroughDomainError extends Error {
  readonly code: WalkthroughDomainErrorCode;

  constructor(code: WalkthroughDomainErrorCode, message: string) {
    super(message);
    this.name = 'WalkthroughDomainError';
    this.code = code;
  }
}

// ── Anchor & Step ─────────────────────────────────────────────────────────────

/**
 * Why an anchored Step cannot use a live coachmark target (Phase 6 catalog cutover).
 * Surfaced on enriched definitions and miss telemetry.
 */
export type WalkthroughAnchorCatalogFallbackReason =
  | 'missing'
  | 'inactive'
  | 'deleted'
  | 'not_approved';

/**
 * Fully absent, or key + targetRoute + placement present. Partial tuples are invalid.
 * Optional enrichment fields are serve-time only (not persisted on steps).
 */
/** Serve-time opener control resolved from catalog (Phase 1 auto-open). */
export interface WalkthroughAnchorOpener {
  key: string;
  testId: string;
}

export type WalkthroughAnchor = {
  key: string;
  targetRoute: string;
  placement: WalkthroughAnchorPlacement;
  /** Resolved test ID from approved+active catalog (playback enrichment). */
  testId?: string | null;
  /**
   * Ordered opener controls to click before resolving this target when it is
   * not yet in the DOM (modals, menus, tabs). Serve-time enrichment only.
   */
  openers?: WalkthroughAnchorOpener[] | null;
  /** When true, playback centers immediately instead of waiting on DOM. */
  useCenteredFallback?: boolean;
  catalogFallbackReason?: WalkthroughAnchorCatalogFallbackReason;
} | null;

export interface WalkthroughStepInput {
  /** Client-stable id; server may generate when omitted on create. */
  id?: string;
  ordinal: number;
  heading: string;
  bodyMarkdown: string;
  /** First-class destination for this Step, whether anchored or unanchored. */
  route?: string | null;
  imageUrl?: string | null;
  imageAlt?: string | null;
  ctaLabel?: string | null;
  ctaRoute?: string | null;
  anchor?: WalkthroughAnchor;
}

export interface WalkthroughStep extends WalkthroughStepInput {
  id: string;
  walkthroughId: string;
}

// ── Targeting ─────────────────────────────────────────────────────────────────

export interface WalkthroughTargetRule {
  id?: string;
  type: WalkthroughTargetRuleType;
  value: string;
}

export interface WalkthroughTargeting {
  /** One or more project names (deduped). Audience is the union of members across these projects. */
  projects: string[];
  /**
   * Optional in-project group filter.
   * Only allowed when `projects.length === 1` (groups are project-scoped).
   */
  groupId?: string | null;
}

export type WalkthroughGenerationProvider = 'cursor' | 'bedrock';

/** Nullable on persisted legacy/manual Walkthroughs. */
export interface WalkthroughGenerationProvenance {
  provider: WalkthroughGenerationProvider;
  model: string;
  skillPath: string;
  generatedAt: string;
  runId?: string | null;
  threadId?: string | null;
}

// ── Aggregate definition ──────────────────────────────────────────────────────

export interface WalkthroughDefinition {
  id: string;
  internalName: string;
  userTitle: string;
  whyItMatters: string;
  lifecycle: WalkthroughLifecycle;
  priority: number;
  revision: number;
  publishedAt: string | null;
  archivedAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  /** Absent/null means manually authored or legacy provenance was not recorded. */
  generationProvenance?: WalkthroughGenerationProvenance | null;
  steps: WalkthroughStep[];
  targeting: WalkthroughTargeting;
  targetingRules: WalkthroughTargetRule[];
}

// ── Progress ──────────────────────────────────────────────────────────────────

export interface WalkthroughProgress {
  walkthroughId: string;
  userId: string;
  revision: number;
  status: WalkthroughProgressStatus;
  lastStepId: string | null;
  seenAt: string | null;
  acknowledgedAt: string | null;
  updatedAt: string;
  /** Derived: true when status is completed or dismissed. Never persisted. */
  acknowledged: boolean;
}

export interface UpdateWalkthroughProgressRequest {
  status: WalkthroughProgressStatus;
  revision: number;
  lastStepId?: string | null;
}

// ── Commands ──────────────────────────────────────────────────────────────────

export interface CreateWalkthroughCommand {
  internalName: string;
  userTitle: string;
  whyItMatters: string;
  priority?: number;
  generationProvenance?: WalkthroughGenerationProvenance | null;
  steps: WalkthroughStepInput[];
  targeting: WalkthroughTargeting;
}

export interface UpdateWalkthroughCommand {
  internalName?: string;
  userTitle?: string;
  whyItMatters?: string;
  priority?: number;
  generationProvenance?: WalkthroughGenerationProvenance | null;
  steps?: WalkthroughStepInput[];
  targeting?: WalkthroughTargeting;
  /** Optimistic concurrency against current revision. */
  expectedRevision?: number;
  expectedUpdatedAt?: string;
}

export interface PublishWalkthroughCommand {
  mode: WalkthroughPublishMode;
  targeting: WalkthroughTargeting;
  /** Optimistic concurrency against current updatedAt. */
  expectedUpdatedAt?: string;
}

export interface WalkthroughLifecycleCommand {
  expectedUpdatedAt?: string;
}

export type WalkthroughDraftCommand = CreateWalkthroughCommand;

export interface ValidatedWalkthroughDraft {
  valid: true;
  draft: CreateWalkthroughCommand;
}

// ── Catalog / replay / reports ────────────────────────────────────────────────

export interface WalkthroughCatalogQuery {
  cursor?: string | null;
  limit?: number;
  lifecycle?: WalkthroughLifecycle | WalkthroughLifecycle[];
  project?: string;
}

export interface WalkthroughCatalogPage {
  items: WalkthroughDefinition[];
  nextCursor: string | null;
}

export interface WalkthroughReplayEntry {
  walkthrough: WalkthroughDefinition;
  progress: WalkthroughProgress | null;
  state: 'new' | 'acknowledged';
}

export interface WalkthroughReplayPage {
  items: WalkthroughReplayEntry[];
  nextCursor: string | null;
}

export interface WalkthroughAcknowledgementUserRow {
  userId: string;
  displayName: string | null;
  email: string | null;
  status: 'completed' | 'dismissed';
  acknowledgedAt: string;
}

/** Optional detail filter for acknowledgement reporting (FEAT-008 PBI-010). */
export type WalkthroughAcknowledgementStatusFilter = 'all' | 'completed' | 'dismissed';

export interface WalkthroughAcknowledgementReport {
  walkthroughId: string;
  revision: number;
  /** ISO timestamp for the atomic snapshot used to build this report. */
  generatedAt: string;
  acknowledgedCount: number;
  audienceCount: number;
  completedCount: number;
  dismissedCount: number;
  /** Filtered detail rows (status filter applied); never a partial count payload. */
  details: WalkthroughAcknowledgementUserRow[];
  /** Convenience mirrors — same snapshot as `details` when filter is `all`. */
  completed: WalkthroughAcknowledgementUserRow[];
  dismissed: WalkthroughAcknowledgementUserRow[];
}

/** Authenticated miss ingestion body (FEAT-008 PBI-011). Caller/project derived server-side. */
export interface RecordAnchorMissRequest {
  occurrenceId: string;
  revision: number;
  anchorKey: string;
  targetRoute: string;
  reason?: string;
}

export interface WalkthroughAnchorMissReportItem {
  id: string;
  walkthroughId: string;
  stepId: string;
  stepOrder: number;
  stepHeading: string;
  revision: number;
  anchorKey: string;
  targetRoute: string;
  occurredAt: string;
}

export interface WalkthroughAnchorMissPage {
  items: WalkthroughAnchorMissReportItem[];
  nextCursor: string | null;
}

export interface ListAnchorMissesQuery {
  cursor?: string | null;
  limit?: number;
}

// ── Lifecycle transitions ─────────────────────────────────────────────────────

const ALLOWED_TRANSITIONS: Record<WalkthroughLifecycle, readonly WalkthroughLifecycle[]> = {
  draft: ['published', 'archived'],
  published: ['unpublished', 'archived'],
  unpublished: ['published', 'archived'],
  archived: [],
};

export function canTransitionLifecycle(
  from: WalkthroughLifecycle,
  to: WalkthroughLifecycle,
): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function isAcknowledgedStatus(status: WalkthroughProgressStatus): boolean {
  return status === 'completed' || status === 'dismissed';
}

export function deriveAcknowledged(status: WalkthroughProgressStatus): boolean {
  return isAcknowledgedStatus(status);
}

// ── Validators (pure) ─────────────────────────────────────────────────────────

const LIFECYCLES = new Set<WalkthroughLifecycle>(['draft', 'published', 'unpublished', 'archived']);
const PROGRESS_STATUSES = new Set<WalkthroughProgressStatus>(['seen', 'completed', 'dismissed']);
const PLACEMENTS = new Set<WalkthroughAnchorPlacement>([
  'top',
  'bottom',
  'left',
  'right',
  'top-start',
  'top-end',
  'bottom-start',
  'bottom-end',
]);
const IN_APP_ROUTE_RE = /^\/[A-Za-z0-9/_-]*$/;

export function isWalkthroughProgressStatus(value: unknown): value is WalkthroughProgressStatus {
  return typeof value === 'string' && PROGRESS_STATUSES.has(value as WalkthroughProgressStatus);
}

export function isWalkthroughLifecycle(value: unknown): value is WalkthroughLifecycle {
  return typeof value === 'string' && LIFECYCLES.has(value as WalkthroughLifecycle);
}

/**
 * Rejects stored `acknowledged` and any non-progress status.
 * DoD: acknowledged remains derived and is not persisted.
 */
export function assertPersistedProgressStatus(value: unknown): WalkthroughProgressStatus {
  if (value === 'acknowledged') {
    throw new WalkthroughDomainError(
      'INVALID_PROGRESS',
      'acknowledged is derived from completed or dismissed and must not be persisted',
    );
  }
  if (!isWalkthroughProgressStatus(value)) {
    throw new WalkthroughDomainError(
      'INVALID_PROGRESS',
      `Invalid progress status: ${String(value)}`,
    );
  }
  return value;
}

/**
 * Anchor must be fully null/absent or have key + targetRoute + placement.
 * Performs shape validation only. Catalog membership is enforced by the server
 * (and authoring UI) against an injected approved+active snapshot (Phase 6).
 */
export function validateAnchor(anchor: unknown): WalkthroughAnchor {
  if (anchor === undefined || anchor === null) return null;
  if (typeof anchor !== 'object') {
    throw new WalkthroughDomainError('VALIDATION_ERROR', 'Anchor must be an object or null');
  }
  const a = anchor as Record<string, unknown>;
  const key = a.key;
  const targetRoute = a.targetRoute;
  const placement = a.placement;
  const present = [key, targetRoute, placement].filter((v) => v !== undefined && v !== null && v !== '');
  if (present.length === 0) return null;
  if (present.length !== 3) {
    throw new WalkthroughDomainError(
      'VALIDATION_ERROR',
      'Incomplete anchor tuple: key, targetRoute, and placement are all required when any is set',
    );
  }
  if (typeof key !== 'string' || !key.trim()) {
    throw new WalkthroughDomainError('VALIDATION_ERROR', 'Anchor key must be a non-empty string');
  }
  if (/[#.[\]>+~*=]|^\s*\/\//.test(key) || key.includes(' ')) {
    throw new WalkthroughDomainError(
      'VALIDATION_ERROR',
      'Anchor key must be an exact registry key, not a CSS selector or DOM path',
    );
  }
  if (typeof targetRoute !== 'string' || !IN_APP_ROUTE_RE.test(targetRoute)) {
    throw new WalkthroughDomainError('VALIDATION_ERROR', 'Anchor targetRoute must be an in-app route');
  }
  if (typeof placement !== 'string' || !PLACEMENTS.has(placement as WalkthroughAnchorPlacement)) {
    throw new WalkthroughDomainError('VALIDATION_ERROR', `Unsupported anchor placement: ${String(placement)}`);
  }

  return {
    key: key.trim(),
    targetRoute,
    placement: placement as WalkthroughAnchorPlacement,
  };
}

/**
 * Enforce catalog membership for a shape-valid anchor against an injected snapshot.
 */
export function assertAnchorInCatalog(
  anchor: NonNullable<WalkthroughAnchor>,
  catalog: readonly WalkthroughAnchorRegistryEntry[],
): NonNullable<WalkthroughAnchor> {
  const registered = validateRegisteredAnchor(anchor, catalog);
  if (registered.ok === false) {
    const first = registered.errors[0];
    throw new WalkthroughDomainError(
      'VALIDATION_ERROR',
      first?.message ?? 'Invalid registered anchor',
    );
  }
  if (registered.anchor === null) {
    throw new WalkthroughDomainError('VALIDATION_ERROR', 'Invalid registered anchor');
  }
  return registered.anchor;
}

// ── Renderer contracts (FEAT-002) ─────────────────────────────────────────────

export type WalkthroughAnchorMissReason =
  | 'timeout'
  | 'unregistered'
  | 'invalid_route'
  | 'route_mismatch'
  | 'unsupported_placement'
  | 'missing'
  | 'inactive'
  | 'deleted'
  | 'not_approved'
  | 'opener_missing';

export interface WalkthroughAnchorMiss {
  walkthroughId: string;
  revision: number;
  stepId: string;
  anchorKey: string;
  targetRoute: string;
  reason: WalkthroughAnchorMissReason;
  clientTimestamp: string;
  /** UUID created once per anchored Step render attempt (FEAT-008 idempotency). */
  occurrenceId: string;
}

export interface WalkthroughRendererStep {
  id: string;
  position: number;
  heading: string;
  bodyMarkdown: string;
  route?: string | null;
  imageUrl?: string | null;
  imageAlt?: string | null;
  ctaLabel?: string | null;
  ctaRoute?: string | null;
  anchor?: WalkthroughAnchor;
}

export interface WalkthroughRendererDefinition {
  id: string;
  revision: number;
  title: string;
  intro?: string | null;
  steps: WalkthroughRendererStep[];
}

export interface WalkthroughRendererCallbacks {
  onSeen?: (payload: { walkthroughId: string; revision: number; stepId: string }) => void;
  onStepChange?: (payload: {
    walkthroughId: string;
    revision: number;
    stepId: string;
    stepIndex: number;
  }) => void;
  onComplete?: (payload: { walkthroughId: string; revision: number; stepId: string }) => void;
  onDismiss?: (payload: { walkthroughId: string; revision: number; stepId: string }) => void;
  onAnchorMiss?: (payload: WalkthroughAnchorMiss) => void;
}

/**
 * Multi-project targeting: one or more projects; optional group only when a single project is selected.
 * Rejects everyone/user targeting. Accepts legacy `{ project: string }` payloads and normalizes to `projects`.
 */
export function validateTargeting(targeting: unknown): WalkthroughTargeting {
  if (!targeting || typeof targeting !== 'object') {
    throw new WalkthroughDomainError('INVALID_TARGET', 'Targeting is required');
  }
  const t = targeting as Record<string, unknown>;
  if (t.everyone === true || t.type === 'everyone') {
    throw new WalkthroughDomainError('INVALID_TARGET', 'everyone/global targeting is not supported');
  }
  if (t.userId || t.type === 'user') {
    throw new WalkthroughDomainError('INVALID_TARGET', 'Individual-user targeting is not supported');
  }

  let projects: string[] = [];
  if (Array.isArray(t.projects)) {
    projects = t.projects
      .filter((p): p is string => typeof p === 'string')
      .map((p) => p.trim())
      .filter(Boolean);
  } else if (typeof t.project === 'string' && t.project.trim()) {
    // Legacy single-project payload
    projects = [t.project.trim()];
  }

  // Dedupe while preserving order
  projects = [...new Set(projects)];
  if (projects.length === 0) {
    throw new WalkthroughDomainError('INVALID_TARGET', 'At least one project target is required');
  }

  let groupId: string | null = null;
  if (t.groupId !== undefined && t.groupId !== null && t.groupId !== '') {
    if (typeof t.groupId !== 'string') {
      throw new WalkthroughDomainError('INVALID_TARGET', 'groupId must be a string UUID');
    }
    if (projects.length !== 1) {
      throw new WalkthroughDomainError(
        'INVALID_TARGET',
        'A group filter is only allowed when targeting exactly one project',
      );
    }
    groupId = t.groupId;
  }
  return { projects, groupId };
}

export function validateTargetRules(rules: WalkthroughTargetRule[]): WalkthroughTargeting {
  const projectRules = rules.filter((r) => r.type === 'project');
  const groups = rules.filter((r) => r.type === 'group');
  const unsupported = rules.filter((r) => r.type === 'everyone' || r.type === 'user');
  if (unsupported.length > 0) {
    throw new WalkthroughDomainError(
      'INVALID_TARGET',
      `Unsupported target rule type: ${unsupported[0].type}`,
    );
  }
  if (projectRules.length < 1) {
    throw new WalkthroughDomainError('INVALID_TARGET', 'At least one project target rule is required');
  }
  if (groups.length > 1) {
    throw new WalkthroughDomainError('INVALID_TARGET', 'At most one group target rule is allowed');
  }
  const projects = [...new Set(projectRules.map((r) => r.value.trim()).filter(Boolean))];
  if (projects.length === 0) {
    throw new WalkthroughDomainError('INVALID_TARGET', 'Project target value is required');
  }
  if (groups.length > 0 && projects.length !== 1) {
    throw new WalkthroughDomainError(
      'INVALID_TARGET',
      'A group filter is only allowed when targeting exactly one project',
    );
  }
  return {
    projects,
    groupId: groups[0]?.value ?? null,
  };
}

const WALKTHROUGH_SKILL_PATH_RE = /^\.cursor\/skills\/[^/]+\/SKILL\.md$/;

export function validateGenerationProvenance(
  value: unknown,
): WalkthroughGenerationProvenance | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new WalkthroughDomainError(
      'VALIDATION_ERROR',
      'generationProvenance must be an object or null',
    );
  }
  const p = value as Record<string, unknown>;
  if (p.provider !== 'cursor' && p.provider !== 'bedrock') {
    throw new WalkthroughDomainError(
      'VALIDATION_ERROR',
      'generationProvenance provider must be cursor or bedrock',
    );
  }
  if (typeof p.model !== 'string' || !p.model.trim()) {
    throw new WalkthroughDomainError(
      'VALIDATION_ERROR',
      'generationProvenance model is required',
    );
  }
  if (typeof p.skillPath !== 'string' || !WALKTHROUGH_SKILL_PATH_RE.test(p.skillPath)) {
    throw new WalkthroughDomainError(
      'VALIDATION_ERROR',
      'generationProvenance skillPath must match .cursor/skills/*/SKILL.md',
    );
  }
  if (
    typeof p.generatedAt !== 'string' ||
    !p.generatedAt.trim() ||
    Number.isNaN(Date.parse(p.generatedAt))
  ) {
    throw new WalkthroughDomainError(
      'VALIDATION_ERROR',
      'generationProvenance generatedAt must be an ISO timestamp',
    );
  }
  const runId =
    p.runId === undefined || p.runId === null || p.runId === ''
      ? null
      : typeof p.runId === 'string'
        ? p.runId.trim()
        : null;
  const threadId =
    p.threadId === undefined || p.threadId === null || p.threadId === ''
      ? null
      : typeof p.threadId === 'string'
        ? p.threadId.trim()
        : null;
  if ((p.runId != null && typeof p.runId !== 'string') || (p.threadId != null && typeof p.threadId !== 'string')) {
    throw new WalkthroughDomainError(
      'VALIDATION_ERROR',
      'generationProvenance runId and threadId must be strings or null',
    );
  }
  if (!runId && !threadId) {
    throw new WalkthroughDomainError(
      'VALIDATION_ERROR',
      'generationProvenance requires a runId or threadId',
    );
  }
  return {
    provider: p.provider,
    model: p.model.trim(),
    skillPath: p.skillPath,
    generatedAt: new Date(p.generatedAt).toISOString(),
    runId,
    threadId,
  };
}

export function validateSteps(steps: unknown): WalkthroughStepInput[] {
  if (!Array.isArray(steps)) {
    throw new WalkthroughDomainError('VALIDATION_ERROR', 'Steps must be an array');
  }
  if (steps.length > 20) {
    throw new WalkthroughDomainError('VALIDATION_ERROR', 'A Walkthrough may have at most ~20 Steps');
  }
  const ordinals = new Set<number>();
  const normalized: WalkthroughStepInput[] = [];
  for (const raw of steps) {
    if (!raw || typeof raw !== 'object') {
      throw new WalkthroughDomainError('VALIDATION_ERROR', 'Each Step must be an object');
    }
    const s = raw as Record<string, unknown>;
    if (typeof s.ordinal !== 'number' || !Number.isInteger(s.ordinal) || s.ordinal < 0) {
      throw new WalkthroughDomainError('VALIDATION_ERROR', 'Step ordinal must be a non-negative integer');
    }
    if (ordinals.has(s.ordinal)) {
      throw new WalkthroughDomainError('VALIDATION_ERROR', `Duplicate Step ordinal: ${s.ordinal}`);
    }
    ordinals.add(s.ordinal);
    if (typeof s.heading !== 'string' || !s.heading.trim()) {
      throw new WalkthroughDomainError('VALIDATION_ERROR', 'Step heading is required');
    }
    if (typeof s.bodyMarkdown !== 'string') {
      throw new WalkthroughDomainError('VALIDATION_ERROR', 'Step bodyMarkdown is required');
    }
    if (s.route != null && s.route !== '' && !isWalkthroughRoute(s.route)) {
      throw new WalkthroughDomainError(
        'VALIDATION_ERROR',
        'Step route must be in the curated Walkthrough route catalog',
      );
    }
    if (s.ctaRoute != null && s.ctaRoute !== '') {
      if (!isWalkthroughRoute(s.ctaRoute)) {
        throw new WalkthroughDomainError(
          'VALIDATION_ERROR',
          'Step ctaRoute must be in the curated Walkthrough route catalog',
        );
      }
    }
    if (s.imageUrl != null && s.imageUrl !== '') {
      if (typeof s.imageUrl !== 'string' || !/^(\/|https?:\/\/)/i.test(s.imageUrl)) {
        throw new WalkthroughDomainError('VALIDATION_ERROR', 'Step imageUrl must be a path or http(s) URL');
      }
    }
    if (s.imageAlt != null && typeof s.imageAlt !== 'string') {
      throw new WalkthroughDomainError('VALIDATION_ERROR', 'Step imageAlt must be a string or null');
    }
    const anchor = validateAnchor(s.anchor);
    // Anchored steps always play on the registered catalog route. Coerce rather
    // than reject when step.route drifted (common after AI draft + manual re-pick).
    const route = anchor?.targetRoute
      ?? (typeof s.route === 'string' && s.route ? s.route : null);
    normalized.push({
      id: typeof s.id === 'string' ? s.id : undefined,
      ordinal: s.ordinal,
      heading: s.heading.trim(),
      bodyMarkdown: s.bodyMarkdown,
      route,
      imageUrl: (s.imageUrl as string | null | undefined) ?? null,
      imageAlt: (s.imageAlt as string | null | undefined) ?? null,
      ctaLabel: (s.ctaLabel as string | null | undefined) ?? null,
      ctaRoute: (s.ctaRoute as string | null | undefined) ?? null,
      anchor,
    });
  }
  return normalized.sort((a, b) => a.ordinal - b.ordinal);
}

export function validateCreateCommand(body: unknown): CreateWalkthroughCommand {
  if (!body || typeof body !== 'object') {
    throw new WalkthroughDomainError('VALIDATION_ERROR', 'Create body is required');
  }
  const b = body as Record<string, unknown>;
  if (typeof b.internalName !== 'string' || !b.internalName.trim()) {
    throw new WalkthroughDomainError('VALIDATION_ERROR', 'internalName is required');
  }
  if (typeof b.userTitle !== 'string' || !b.userTitle.trim()) {
    throw new WalkthroughDomainError('VALIDATION_ERROR', 'userTitle is required');
  }
  if (typeof b.whyItMatters !== 'string') {
    throw new WalkthroughDomainError('VALIDATION_ERROR', 'whyItMatters is required');
  }
  const priority = b.priority === undefined ? 0 : b.priority;
  if (typeof priority !== 'number' || !Number.isInteger(priority)) {
    throw new WalkthroughDomainError('VALIDATION_ERROR', 'priority must be an integer');
  }
  return {
    internalName: b.internalName.trim(),
    userTitle: b.userTitle.trim(),
    whyItMatters: b.whyItMatters,
    priority,
    ...(b.generationProvenance !== undefined
      ? { generationProvenance: validateGenerationProvenance(b.generationProvenance) }
      : {}),
    steps: validateSteps(b.steps ?? []),
    targeting: validateTargeting(b.targeting),
  };
}

export function targetingToRules(targeting: WalkthroughTargeting): WalkthroughTargetRule[] {
  const rules: WalkthroughTargetRule[] = targeting.projects.map((project) => ({
    type: 'project' as const,
    value: project,
  }));
  if (targeting.groupId) {
    rules.push({ type: 'group', value: targeting.groupId });
  }
  return rules;
}

export function rulesToTargeting(rules: WalkthroughTargetRule[]): WalkthroughTargeting {
  return validateTargetRules(rules);
}
