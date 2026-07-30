/**
 * Shared contracts for the database-backed walkthrough anchor catalog
 * (Smart Anchor Management — Phase 1 foundation).
 *
 * An approved+active catalog record is the runtime allow-list unit around a
 * stable test ID. Ordinary discovered test IDs remain candidates until reviewed.
 */

import type { WalkthroughGenerationProvider } from './walkthrough';
import type { WalkthroughRegistryPlacement } from '../walkthroughAnchors';
import { WALKTHROUGH_REGISTRY_PLACEMENTS } from '../walkthroughAnchors';
import { isWalkthroughRoute } from '../walkthroughRoutes';

// ── Enumerations ──────────────────────────────────────────────────────────────

export const WALKTHROUGH_ANCHOR_REVIEW_STATUSES = [
  'pending',
  'approved',
  'rejected',
] as const;

export type WalkthroughAnchorReviewStatus =
  (typeof WALKTHROUGH_ANCHOR_REVIEW_STATUSES)[number];

export const WALKTHROUGH_ANCHOR_SOURCE_KINDS = [
  'explicit',
  'data_testid',
  'manual',
] as const;

export type WalkthroughAnchorSourceKind =
  (typeof WALKTHROUGH_ANCHOR_SOURCE_KINDS)[number];

export const WALKTHROUGH_ANCHOR_SMART_TAG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ── JSONB shapes ──────────────────────────────────────────────────────────────

export interface WalkthroughAnchorSourceLocation {
  /** Repository-relative path (posix-style). */
  filePath: string;
  /** 1-based line when known; null/omitted when not available. */
  line?: number | null;
  /** How this occurrence was discovered. */
  discoveryKind?: WalkthroughAnchorSourceKind | null;
}

export interface WalkthroughAnchorAiProvenance {
  provider: WalkthroughGenerationProvider;
  model: string;
  skillPath: string;
  generatedAt: string;
  runId?: string | null;
  threadId?: string | null;
  confidence?: number | null;
  rationale?: string | null;
}

/** Persisted catalog row (camelCase API / Drizzle shape). */
export interface WalkthroughAnchorRegistryRecord {
  id: string;
  anchorKey: string;
  testId: string;
  label: string;
  suggestedRoute: string | null;
  approvedRoute: string | null;
  allowedPlacements: readonly WalkthroughRegistryPlacement[];
  smartTags: readonly string[];
  sourceKind: WalkthroughAnchorSourceKind;
  sourceLocations: readonly WalkthroughAnchorSourceLocation[];
  sourceHash: string | null;
  reviewStatus: WalkthroughAnchorReviewStatus;
  isActive: boolean;
  lastSeenAt: string | null;
  missingSince: string | null;
  deletedAt: string | null;
  aiProvenance: WalkthroughAnchorAiProvenance | null;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
}

export type WalkthroughAnchorRegistrySeed = Omit<
  WalkthroughAnchorRegistryRecord,
  | 'id'
  | 'createdAt'
  | 'updatedAt'
  | 'lastSeenAt'
  | 'missingSince'
  | 'deletedAt'
  | 'aiProvenance'
> & {
  /** Deterministic baseline seed marker; applied as source_hash. */
  sourceHash: string;
  lastSeenAt?: string | null;
  missingSince?: string | null;
  deletedAt?: string | null;
  aiProvenance?: WalkthroughAnchorAiProvenance | null;
};

export type WalkthroughAnchorRegistryValidationCode =
  | 'INVALID_ANCHOR_KEY'
  | 'INVALID_TEST_ID'
  | 'INVALID_LABEL'
  | 'INVALID_ROUTE'
  | 'INVALID_PLACEMENTS'
  | 'INVALID_SMART_TAGS'
  | 'INVALID_SOURCE_KIND'
  | 'INVALID_SOURCE_LOCATIONS'
  | 'INVALID_REVIEW_STATUS'
  | 'ACTIVE_REQUIRES_APPROVED';

export interface WalkthroughAnchorRegistryValidationError {
  field: string;
  code: WalkthroughAnchorRegistryValidationCode;
  message: string;
}

// ── Domain / API contracts (Phase 2 CRUD) ─────────────────────────────────────

export type WalkthroughAnchorRegistryErrorCode =
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'DUPLICATE'
  | 'ACTIVE_REQUIRES_APPROVED';

export class WalkthroughAnchorRegistryError extends Error {
  readonly code: WalkthroughAnchorRegistryErrorCode;
  readonly details?: readonly WalkthroughAnchorRegistryValidationError[];

  constructor(
    code: WalkthroughAnchorRegistryErrorCode,
    message: string,
    details?: readonly WalkthroughAnchorRegistryValidationError[],
  ) {
    super(message);
    this.name = 'WalkthroughAnchorRegistryError';
    this.code = code;
    this.details = details;
  }
}

export const WALKTHROUGH_ANCHOR_BULK_ACTIONS = [
  'approve',
  'reject',
  'activate',
  'deactivate',
] as const;

export type WalkthroughAnchorBulkAction =
  (typeof WALKTHROUGH_ANCHOR_BULK_ACTIONS)[number];

export interface WalkthroughAnchorRegistryListQuery {
  /** Free-text match against anchorKey, testId, or label. */
  search?: string;
  reviewStatus?: WalkthroughAnchorReviewStatus | WalkthroughAnchorReviewStatus[];
  isActive?: boolean;
  sourceKind?: WalkthroughAnchorSourceKind | WalkthroughAnchorSourceKind[];
  /** Filter by approvedRoute (exact). */
  approvedRoute?: string;
  /** Require all listed tags (JSONB containment). */
  smartTags?: readonly string[];
  /** When true, only rows with missingSince set. */
  missingOnly?: boolean;
  /** Include soft-deleted rows (default false). */
  includeDeleted?: boolean;
  limit?: number;
  /** Opaque ISO createdAt cursor (created_at DESC, id DESC). */
  cursor?: string | null;
}

export interface WalkthroughAnchorRegistryListPage {
  items: WalkthroughAnchorRegistryRecord[];
  nextCursor: string | null;
  /** Aggregate counts for the filtered non-paginated set (Wave 2 UI shell). */
  counts: {
    total: number;
    pending: number;
    approved: number;
    rejected: number;
    active: number;
    missing: number;
  };
}

export interface WalkthroughAnchorModuleCoverageEntry {
  key: string;
  label: string;
  anchorCount: number;
  routes: readonly string[];
}

export interface WalkthroughAnchorModuleCoverage {
  totalModules: number;
  coveredCount: number;
  uncoveredCount: number;
  coveredModules: WalkthroughAnchorModuleCoverageEntry[];
  uncoveredModules: WalkthroughAnchorModuleCoverageEntry[];
}

/** Super Admin manual add — sourceKind is always `manual`. */
export interface CreateManualWalkthroughAnchorCommand {
  anchorKey: string;
  testId: string;
  label: string;
  suggestedRoute?: string | null;
  approvedRoute?: string | null;
  allowedPlacements: readonly WalkthroughRegistryPlacement[];
  smartTags?: readonly string[];
  sourceLocations?: readonly WalkthroughAnchorSourceLocation[];
  /** Defaults to `approved` for Super Admin manual adds; may be `pending`. */
  reviewStatus?: WalkthroughAnchorReviewStatus;
  /** Only honored when reviewStatus is `approved` (default false when pending). */
  isActive?: boolean;
}

export interface UpdateWalkthroughAnchorCommand {
  label?: string;
  suggestedRoute?: string | null;
  approvedRoute?: string | null;
  allowedPlacements?: readonly WalkthroughRegistryPlacement[];
  smartTags?: readonly string[];
  sourceLocations?: readonly WalkthroughAnchorSourceLocation[];
  reviewStatus?: WalkthroughAnchorReviewStatus;
  isActive?: boolean;
}

export interface BulkWalkthroughAnchorCommand {
  ids: readonly string[];
  action: WalkthroughAnchorBulkAction;
}

export interface WalkthroughAnchorMissingUpdate {
  id: string;
  /** ISO timestamp to mark missing, or null to clear. */
  missingSince: string | null;
}

export interface UpdateWalkthroughAnchorMissingStateCommand {
  updates: readonly WalkthroughAnchorMissingUpdate[];
}

/**
 * Scanner-discovered candidate insert (Wave 2 Track A).
 * Always persists as pending + inactive; AI tagging may enrich later.
 */
export interface CreateWalkthroughAnchorFromCandidateCommand {
  testId: string;
  /** Defaults to testId when omitted/null. */
  suggestedAnchorKey?: string | null;
  sourceKind: Extract<WalkthroughAnchorSourceKind, 'explicit' | 'data_testid'>;
  sourceLocations: readonly WalkthroughAnchorSourceLocation[];
  sourceHash: string;
  /** Defaults to a humanized testId. */
  label?: string;
  /** Defaults to `['bottom']`. */
  allowedPlacements?: readonly WalkthroughRegistryPlacement[];
  suggestedRoute?: string | null;
}

/** Opaque catalog row shape used to diff a scan (no soft-deleted rows). */
export interface WalkthroughAnchorCatalogSnapshotEntry {
  testId: string;
  anchorKey?: string;
  reviewStatus?: WalkthroughAnchorReviewStatus;
  isActive?: boolean;
  deletedAt?: string | null;
}

export interface WalkthroughAnchorSyncPersistenceSummary {
  created: WalkthroughAnchorRegistryRecord[];
  refreshed: WalkthroughAnchorRegistryRecord[];
  markedMissing: WalkthroughAnchorRegistryRecord[];
  /**
   * Rows for the Sync review modal: every pending discovery touched this sync
   * (newly created or existing pending still present in the scan). Closing the
   * modal without save must not strand these — re-sync resurfaces them here.
   */
  reviewCandidates: WalkthroughAnchorRegistryRecord[];
  /**
   * Pending row IDs to queue for Track B AI smart-tagging: newly created rows
   * and pending rows that still have empty or heuristic-only metadata.
   * Already AI-enriched pending are reviewable but not re-queued on every sync.
   */
  newCandidateIdsForSmartTagging: string[];
}

/** Scan provider accepted by POST .../anchor-registry/sync. */
export type WalkthroughAnchorSyncProvider = 'local' | 'github' | 'ado';

export interface WalkthroughAnchorSyncCommand {
  provider?: WalkthroughAnchorSyncProvider;
  /** Absolute repository root for local scans (defaults to process.cwd()). */
  repositoryRoot?: string;
  /** Repo-relative client tree (default src/client). */
  clientRelativeRoot?: string;
  /**
   * Pre-fetched client sources for github | ado providers.
   * Required when provider is not `local`.
   */
  files?: ReadonlyArray<{ path: string; content: string }>;
}

/**
 * Full Super Admin sync response — extraction diff + persistence summary.
 * Track C (UI) consumes this for the Sync review modal.
 */
export interface WalkthroughAnchorSyncResult {
  discoveries: WalkthroughAnchorSyncDiscovery[];
  newCandidates: WalkthroughAnchorSyncDiscovery[];
  existingMatches: WalkthroughAnchorSyncDiscovery[];
  missingWarnings: WalkthroughAnchorSyncMissingWarning[];
  duplicates: WalkthroughAnchorSyncDuplicateGroup[];
  unsupportedDynamicPatterns: WalkthroughAnchorSyncUnsupportedPattern[];
  diagnostics: WalkthroughAnchorSyncDiagnostics;
  persistence: WalkthroughAnchorSyncPersistenceSummary;
}

export interface WalkthroughAnchorSyncDiscovery {
  testId: string;
  suggestedAnchorKey: string | null;
  sourceKind: Extract<WalkthroughAnchorSourceKind, 'explicit' | 'data_testid'>;
  sourceLocations: WalkthroughAnchorSourceLocation[];
  sourceHash: string;
  proposedReviewStatus: 'pending';
  proposedIsActive: false;
}

export interface WalkthroughAnchorSyncMissingWarning {
  testId: string;
  catalogEntry: WalkthroughAnchorCatalogSnapshotEntry;
}

export interface WalkthroughAnchorSyncDuplicateGroup {
  testId: string;
  locations: WalkthroughAnchorSourceLocation[];
}

export interface WalkthroughAnchorSyncUnsupportedPattern {
  filePath: string;
  line: number | null;
  snippet: string;
  reason: 'dynamic_template' | 'expression' | 'unresolved_anchor_key';
}

export interface WalkthroughAnchorSyncDiagnostics {
  provider: WalkthroughAnchorSyncProvider;
  rootPath: string;
  filesScanned: number;
  filesSkipped: number;
  bytesRead: number;
  durationMs: number;
  truncatedFiles: string[];
  errors: Array<{ filePath: string; message: string }>;
}

// ── Type guards / normalization ───────────────────────────────────────────────

export function isWalkthroughAnchorReviewStatus(
  value: unknown,
): value is WalkthroughAnchorReviewStatus {
  return (
    typeof value === 'string' &&
    (WALKTHROUGH_ANCHOR_REVIEW_STATUSES as readonly string[]).includes(value)
  );
}

export function isWalkthroughAnchorSourceKind(
  value: unknown,
): value is WalkthroughAnchorSourceKind {
  return (
    typeof value === 'string' &&
    (WALKTHROUGH_ANCHOR_SOURCE_KINDS as readonly string[]).includes(value)
  );
}

/** Lowercase + kebab-case normalize; drops empties; preserves order, dedupes. */
export function normalizeSmartTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    if (typeof raw !== 'string') continue;
    const normalized = raw.trim().toLowerCase().replace(/[\s_]+/g, '-');
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export function isValidSmartTag(tag: string): boolean {
  return WALKTHROUGH_ANCHOR_SMART_TAG_PATTERN.test(tag);
}

/** Runtime allow-list: approved + active + not soft-deleted. */
export function isRuntimeEligibleAnchor(
  record: Pick<
    WalkthroughAnchorRegistryRecord,
    'reviewStatus' | 'isActive' | 'deletedAt'
  >,
): boolean {
  return (
    record.reviewStatus === 'approved' &&
    record.isActive === true &&
    record.deletedAt == null
  );
}

/**
 * Validate catalog field shapes used by CRUD (Phase 2) and seed integrity.
 * Does not hit the database.
 */
export function validateAnchorRegistryCandidate(
  candidate: Partial<WalkthroughAnchorRegistryRecord>,
): WalkthroughAnchorRegistryValidationError[] {
  const errors: WalkthroughAnchorRegistryValidationError[] = [];

  if (!candidate.anchorKey?.trim()) {
    errors.push({
      field: 'anchorKey',
      code: 'INVALID_ANCHOR_KEY',
      message: 'anchorKey is required',
    });
  } else if (/[#.[\]>+~*=]|^\s*\/\//.test(candidate.anchorKey) || candidate.anchorKey.includes(' ')) {
    errors.push({
      field: 'anchorKey',
      code: 'INVALID_ANCHOR_KEY',
      message: 'anchorKey must be an exact registry key, not a CSS selector',
    });
  }

  if (!candidate.testId?.trim()) {
    errors.push({
      field: 'testId',
      code: 'INVALID_TEST_ID',
      message: 'testId is required',
    });
  } else if (/[#.[\]>+~*=]|^\s*\/\//.test(candidate.testId) || candidate.testId.includes(' ')) {
    errors.push({
      field: 'testId',
      code: 'INVALID_TEST_ID',
      message: 'testId must be an exact data-testid value, not a CSS selector',
    });
  }

  if (!candidate.label?.trim()) {
    errors.push({
      field: 'label',
      code: 'INVALID_LABEL',
      message: 'label is required',
    });
  }

  for (const [field, route] of [
    ['suggestedRoute', candidate.suggestedRoute],
    ['approvedRoute', candidate.approvedRoute],
  ] as const) {
    if (route == null || route === '') continue;
    if (!isWalkthroughRoute(route)) {
      errors.push({
        field,
        code: 'INVALID_ROUTE',
        message: `${field} must be a relative allow-listed in-app route`,
      });
    }
  }

  if (candidate.allowedPlacements !== undefined) {
    if (!Array.isArray(candidate.allowedPlacements) || candidate.allowedPlacements.length === 0) {
      errors.push({
        field: 'allowedPlacements',
        code: 'INVALID_PLACEMENTS',
        message: 'allowedPlacements must be a non-empty array',
      });
    } else {
      for (const p of candidate.allowedPlacements) {
        if (!(WALKTHROUGH_REGISTRY_PLACEMENTS as readonly string[]).includes(p)) {
          errors.push({
            field: 'allowedPlacements',
            code: 'INVALID_PLACEMENTS',
            message: `Unsupported placement: ${p}`,
          });
        }
      }
    }
  }

  if (candidate.smartTags !== undefined) {
    if (!Array.isArray(candidate.smartTags)) {
      errors.push({
        field: 'smartTags',
        code: 'INVALID_SMART_TAGS',
        message: 'smartTags must be a JSON array of strings',
      });
    } else {
      for (const tag of candidate.smartTags) {
        if (typeof tag !== 'string' || !isValidSmartTag(tag)) {
          errors.push({
            field: 'smartTags',
            code: 'INVALID_SMART_TAGS',
            message: `Invalid smart tag (lowercase kebab-case required): ${String(tag)}`,
          });
        }
      }
    }
  }

  if (
    candidate.sourceKind !== undefined &&
    !isWalkthroughAnchorSourceKind(candidate.sourceKind)
  ) {
    errors.push({
      field: 'sourceKind',
      code: 'INVALID_SOURCE_KIND',
      message: `sourceKind must be one of: ${WALKTHROUGH_ANCHOR_SOURCE_KINDS.join(', ')}`,
    });
  }

  if (candidate.sourceLocations !== undefined) {
    if (!Array.isArray(candidate.sourceLocations)) {
      errors.push({
        field: 'sourceLocations',
        code: 'INVALID_SOURCE_LOCATIONS',
        message: 'sourceLocations must be a JSON array',
      });
    } else {
      for (const loc of candidate.sourceLocations) {
        if (!loc || typeof loc.filePath !== 'string' || !loc.filePath.trim()) {
          errors.push({
            field: 'sourceLocations',
            code: 'INVALID_SOURCE_LOCATIONS',
            message: 'Each source location requires a filePath',
          });
          break;
        }
      }
    }
  }

  if (
    candidate.reviewStatus !== undefined &&
    !isWalkthroughAnchorReviewStatus(candidate.reviewStatus)
  ) {
    errors.push({
      field: 'reviewStatus',
      code: 'INVALID_REVIEW_STATUS',
      message: `reviewStatus must be one of: ${WALKTHROUGH_ANCHOR_REVIEW_STATUSES.join(', ')}`,
    });
  }

  if (
    candidate.isActive === true &&
    candidate.reviewStatus !== undefined &&
    candidate.reviewStatus !== 'approved'
  ) {
    errors.push({
      field: 'isActive',
      code: 'ACTIVE_REQUIRES_APPROVED',
      message: 'Only approved anchors may be active',
    });
  }

  return errors;
}

// ── Baseline seed (mirrors REGISTRY_ENTRIES) ──────────────────────────────────

/**
 * Deterministic Phase 1 seed for the seven curated registry entries.
 * Kept in sync with DOM markers in `src/shared/walkthroughAnchors.ts`.
 */
export const WALKTHROUGH_ANCHOR_REGISTRY_BASELINE_SEEDS: readonly WalkthroughAnchorRegistrySeed[] = [
  {
    anchorKey: 'user-menu-trigger',
    testId: 'user-menu-trigger',
    label: 'User menu',
    suggestedRoute: null,
    approvedRoute: '/home',
    allowedPlacements: ['bottom', 'left', 'right', 'top'],
    smartTags: ['user-menu', 'avatar', 'header', 'navigation', 'open', 'button'],
    sourceKind: 'explicit',
    sourceLocations: [
      {
        filePath: 'src/client/components/UserMenu.tsx',
        discoveryKind: 'explicit',
      },
    ],
    sourceHash: 'baseline:v1:user-menu-trigger',
    reviewStatus: 'approved',
    isActive: true,
    createdBy: 'system',
    updatedBy: 'system',
  },
  {
    anchorKey: 'whats-new-modal',
    testId: 'whats-new-modal',
    label: "What's New modal",
    suggestedRoute: null,
    approvedRoute: '/home',
    allowedPlacements: ['bottom', 'top', 'left', 'right'],
    smartTags: ['whats-new', 'changelog', 'modal', 'announcements', 'home'],
    sourceKind: 'explicit',
    sourceLocations: [
      {
        filePath: 'src/client/components/Changelog.tsx',
        discoveryKind: 'explicit',
      },
    ],
    sourceHash: 'baseline:v1:whats-new-modal',
    reviewStatus: 'approved',
    isActive: true,
    createdBy: 'system',
    updatedBy: 'system',
  },
  {
    anchorKey: 'user-menu-profile',
    testId: 'user-menu-profile',
    label: 'Profile menu item',
    suggestedRoute: null,
    approvedRoute: '/home',
    allowedPlacements: ['left', 'right', 'bottom', 'top'],
    smartTags: ['user-menu', 'profile', 'menu-item', 'navigation', 'settings'],
    sourceKind: 'explicit',
    sourceLocations: [
      {
        filePath: 'src/client/components/UserMenu.tsx',
        discoveryKind: 'explicit',
      },
    ],
    sourceHash: 'baseline:v1:user-menu-profile',
    reviewStatus: 'approved',
    isActive: true,
    createdBy: 'system',
    updatedBy: 'system',
  },
  {
    anchorKey: 'profile-identity',
    testId: 'profile-identity-section',
    label: 'Profile — Identity',
    suggestedRoute: null,
    approvedRoute: '/profile',
    allowedPlacements: ['bottom', 'top'],
    smartTags: ['profile', 'identity', 'avatar', 'settings', 'section'],
    sourceKind: 'explicit',
    sourceLocations: [
      {
        filePath: 'src/client/components/ProfilePage.tsx',
        discoveryKind: 'explicit',
      },
    ],
    sourceHash: 'baseline:v1:profile-identity',
    reviewStatus: 'approved',
    isActive: true,
    createdBy: 'system',
    updatedBy: 'system',
  },
  {
    anchorKey: 'profile-bio',
    testId: 'profile-bio-section',
    label: 'Profile — Bio',
    suggestedRoute: null,
    approvedRoute: '/profile',
    allowedPlacements: ['bottom', 'top'],
    smartTags: ['profile', 'bio', 'settings', 'section', 'edit'],
    sourceKind: 'explicit',
    sourceLocations: [
      {
        filePath: 'src/client/components/ProfilePage.tsx',
        discoveryKind: 'explicit',
      },
    ],
    sourceHash: 'baseline:v1:profile-bio',
    reviewStatus: 'approved',
    isActive: true,
    createdBy: 'system',
    updatedBy: 'system',
  },
  {
    anchorKey: 'profile-theme',
    testId: 'profile-theme-section',
    label: 'Profile — Theme',
    suggestedRoute: null,
    approvedRoute: '/profile',
    allowedPlacements: ['bottom', 'top'],
    smartTags: ['profile', 'theme', 'appearance', 'settings', 'section'],
    sourceKind: 'explicit',
    sourceLocations: [
      {
        filePath: 'src/client/components/ProfilePage.tsx',
        discoveryKind: 'explicit',
      },
    ],
    sourceHash: 'baseline:v1:profile-theme',
    reviewStatus: 'approved',
    isActive: true,
    createdBy: 'system',
    updatedBy: 'system',
  },
  {
    anchorKey: 'profile-notifications',
    testId: 'profile-notification-section',
    label: 'Profile — Notifications',
    suggestedRoute: null,
    approvedRoute: '/profile',
    allowedPlacements: ['top', 'bottom'],
    smartTags: ['profile', 'notifications', 'preferences', 'settings', 'section'],
    sourceKind: 'explicit',
    sourceLocations: [
      {
        filePath: 'src/client/components/ProfilePage.tsx',
        discoveryKind: 'explicit',
      },
    ],
    sourceHash: 'baseline:v1:profile-notifications',
    reviewStatus: 'approved',
    isActive: true,
    createdBy: 'system',
    updatedBy: 'system',
  },
];
