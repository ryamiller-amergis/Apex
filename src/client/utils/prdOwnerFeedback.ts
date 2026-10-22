import {
  WORKFLOW_EVALUATION_PRD_OWNER_ROLE,
  type ListWorkflowEvaluationEventsResponse,
} from '../../shared/types/workflowEvaluation';

/**
 * True when this user has given feedback as PRD owner on the version on screen.
 * When the server cannot fingerprint the PRD, any owner feedback from the user counts.
 */
export function hasCurrentOwnerFeedback(
  response: ListWorkflowEvaluationEventsResponse | undefined,
  userId: string | null | undefined,
): boolean {
  if (!response || !userId) return false;
  const { currentArtifactHash } = response;
  return response.events.some((event) =>
    event.reviewerUserId === userId
    && event.reviewerRoleKey === WORKFLOW_EVALUATION_PRD_OWNER_ROLE.key
    && (currentArtifactHash == null || event.artifactContentHash === currentArtifactHash));
}
