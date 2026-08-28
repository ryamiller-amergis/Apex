export type ApprovalMode = 'any_one' | 'all_required';

/**
 * Document modules that carry a configurable reviewer pool and approval mode.
 * Single source of truth for the reviewer `documentType` union — project
 * settings, approver pools, and approval assignments all key off this set.
 */
export type ReviewerDocumentType =
  | 'prd'
  | 'design_doc'
  | 'design_prototype'
  | 'test_case'
  | 'adr';

/**
 * Approval mode per reviewer module. Each module's mode is independent; a
 * complete map always resolves a mode for every module.
 */
export type ModuleApprovalModes = Record<ReviewerDocumentType, ApprovalMode>;

export type ApproverResponseStatus = 'pending' | 'approved' | 'revision_requested';

export interface DocumentApproverAssignment {
  id: string;
  documentId: string;
  documentType: ReviewerDocumentType;
  approverUserId: string;
  approverDisplayName?: string;
  status: ApproverResponseStatus;
  comment?: string | null;
  respondedAt?: string | null;
  assignedAt: string;
  assignedBy: string;
}

export interface SubmitForReviewRequest {
  prdApproverIds: string[];
  designDocApproverIds: string[];
  designPrototypeApproverIds: string[];
  qaApproverIds: string[];
}

export interface SubmitDesignDocForReviewRequest {
  approverIds: string[];
}

export interface ApprovalCompletionResult {
  complete: boolean;
  mode: ApprovalMode;
  /**
   * Present only when completion was reached without any reviewer assignment —
   * the owner is the sole approver for that module.
   */
  reason?: 'owner-only';
}

// ── Reviewer availability ─────────────────────────────────────────────────────

/**
 * Whether a reviewer module has at least one selectable candidate right now.
 * `candidateCount` is the number of unique people in the configured pool
 * (individuals plus current group members), so a configured group with no
 * current members contributes nothing.
 */
export interface ReviewerAvailability {
  documentType: ReviewerDocumentType;
  available: boolean;
  candidateCount: number;
}

export interface ReviewerAvailabilityResponse {
  project: string;
  /** Same order as the requested module list. */
  modules: ReviewerAvailability[];
}

// ── Owner Approval (two-stage) ────────────────────────────────────────────────

export type OwnerApprovalStatus = 'pending' | 'approved' | 'revision_requested';

export type OwnerApprovalDocumentType = 'prd' | 'test_case' | 'design_prototype' | 'design_doc' | 'adr';

export interface DocumentOwnerApproval {
  id: string;
  documentId: string;
  documentType: OwnerApprovalDocumentType;
  ownerUserId: string | null;
  status: OwnerApprovalStatus;
  comment: string | null;
  respondedAt: string | null;
  createdAt: string;
}

export interface OwnerApproveRequest {
  status: 'approved' | 'revision_requested';
  comment?: string;
  /** For design_prototype type: the specific prototype to approve. Required when type is design_prototype. */
  prototypeId?: string;
}
