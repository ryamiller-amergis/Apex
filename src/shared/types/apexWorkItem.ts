// ── Status & type unions ─────────────────────────────────────────────────────

export type ApexWorkItemStatus = 'idea' | 'ready' | 'in-progress' | 'review' | 'done';
export type ApexWorkItemType = 'PBI' | 'TBI' | 'Bug';
export type ApexWorkItemSourceType = 'prd' | 'feature_request' | 'standalone';
export type ApexWorkItemEventAction = 'created' | 'updated' | 'moved' | 'assigned' | 'collaborators_updated' | 'ac_toggled' | 'linked' | 'unlinked';

export const APEX_WORK_ITEM_STATUSES: ApexWorkItemStatus[] = [
  'idea',
  'ready',
  'in-progress',
  'review',
  'done',
];

export const APEX_WORK_ITEM_TYPES: ApexWorkItemType[] = ['PBI', 'TBI', 'Bug'];

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

// ── Core entity ─────────────────────────────────────────────────────────────

export interface ApexWorkItem {
  id: string;
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
  sourceType: ApexWorkItemSourceType;
  /** PRD provenance (Process 1) */
  prdId: string | null;
  backlogItemId: string | null;
  /** Feature Request provenance (both processes) */
  featureRequestId: string | null;
  /** Hierarchy breadcrumb from PRD backlog */
  epicId: string | null;
  epicTitle: string | null;
  featureId: string | null;
  featureTitle: string | null;
  /** Audit */
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  /** Populated on get-by-id */
  events?: ApexWorkItemEvent[];
}

// ── DTOs ─────────────────────────────────────────────────────────────────────

export interface CreateApexWorkItemDTO {
  title: string;
  outcome: string;
  type: ApexWorkItemType;
  status?: ApexWorkItemStatus;
  ownerId: string;
  collaboratorIds?: string[];
  acceptanceCriteria?: Omit<AcceptanceCriterion, 'id'>[];
  branch?: string;
  prUrl?: string;
  sourceType?: ApexWorkItemSourceType;
  prdId?: string;
  backlogItemId?: string;
  featureRequestId?: string;
  epicId?: string;
  epicTitle?: string;
  featureId?: string;
  featureTitle?: string;
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
}

export interface MoveApexWorkItemDTO {
  targetStatus: ApexWorkItemStatus;
  targetPosition?: number;
}

export interface MaterializeFromPrdDTO {
  prdId: string;
  backlogItemIds: string[];
  ownerId: string;
}

export interface GenerateFromFeatureRequestDTO {
  featureRequestId: string;
  ownerId: string;
  collaboratorIds?: string[];
  grain: 'single' | 'small-set';
}

export interface CreateFromDraftsDTO {
  featureRequestId: string;
  ownerId: string;
  collaboratorIds?: string[];
  drafts: CreateApexWorkItemDTO[];
}

// ── Filters ──────────────────────────────────────────────────────────────────

export interface ApexWorkItemFilters {
  ownerId?: string | 'all';
  types?: ApexWorkItemType[];
  epicTitle?: string;
  featureTitle?: string;
  sourceType?: ApexWorkItemSourceType | 'all';
  search?: string;
}

// ── Filter facets ────────────────────────────────────────────────────────────

export interface ApexWorkItemFacets {
  epicTitles: string[];
  featureTitles: string[];
  owners: WorkItemOwnerSummary[];
}

// ── Draft (Process 2) ────────────────────────────────────────────────────────

export interface ApexWorkItemDraft {
  id: string;
  title: string;
  outcome: string;
  type: ApexWorkItemType;
  acceptanceCriteria: Omit<AcceptanceCriterion, 'id'>[];
}
