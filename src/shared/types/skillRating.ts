import type { ChatMessageRating } from './workflowMessageFeedback';

/** Surfaces with an optional rating control. Home chat and interviews keep their own reply feedback. */
export const SKILL_RATING_SURFACES = [
  'adr',
  'adr_assistant',
  'prd_assistant',
  'design_doc_assistant',
  'brainstorm',
  'qa_lab',
  'playbook',
  'build_intake',
] as const;
export type SkillRatingSurface = (typeof SKILL_RATING_SURFACES)[number];

export interface PutSkillRatingRequest {
  surface: SkillRatingSurface;
  /** What is rated, e.g. `assistant_reply`, `brainstorm_artifact`, `playbook_run`. */
  subjectType: string;
  subjectId: string;
  /** Chat thread that produced the output; its Skill, model and effort are recorded with the rating. */
  threadId: string | null;
  /** Null clears the rating. */
  rating: ChatMessageRating | null;
  comment: string | null;
}

export interface SkillRatingEntry {
  subjectId: string;
  rating: ChatMessageRating;
  comment: string | null;
}
