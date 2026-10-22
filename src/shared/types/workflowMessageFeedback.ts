/**
 * Light per-message feedback on agent replies. Interviews take thumbs up or
 * down per question; home chat takes a three-level rating with a comment.
 */

export const WORKFLOW_MESSAGE_FEEDBACK_SURFACES = ['interview', 'chat'] as const;
export type WorkflowMessageFeedbackSurface = (typeof WORKFLOW_MESSAGE_FEEDBACK_SURFACES)[number];

export const INTERVIEW_MESSAGE_RATINGS = ['up', 'down'] as const;
export type InterviewMessageRating = (typeof INTERVIEW_MESSAGE_RATINGS)[number];

export const CHAT_MESSAGE_RATINGS = ['good', 'needs_improvement', 'bad'] as const;
export type ChatMessageRating = (typeof CHAT_MESSAGE_RATINGS)[number];

export type WorkflowMessageRating = InterviewMessageRating | ChatMessageRating;

export const WORKFLOW_MESSAGE_FEEDBACK_COMMENT_MAX_LENGTH = 2000;

export const CHAT_MESSAGE_RATING_LABELS: Record<ChatMessageRating, string> = {
  good: 'Good',
  needs_improvement: 'Needs improvement',
  bad: 'Bad',
};

/** Bad and Needs improvement need a comment; Good does not. */
export function chatRatingNeedsComment(rating: WorkflowMessageRating): boolean {
  return rating === 'bad' || rating === 'needs_improvement';
}

export interface WorkflowMessageFeedbackEntry {
  messageId: string;
  rating: WorkflowMessageRating;
  comment: string | null;
  updatedAt: string;
}

/** The caller's own ratings for one interview or chat thread. */
export interface ListWorkflowMessageFeedbackResponse {
  surface: WorkflowMessageFeedbackSurface;
  subjectId: string;
  entries: WorkflowMessageFeedbackEntry[];
}

/** `rating: null` clears the caller's rating for the message. */
export interface PutWorkflowMessageFeedbackRequest {
  surface: WorkflowMessageFeedbackSurface;
  subjectId: string;
  rating: WorkflowMessageRating | null;
  comment?: string | null;
}

export interface PutWorkflowMessageFeedbackResponse {
  entry: WorkflowMessageFeedbackEntry | null;
}

export const MESSAGE_RATING_SUMMARY_DAYS = [7, 30, 90] as const;
export type MessageRatingSummaryDays = (typeof MESSAGE_RATING_SUMMARY_DAYS)[number];

export interface DownvotedInterviewQuestion {
  interviewId: string;
  interviewTitle: string;
  messageId: string;
  excerpt: string;
  up: number;
  down: number;
}

export interface ChatRatingComment {
  threadId: string;
  threadTitle: string | null;
  messageId: string;
  excerpt: string;
  rating: ChatMessageRating;
  comment: string;
  reviewerName: string | null;
  updatedAt: string;
}

/** Admin view of per-message ratings in one project over the last `days` days. */
export interface MessageRatingSummary {
  days: MessageRatingSummaryDays;
  interview: Record<InterviewMessageRating, number>;
  chat: Record<ChatMessageRating, number>;
  downvotedQuestions: DownvotedInterviewQuestion[];
  chatComments: ChatRatingComment[];
}
