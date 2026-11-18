import React, { useState } from 'react';
import {
  CHAT_MESSAGE_RATINGS,
  CHAT_MESSAGE_RATING_LABELS,
  WORKFLOW_MESSAGE_FEEDBACK_COMMENT_MAX_LENGTH,
  chatRatingNeedsComment,
  type ChatMessageRating as Rating,
} from '../../shared/types/workflowMessageFeedback';
import styles from './ChatMessageRating.module.css';

export interface ChatMessageRatingProps {
  messageId: string;
  rating: Rating | null;
  comment: string | null;
  pending: boolean;
  error: string | null;
  /** Resolves when saved; the comment box stays open if it rejects. */
  onSave: (rating: Rating | null, comment: string | null) => Promise<unknown>;
}

export const ChatMessageRating: React.FC<ChatMessageRatingProps> = ({
  messageId,
  rating,
  comment,
  pending,
  error,
  onSave,
}) => {
  const [editing, setEditing] = useState<Rating | null>(null);
  const [draft, setDraft] = useState('');
  const commentId = `chat-message-rating-comment-${messageId}`;

  const choose = (value: Rating) => {
    if (!chatRatingNeedsComment(value)) {
      setEditing(null);
      void onSave(rating === value ? null : value, null).catch(() => undefined);
      return;
    }
    setEditing(value);
    setDraft(rating === value ? comment ?? '' : '');
  };

  const save = () => {
    if (!editing || !draft.trim()) return;
    onSave(editing, draft.trim()).then(() => setEditing(null), () => undefined);
  };

  return (
    <div className={styles.rating} {...{ 'data-testid': `chat-message-rating-${messageId}` }}>
      <div className={styles.row} role="group" aria-label="How did the agent do?">
        <span className={styles.label}>How did the agent do?</span>
        {CHAT_MESSAGE_RATINGS.map((value) => {
          const selected = rating === value;
          return (
            <button
              key={value}
              type="button"
              className={`${styles.choice} ${selected ? styles.choiceSelected : ''} ${editing === value ? styles.choiceEditing : ''}`}
              aria-pressed={selected}
              disabled={pending}
              onClick={() => choose(value)}
              {...{ 'data-testid': `chat-message-rating-${value}-${messageId}` }}
            >
              {CHAT_MESSAGE_RATING_LABELS[value]}
            </button>
          );
        })}
      </div>
      {editing && (
        <div className={styles.editor}>
          <label className={styles.editorLabel} htmlFor={commentId}>
            What could the agent do better? (required)
          </label>
          <textarea
            id={commentId}
            className={styles.textarea}
            value={draft}
            maxLength={WORKFLOW_MESSAGE_FEEDBACK_COMMENT_MAX_LENGTH}
            rows={3}
            onChange={(event) => setDraft(event.target.value)}
            {...{ 'data-testid': commentId }}
          />
          <div className={styles.editorActions}>
            <button
              type="button"
              className={styles.save}
              disabled={pending || !draft.trim()}
              onClick={save}
              {...{ 'data-testid': `chat-message-rating-save-${messageId}` }}
            >
              {pending ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              className={styles.cancel}
              onClick={() => setEditing(null)}
              {...{ 'data-testid': `chat-message-rating-cancel-${messageId}` }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </div>
  );
};
