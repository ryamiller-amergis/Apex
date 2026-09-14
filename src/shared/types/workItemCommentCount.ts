export interface WorkItemCommentCountResponse {
  /** Positive integer when ADO reports comments; null when zero or unavailable. */
  count: number | null;
}

export type CommentCountResultStatus = 'success' | 'unavailable';

export interface CommentCountResult {
  status: CommentCountResultStatus;
  /** Positive integer when status is success; null otherwise. */
  count: number | null;
}
