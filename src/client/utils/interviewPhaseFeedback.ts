import type { ListWorkflowEvaluationEventsResponse } from '../../shared/types/workflowEvaluation';
import type { InterviewPhaseId } from './interviewPhaseProgress';

export type InterviewFeedbackPhase = 1 | 2 | 3;

export const INTERVIEW_FEEDBACK_PHASE_LABEL: Record<InterviewFeedbackPhase, string> = {
  1: 'Discovery',
  2: 'Delivery',
  3: 'Technical',
};

const PHASE_ID: Record<InterviewFeedbackPhase, InterviewPhaseId> = {
  1: 'discovery',
  2: 'delivery',
  3: 'technical',
};

export function interviewPhaseStageKey(phase: InterviewFeedbackPhase): string {
  return `interview_phase_${phase}`;
}

/**
 * True when this user has given feedback on the version of the phase on screen.
 * When the server cannot fingerprint the phase, any feedback from the user counts.
 */
export function hasCurrentFeedbackFrom(
  response: ListWorkflowEvaluationEventsResponse,
  userId: string,
): boolean {
  const { currentArtifactHash } = response;
  return response.events.some((event) =>
    event.reviewerUserId === userId
    && (currentArtifactHash == null || event.artifactContentHash === currentArtifactHash));
}

export interface InterviewFeedbackGateInput {
  startedPhases: ReadonlySet<InterviewPhaseId>;
  deliveryComplete: boolean;
  /** Discovery assignee, else the interview author. Rates Discovery and Delivery. */
  baUserId: string;
  /** Technical assignee, else the interview author. Rates Technical. */
  technicalUserId: string;
  /** `undefined` while loading or after a failed lookup; an unknown phase does not block. */
  feedback: Record<InterviewFeedbackPhase, ListWorkflowEvaluationEventsResponse | undefined>;
}

export interface InterviewFeedbackGate {
  baPhasesMissing: InterviewFeedbackPhase[];
  technicalMissing: boolean;
  /** Delivery is done and the BA has not rated Discovery and Delivery. */
  chatLockedForBa: boolean;
  completeBlocked: boolean;
}

function missing(
  input: InterviewFeedbackGateInput,
  phase: InterviewFeedbackPhase,
  userId: string,
): boolean {
  if (!input.startedPhases.has(PHASE_ID[phase])) return false;
  const response = input.feedback[phase];
  return response !== undefined && !hasCurrentFeedbackFrom(response, userId);
}

export function interviewFeedbackGate(input: InterviewFeedbackGateInput): InterviewFeedbackGate {
  const baPhasesMissing = ([1, 2] as const).filter((phase) => missing(input, phase, input.baUserId));
  const technicalMissing = missing(input, 3, input.technicalUserId);
  return {
    baPhasesMissing,
    technicalMissing,
    chatLockedForBa: input.deliveryComplete && baPhasesMissing.length > 0,
    completeBlocked: baPhasesMissing.length > 0 || technicalMissing,
  };
}
