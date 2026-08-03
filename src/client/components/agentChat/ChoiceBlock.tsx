import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChoiceBlock as ChoiceBlockType } from '../../utils/parseAgentMessage';
import styles from './agentChat.module.css';

// Matches agent-formatted question headers like "**Question 6:**" or "**Question 6.**"
function parseQuestionHeader(text: string): [number, string] | null {
  const m = text.match(/^\*\*Question\s+(\d+)\*\*[:.]\s*/i);
  if (!m) return null;
  return [parseInt(m[1], 10), text.slice(m[0].length).trim()];
}

export interface ChoiceBlockProps {
  block: ChoiceBlockType;
  questionNumber: number;
  selection: string | null;
  freeform: string;
  locked: boolean;
  onSelect: (letter: string) => void;
  onFreeform: (text: string) => void;
  onSubmit?: () => void;
}

export const ChoiceBlock: React.FC<ChoiceBlockProps> = ({
  block,
  questionNumber,
  selection,
  freeform,
  locked,
  onSelect,
  onFreeform,
  onSubmit,
}) => {
  const hasBuiltInOther = block.options.some((o) => /^other/i.test(o.text));
  const selectedBuiltInOther = hasBuiltInOther
    && block.options.some((o) => o.letter === selection && /^other/i.test(o.text));
  const showFreeform = selection === 'other' || selectedBuiltInOther;

  const parsed = block.question ? parseQuestionHeader(block.question) : null;
  const displayNumber = parsed ? parsed[0] : questionNumber;
  const questionText = parsed ? parsed[1] : block.question;

  return (
    <div className={`${styles.choiceBlock} ${locked ? styles.choiceBlockLocked : ''}`}>
      {questionText && (
        <div className={styles.choiceQuestion}>
          <span className={styles.choiceQNum}>Q{displayNumber}</span>
          <div className={styles.markdownBody} style={{ flex: 1, padding: '0' }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{questionText}</ReactMarkdown>
          </div>
        </div>
      )}
      <div className={styles.choiceOptions}>
        {block.options.map((opt) => {
          const isSelected = selection === opt.letter;
          return (
            <button
              key={opt.letter}
              className={`${styles.choiceOption} ${isSelected ? styles.choiceOptionSelected : ''}`}
              onClick={() => !locked && onSelect(opt.letter)}
              disabled={locked}
              type="button"
              {...{ 'data-testid': `agent-choice-option-${opt.letter}` }}
            >
              <span className={styles.choiceOptionLetter}>{opt.letter.toUpperCase()}</span>
              <span className={styles.choiceOptionText}>{opt.text}</span>
            </button>
          );
        })}
        {!hasBuiltInOther && (
          <button
            className={`${styles.choiceOption} ${selection === 'other' ? styles.choiceOptionSelected : ''}`}
            onClick={() => !locked && onSelect('other')}
            disabled={locked}
            type="button"
            {...{ 'data-testid': 'agent-choice-option-other' }}
          >
            <span className={styles.choiceOptionLetter}>✎</span>
            <span className={styles.choiceOptionText}>Other / free-form</span>
          </button>
        )}
      </div>
      {showFreeform && !locked && (
        <textarea
          className={styles.choiceFreeform}
          placeholder="Type your answer here… (Enter to submit · Shift+Enter for new line)"
          value={freeform}
          onChange={(e) => onFreeform(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && onSubmit) {
              e.preventDefault();
              onSubmit();
            }
          }}
          rows={2}
          {...{ 'data-testid': 'agent-choice-freeform' }}
        />
      )}
      {locked && freeform && (
        <div className={styles.choiceFreeformLocked}>{freeform}</div>
      )}
    </div>
  );
};
