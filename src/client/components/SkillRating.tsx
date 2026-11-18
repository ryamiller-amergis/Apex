import React from 'react';
import { ChatMessageRating } from './ChatMessageRating';
import { useWorkflowEvaluationAccess } from '../hooks/useWorkflowEvaluationAccess';
import { usePutSkillRating, useSkillRatings } from '../hooks/useSkillRatings';
import type { SkillRatingSurface } from '../../shared/types/skillRating';

export interface SkillRatingProps {
  project: string | undefined;
  surface: SkillRatingSurface;
  subjectType: string;
  subjectId: string;
  /** Chat thread that produced the output, when there is one. */
  threadId?: string | null;
}

/** Optional "How did the agent do?" rating for one AI output. Renders nothing without Skill Learning access. */
export const SkillRating: React.FC<SkillRatingProps> = ({ project, surface, subjectType, subjectId, threadId = null }) => {
  // @feature-flag:skill-learning
  const access = useWorkflowEvaluationAccess(project);
  const ratings = useSkillRatings({ project, surface, subjectIds: [subjectId], enabled: access.canSubmit });
  const put = usePutSkillRating({ project, surface });
  if (!access.canSubmit || !subjectId) return null;
  const entry = ratings.get(subjectId);

  return (
    <ChatMessageRating
      messageId={`${surface}-${subjectId}`}
      rating={entry?.rating ?? null}
      comment={entry?.comment ?? null}
      pending={put.isPending}
      error={put.isError ? put.error.message : null}
      onSave={(rating, comment) => put.mutateAsync({ subjectType, subjectId, threadId, rating, comment })}
    />
  );
};
