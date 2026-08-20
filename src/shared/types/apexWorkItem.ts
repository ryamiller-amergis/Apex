// ── Status & type unions ─────────────────────────────────────────────────────

export type ApexWorkItemStatus = 'idea' | 'ready' | 'in-progress' | 'review' | 'done';
export type ApexWorkItemType = 'Epic' | 'Feature' | 'PBI' | 'TBI' | 'Bug';
export type ApexWorkItemSourceType = 'prd' | 'feature_request' | 'standalone';
export type ApexWorkItemEventAction =
  | 'created'
  | 'updated'
  | 'moved'
  | 'assigned'
  | 'collaborators_updated'
  | 'ac_toggled'
  | 'linked'
  | 'unlinked'
  | 'commented'
  | 'attachment_added'
  | 'attachment_removed'
  | 'release_set'
  | 'mentioned';

export type ApexReleaseStatus = 'planned' | 'active' | 'shipped' | 'cancelled';
export type ApexWorkItemLinkType = 'predecessor' | 'related' | 'blocks';

export const APEX_WORK_ITEM_STATUSES: ApexWorkItemStatus[] = [
  'idea',
  'ready',
  'in-progress',
  'review',
  'done',
];

export const APEX_WORK_ITEM_TYPES: ApexWorkItemType[] = ['Epic', 'Feature', 'PBI', 'TBI', 'Bug'];

export const APEX_BOARD_CARD_TYPES: ApexWorkItemType[] = ['PBI', 'TBI', 'Bug'];

// ── Status metadata (icons / labels used on the board) ───────────────────────

export interface ApexWorkItemStatusMeta {
  value: ApexWorkItemStatus;
  label: string;
  tokenVar: string;
}

export const STATUS_META: Record<ApexWorkItemStatus, ApexWorkItemStatusMeta> = {
  idea:          { value: 'idea',         label: 'Idea',        tokenVar: '--status-idea' },
  ready:         { value: 'ready',        label: 'Ready',       tokenVar: '--status-ready' },
  'in-progress': { value: 'in-progress',  label: 'In Progress', tokenVar: '--status-in-progress' },
  review:        { value: 'review',       label: 'Review',      tokenVar: '--status-review' },
  done:          { value: 'done',         label: 'Completed',   tokenVar: '--status-done' },
};

// ── Acceptance criterion ─────────────────────────────────────────────────────

export interface AcceptanceCriterion {
  id: string;
  text: string;
  done: boolean;
}

// ── Owner summary ────────────────────────────────────────────────────────────

export interface WorkItemOwnerSummary {
  oid: string;
  displayName: string;
  email: string;
}

// ── Release ──────────────────────────────────────────────────────────────────

export interface ApexRelease {
  id: string;
  project: string;
  name: string;
  version: string | null;
  targetDate: string | null;
  status: ApexReleaseStatus;
  position: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  /** Populated when listing with progress */
  itemCount?: number;
  doneCount?: number;
}

export interface CreateApexReleaseDTO {
  name: string;
  version?: string | null;
  targetDate?: string | null;
  status?: ApexReleaseStatus;
}

export interface UpdateApexReleaseDTO {
  name?: string;
  version?: string | null;
  targetDate?: string | null;
  status?: ApexReleaseStatus;
  position?: number;
}

// ── Activity event ───────────────────────────────────────────────────────────

export interface ApexWorkItemEvent {
  id: string;
  workItemId: string;
  actorId: string;
  actorName: string;
  action: ApexWorkItemEventAction;
  fromStatus?: ApexWorkItemStatus;
  toStatus?: ApexWorkItemStatus;
  details: Record<string, unknown>;
  createdAt: string;
}

// ── Comment / attachment ─────────────────────────────────────────────────────

export interface ApexWorkItemComment {
  id: string;
  workItemId: string;
  project: string;
  author: WorkItemOwnerSummary;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApexWorkItemAttachment {
  id: string;
  workItemId: string;
  project: string;
  fileName: string;
  contentType: string;
  byteSize: number;
  storagePath: string;
  uploadedBy: WorkItemOwnerSummary;
  createdAt: string;
  /**
   * Client-facing URL that opens the attachment (content API for stored files,
   * or the external URL for linked http(s) attachments).
   */
  openUrl?: string;
}

/** Lightweight hierarchy node for parent/children in the detail drawer. */
export interface ApexWorkItemHierarchyNode {
  id: string;
  itemNumber: number;
  title: string;
  type: ApexWorkItemType;
  status: ApexWorkItemStatus;
}

// ── Core entity ─────────────────────────────────────────────────────────────

export interface ApexWorkItem {
  id: string;
  project: string;
  itemNumber: number;
  title: string;
  outcome: string;
  type: ApexWorkItemType;
  status: ApexWorkItemStatus;
  owner: WorkItemOwnerSummary;
  collaborators: WorkItemOwnerSummary[];
  acceptanceCriteria: AcceptanceCriterion[];
  branch: string | null;
  prUrl: string | null;
  position: number;
  dueDate: string | null;
  releaseId: string | null;
  release?: ApexRelease | null;
  parentId: string | null;
  sourceType: ApexWorkItemSourceType;
  /** PRD provenance (Process 1) */
  prdId: string | null;
  backlogItemId: string | null;
  /** Feature Request provenance (both processes) */
  featureRequestId: string | null;
  /** Azure DevOps provenance when imported / linked */
  adoWorkItemId: number | null;
  /** Hierarchy breadcrumb from PRD backlog */
  epicId: string | null;
  epicTitle: string | null;
  featureId: string | null;
  featureTitle: string | null;
  /** Design artifacts (same set ADO attaches on Features) */
  designDocId: string | null;
  designPrototypeId: string | null;
  /** Audit */
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  /** Populated on get-by-id */
  events?: ApexWorkItemEvent[];
  comments?: ApexWorkItemComment[];
  attachments?: ApexWorkItemAttachment[];
  /** Populated on get-by-id — Apex deep links for FR / PRD / plan / prototypes / design doc */
  documentLinks?: ApexWorkItemDocumentLink[];
  /** Populated on get-by-id */
  parent?: ApexWorkItemHierarchyNode | null;
  children?: ApexWorkItemHierarchyNode[];
}

export type ApexWorkItemDocumentLinkKind =
  | 'feature_request'
  | 'prd'
  | 'design_plan'
  | 'design_prototypes'
  | 'design_doc';

export interface ApexWorkItemDocumentLink {
  kind: ApexWorkItemDocumentLinkKind;
  label: string;
  /** In-app path (navigate with react-router) */
  path: string;
  available: boolean;
}

// ── DTOs ─────────────────────────────────────────────────────────────────────

export interface CreateApexWorkItemDTO {
  project: string;
  title: string;
  outcome: string;
  type: ApexWorkItemType;
  status?: ApexWorkItemStatus;
  ownerId: string;
  collaboratorIds?: string[];
  acceptanceCriteria?: Omit<AcceptanceCriterion, 'id'>[];
  branch?: string;
  prUrl?: string;
  dueDate?: string | null;
  releaseId?: string | null;
  parentId?: string | null;
  sourceType?: ApexWorkItemSourceType;
  prdId?: string;
  backlogItemId?: string;
  featureRequestId?: string;
  epicId?: string;
  epicTitle?: string;
  featureId?: string;
  featureTitle?: string;
  designDocId?: string;
  designPrototypeId?: string;
}

export interface UpdateApexWorkItemDTO {
  title?: string;
  outcome?: string;
  type?: ApexWorkItemType;
  ownerId?: string;
  collaboratorIds?: string[];
  acceptanceCriteria?: AcceptanceCriterion[];
  branch?: string | null;
  prUrl?: string | null;
  dueDate?: string | null;
  releaseId?: string | null;
  parentId?: string | null;
}

export interface MoveApexWorkItemDTO {
  targetStatus: ApexWorkItemStatus;
  targetPosition?: number;
}

export interface MaterializeFromPrdDTO {
  project: string;
  prdId: string;
  backlogItemIds: string[];
  ownerId: string;
  /**
   * Per-leaf reconcile choice. Omitted leaves use the preview default.
   * - work item id → link/update that board card
   * - 'create' → always create a new card
   * - 'skip' → do nothing for this leaf
   */
  linkChoices?: Record<string, string | 'create' | 'skip'>;
}

export type MaterializeLeafAction = 'skip' | 'link' | 'create' | 'choose';

export interface MaterializeCandidate {
  id: string;
  itemNumber: number;
  title: string;
  type: ApexWorkItemType;
  status: ApexWorkItemStatus;
  sourceType: ApexWorkItemSourceType;
}

export interface MaterializePlanLeaf {
  backlogItemId: string;
  title: string;
  type: ApexWorkItemType;
  action: MaterializeLeafAction;
  /** Default target when action is link (or suggested when choose). */
  suggestedWorkItemId: string | null;
  candidates: MaterializeCandidate[];
  epicTitle?: string | null;
  featureTitle?: string | null;
}

export interface MaterializePreviewResult {
  featureRequestId: string | null;
  leaves: MaterializePlanLeaf[];
  counts: { skip: number; link: number; create: number; choose: number };
}

export interface MaterializeResult {
  created: ApexWorkItem[];
  linked: ApexWorkItem[];
  skipped: number;
}

export interface GenerateFromFeatureRequestDTO {
  project: string;
  featureRequestId: string;
  ownerId: string;
  collaboratorIds?: string[];
  grain: 'single' | 'small-set';
}

export interface CreateFromDraftsDTO {
  project: string;
  featureRequestId: string;
  ownerId: string;
  collaboratorIds?: string[];
  /** Drafts may carry a client `id` used for reconcile choices. */
  drafts: Array<CreateApexWorkItemDTO & { id?: string }>;
  /**
   * Per-draft reconcile when a board card already exists for this FR.
   * Keyed by draft.id. Default: skip create when a single exact match exists.
   */
  linkChoices?: Record<string, string | 'create' | 'skip'>;
}

export interface DraftReconcileCandidate {
  id: string;
  itemNumber: number;
  title: string;
  type: ApexWorkItemType;
  status: ApexWorkItemStatus;
  sourceType: ApexWorkItemSourceType;
  backlogItemId: string | null;
}

export interface DraftReconcilePlanItem {
  draftId: string;
  title: string;
  type: ApexWorkItemType;
  action: MaterializeLeafAction;
  suggestedWorkItemId: string | null;
  candidates: DraftReconcileCandidate[];
}

export interface DraftReconcilePreviewResult {
  items: DraftReconcilePlanItem[];
  counts: { skip: number; link: number; create: number; choose: number };
}

export interface CreateFromDraftsResult {
  created: ApexWorkItem[];
  linked: ApexWorkItem[];
  skipped: number;
}

export interface BulkUpdateApexWorkItemsDTO {
  ids: string[];
  targetStatus?: ApexWorkItemStatus;
  ownerId?: string;
  releaseId?: string | null;
}

// ── Filters ──────────────────────────────────────────────────────────────────

export interface ApexWorkItemFilters {
  project: string;
  ownerId?: string | 'all';
  types?: ApexWorkItemType[];
  epicTitle?: string;
  featureTitle?: string;
  sourceType?: ApexWorkItemSourceType | 'all';
  releaseId?: string | 'none' | 'all';
  parentId?: string | 'root' | 'all';
  search?: string;
}

// ── Filter facets ────────────────────────────────────────────────────────────

export interface ApexWorkItemFacets {
  epicTitles: string[];
  featureTitles: string[];
  owners: WorkItemOwnerSummary[];
  releases: ApexRelease[];
}

// ── Draft (Process 2) ────────────────────────────────────────────────────────

export interface ApexWorkItemDraft {
  id: string;
  title: string;
  outcome: string;
  type: ApexWorkItemType;
  acceptanceCriteria: Omit<AcceptanceCriterion, 'id'>[];
}

// ── Board lens ───────────────────────────────────────────────────────────────

export type ApexBoardLens = 'status' | 'release';

// ── Deployments (board-native) ───────────────────────────────────────────────

export type ApexDeploymentEnvironment = 'dev' | 'staging' | 'prod';

export interface ApexDeployment {
  id: string;
  project: string;
  releaseId: string | null;
  environment: ApexDeploymentEnvironment;
  version: string;
  deployedAt: string;
  deployedBy: string | null;
  notes: string | null;
  workItemIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface RecordApexDeploymentDTO {
  environment: ApexDeploymentEnvironment;
  version: string;
  releaseId?: string | null;
  notes?: string | null;
  workItemIds?: string[];
  deployedAt?: string;
}

export interface BoardEventStatRow {
  action: ApexWorkItemEventAction | string;
  count: number;
}
