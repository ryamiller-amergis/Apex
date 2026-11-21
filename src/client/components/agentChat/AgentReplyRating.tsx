import React, { useCallback, useState } from 'react';
import type { ChatMessageRating as Rating } from '../../../shared/types/workflowMessageFeedback';
import { ChatMessageRating } from '../ChatMessageRating';

export interface AgentReplyRatingProps {
  messageId: string;
  rating: Rating | null;
  comment?: string | null;
  pending?: boolean;
  error?: string | null;
  canWrite?: boolean;
  hasAccess?: boolean;
  onSave: (rating: Rating | null, comment: string | null) => Promise<unknown>;
  className?: string;
}

export const AgentReplyRating: React.FC<AgentReplyRatingProps> = ({
  messageId,
  rating,
  comment = null,
  pending = false,
  error = null,
  canWrite = true,
  hasAccess = true,
  onSave,
  className,
}) => {
  const [prevProps, setPrevProps] = useState({ rating, comment });
  const [selectedRating, setSelectedRating] = useState<Rating | null>(rating);
  const [selectedComment, setSelectedComment] = useState<string | null>(comment);
  const [isSaving, setIsSaving] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  if (prevProps.rating !== rating || prevProps.comment !== comment) {
    setPrevProps({ rating, comment });
    setSelectedRating(rating);
    setSelectedComment(comment);
  }

  const handleSave = useCallback(
    async (nextRating: Rating | null, nextComment: string | null): Promise<unknown> => {
      if (!canWrite) return Promise.resolve();
      const previousRating = selectedRating;
      const previousComment = selectedComment;
      setSelectedRating(nextRating);
      setSelectedComment(nextComment);
      setLocalError(null);
      setIsSaving(true);
      try {
        return await onSave(nextRating, nextComment);
      } catch (err) {
        setSelectedRating(previousRating);
        setSelectedComment(previousComment);
        const message = err instanceof Error && err.message
          ? err.message
          : 'Could not save rating.';
        setLocalError(message);
        throw err;
      } finally {
        setIsSaving(false);
      }
    },
    [canWrite, onSave, selectedComment, selectedRating],
  );

  if (!hasAccess) return null;

  const effectiveError = error ?? localError;
  const controlsDisabled = Boolean(pending || isSaving || !canWrite);

  return (
    <div className={className}>
      <ChatMessageRating
        messageId={messageId}
        rating={selectedRating}
        comment={selectedComment}
        pending={controlsDisabled}
        error={effectiveError}
        onSave={handleSave}
      />
    </div>
  );
};
