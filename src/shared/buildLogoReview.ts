/**
 * Logo options are reviewed before they become a Build revision.
 * A request matches only when it asks to see a logo before implementation.
 */
export type BuildLogoBatchStatus = 'running' | 'ready' | 'failed';
export type BuildLogoCandidateStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'superseded'
  | 'failed';

export interface BuildLogoCandidateView {
  id: string;
  status: BuildLogoCandidateStatus;
}

export interface BuildLogoReviewView {
  batchId: string;
  status: BuildLogoBatchStatus;
  prompt: string;
  failureMessage: string | null;
  candidates: BuildLogoCandidateView[];
  approvedCandidateId: string | null;
}

const LOGO_WORD = /\blogos?\b/i;
const REVIEW_BEFORE_IMPLEMENTATION =
  /\b(review|before|concept|concepts|options|mock|mocks)\b|\bif (?:i|it|you) like|\bif it looks|\bthen we can\b/i;

export function isLogoReviewRequest(feedback: string): boolean {
  const text = feedback.trim();
  return LOGO_WORD.test(text) && REVIEW_BEFORE_IMPLEMENTATION.test(text);
}

export function approvedLogoImplementationPrompt(): string {
  return 'Place the approved logo from /brand/logo.png in the top navigation bar. Preserve the existing navigation behavior and change only the branding presentation.';
}

export function isApprovedLogoImplementationRequest(feedback: string): boolean {
  return (
    /\bapproved logo\b/i.test(feedback) || feedback.includes('/brand/logo.png')
  );
}
