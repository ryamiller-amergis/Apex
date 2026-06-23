export type ApprovalMode = 'any_one' | 'all_required';

export type ApproverResponseStatus = 'pending' | 'approved' | 'revision_requested';

export interface DocumentApproverAssignment {
  id: string;
  documentId: string;
  documentType: 'prd' | 'design_doc' | 'design_prototype';
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
}

export interface SubmitDesignDocForReviewRequest {
  approverIds: string[];
}

export interface ApprovalCompletionResult {
  complete: boolean;
  mode: ApprovalMode;
}
