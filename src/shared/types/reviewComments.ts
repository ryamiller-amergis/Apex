export interface TextSelector {
  exact: string;
  prefix: string;
  suffix: string;
  start: number;
  end: number;
}

export type ReviewCommentStatus = 'open' | 'resolved';
export type ReviewDocumentType = 'prd' | 'design_doc' | 'adr';
export type ReviewSectionKey = 'prd' | 'design' | 'tech_spec' | 'assumptions' | 'backlog' | 'adr';

export interface ReviewComment {
  id: string;
  documentId: string;
  documentType: ReviewDocumentType;
  sectionKey: ReviewSectionKey;
  authorUserId: string;
  authorDisplayName?: string;
  body: string;
  selector: TextSelector;
  status: ReviewCommentStatus;
  resolvedBy?: string | null;
  resolvedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReviewReply {
  id: string;
  commentId: string;
  authorUserId: string;
  authorDisplayName?: string;
  body: string;
  createdAt: string;
}

export interface ReviewCommentWithReplies extends ReviewComment {
  replies: ReviewReply[];
}

export interface CreateReviewCommentRequest {
  sectionKey: ReviewSectionKey;
  body: string;
  selector: TextSelector;
}

export interface CreateReviewReplyRequest {
  body: string;
}
