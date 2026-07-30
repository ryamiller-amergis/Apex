/**
 * Shared Walkthrough domain contracts (FEAT-001).
 * Lifecycle, steps, nullable anchors, targeting, progress, commands, and reports.
 * FEAT-002 adds renderer definition / callback contracts and registry-backed anchor validation.
 */

import { validateRegisteredAnchor } from '../walkthroughAnchors';

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

/** Fully absent, or all three fields present. Partial tuples are invalid. */
export type WalkthroughAnchor = {
  key: string;
  targetRoute: string;
  placement: WalkthroughAnchorPlacement;
} | null;

export interface WalkthroughStepInput {
  /** Client-stable id; server may generate when omitted on create. */
  id?: string;
  ordinal: number;
  heading: string;
  bodyMarkdown: string;
  imageUrl?: string | null;
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
  project: string;
  groupId?: string | null;
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
  steps: WalkthroughStepInput[];
  targeting: WalkthroughTargeting;
}

export interface UpdateWalkthroughCommand {
  internalName?: string;
  userTitle?: string;
  whyItMatters?: string;
  priority?: number;
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
 * Anchored values must match the curated registry (FEAT-002 / BR-013).
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
  if (typeof targetRoute !== 'string' || !IN_APP_ROUTE_RE.test(targetRoute)) {
    throw new WalkthroughDomainError('VALIDATION_ERROR', 'Anchor targetRoute must be an in-app route');
  }
  if (typeof placement !== 'string' || !PLACEMENTS.has(placement as WalkthroughAnchorPlacement)) {
    throw new WalkthroughDomainError('VALIDATION_ERROR', `Unsupported anchor placement: ${String(placement)}`);
  }

  const registered = validateRegisteredAnchor({
    key: key.trim(),
    targetRoute,
    placement: placement as WalkthroughAnchorPlacement,
  });
  if (registered.ok === false) {
    const first = registered.errors[0];
    throw new WalkthroughDomainError(
      'VALIDATION_ERROR',
      first?.message ?? 'Invalid registered anchor',
    );
  }
  return registered.anchor;
}

// ── Renderer contracts (FEAT-002) ─────────────────────────────────────────────

export type WalkthroughAnchorMissReason =
  | 'timeout'
  | 'unregistered'
  | 'invalid_route'
  | 'route_mismatch'
  | 'unsupported_placement';

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
  imageUrl?: string | null;
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
 * V1 targeting: exactly one project, optional in-project group.
 * Rejects everyone/user and malformed shapes.
 */
export function validateTargeting(targeting: unknown): WalkthroughTargeting {
  if (!targeting || typeof targeting !== 'object') {
    throw new WalkthroughDomainError('INVALID_TARGET', 'Targeting is required');
  }
  const t = targeting as Record<string, unknown>;
  if (typeof t.project !== 'string' || !t.project.trim()) {
    throw new WalkthroughDomainError('INVALID_TARGET', 'A project target is required');
  }
  if (t.everyone === true || t.type === 'everyone') {
    throw new WalkthroughDomainError('INVALID_TARGET', 'everyone/global targeting is not supported in v1');
  }
  if (t.userId || t.type === 'user') {
    throw new WalkthroughDomainError('INVALID_TARGET', 'Individual-user targeting is not supported in v1');
  }
  let groupId: string | null = null;
  if (t.groupId !== undefined && t.groupId !== null && t.groupId !== '') {
    if (typeof t.groupId !== 'string') {
      throw new WalkthroughDomainError('INVALID_TARGET', 'groupId must be a string UUID');
    }
    groupId = t.groupId;
  }
  return { project: t.project.trim(), groupId };
}

export function validateTargetRules(rules: WalkthroughTargetRule[]): WalkthroughTargeting {
  const projects = rules.filter((r) => r.type === 'project');
  const groups = rules.filter((r) => r.type === 'group');
  const unsupported = rules.filter((r) => r.type === 'everyone' || r.type === 'user');
  if (unsupported.length > 0) {
    throw new WalkthroughDomainError(
      'INVALID_TARGET',
      `Unsupported target rule type: ${unsupported[0].type}`,
    );
  }
  if (projects.length !== 1) {
    throw new WalkthroughDomainError('INVALID_TARGET', 'Exactly one project target rule is required');
  }
  if (groups.length > 1) {
    throw new WalkthroughDomainError('INVALID_TARGET', 'At most one group target rule is allowed');
  }
  if (!projects[0].value?.trim()) {
    throw new WalkthroughDomainError('INVALID_TARGET', 'Project target value is required');
  }
  return {
    project: projects[0].value.trim(),
    groupId: groups[0]?.value ?? null,
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
    if (s.ctaRoute != null && s.ctaRoute !== '') {
      if (typeof s.ctaRoute !== 'string' || !IN_APP_ROUTE_RE.test(s.ctaRoute)) {
        throw new WalkthroughDomainError('VALIDATION_ERROR', 'Step ctaRoute must be an in-app route');
      }
    }
    if (s.imageUrl != null && s.imageUrl !== '') {
      if (typeof s.imageUrl !== 'string' || !/^(\/|https?:\/\/)/i.test(s.imageUrl)) {
        throw new WalkthroughDomainError('VALIDATION_ERROR', 'Step imageUrl must be a path or http(s) URL');
      }
    }
    const anchor = validateAnchor(s.anchor);
    normalized.push({
      id: typeof s.id === 'string' ? s.id : undefined,
      ordinal: s.ordinal,
      heading: s.heading.trim(),
      bodyMarkdown: s.bodyMarkdown,
      imageUrl: (s.imageUrl as string | null | undefined) ?? null,
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
    steps: validateSteps(b.steps ?? []),
    targeting: validateTargeting(b.targeting),
  };
}

export function targetingToRules(targeting: WalkthroughTargeting): WalkthroughTargetRule[] {
  const rules: WalkthroughTargetRule[] = [{ type: 'project', value: targeting.project }];
  if (targeting.groupId) {
    rules.push({ type: 'group', value: targeting.groupId });
  }
  return rules;
}

export function rulesToTargeting(rules: WalkthroughTargetRule[]): WalkthroughTargeting {
  return validateTargetRules(rules);
}
