import React from 'react';
import type { InterviewMessageRating } from '../../shared/types/workflowMessageFeedback';
import styles from './InterviewMessageThumbs.module.css';

export interface InterviewMessageThumbsProps {
  messageId: string;
  rating: InterviewMessageRating | null;
  disabled: boolean;
  /** Clicking the selected thumb again clears the rating. */
  onRate: (rating: InterviewMessageRating | null) => void;
}

const ThumbIcon: React.FC<{ down?: boolean }> = ({ down = false }) => (
  <svg
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    style={down ? { transform: 'rotate(180deg)' } : undefined}
  >
    <path d="M5 7v7H2.5V7H5z" />
    <path d="M5 7l2.5-5c1 0 1.8.8 1.8 1.8V6h3.4c.8 0 1.4.7 1.3 1.5l-.8 5c-.1.6-.7 1-1.3 1H5" />
  </svg>
);

export const InterviewMessageThumbs: React.FC<InterviewMessageThumbsProps> = ({
  messageId,
  rating,
  disabled,
  onRate,
}) => {
  const button = (value: InterviewMessageRating, label: string) => {
    const selected = rating === value;
    return (
      <button
        type="button"
        className={`${styles.thumb} ${selected ? styles.thumbSelected : ''}`}
        aria-pressed={selected}
        aria-label={label}
        title={disabled ? 'Ratings close when the interview is complete' : label}
        disabled={disabled}
        onClick={() => onRate(selected ? null : value)}
        {...{ 'data-testid': `interview-message-thumb-${value}-${messageId}` }}
      >
        <ThumbIcon down={value === 'down'} />
      </button>
    );
  };

  return (
    <div className={styles.group} role="group" aria-label="Rate this question">
      {button('up', 'Good question')}
      {button('down', 'Not a good question')}
    </div>
  );
};
