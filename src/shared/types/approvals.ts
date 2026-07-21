export type ApprovalMode = 'any_one' | 'all_required';

export type ApproverResponseStatus = 'pending' | 'approved' | 'revision_requested';

export interface DocumentApproverAssignment {
  id: string;
  documentId: string;
  documentType: 'prd' | 'design_doc' | 'design_prototype' | 'test_case' | 'adr';
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
