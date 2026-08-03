import React, { useState, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { parseAgentMessage } from '../../utils/parseAgentMessage';
import type { ChoiceBlock as ChoiceBlockType } from '../../utils/parseAgentMessage';
import { ChoiceBlock } from './ChoiceBlock';
import { ReadAloudButton } from '../ReadAloudButton';
import styles from './agentChat.module.css';

interface QuestionState {
  selected: string | null;
  freeform: string;
}

export interface AgentMessageProps {
  /** The raw agent message text to parse and render. */
  text: string;
  /** Timestamp string for the message. */
  ts?: string;
  /** Called when the user submits choice-block answers. */
  onChoiceSubmit?: (text: string) => void;
  /** Whether the agent is currently processing (disables choice submit). */
  isRunning?: boolean;
  /** Whether choice blocks should be locked (e.g. read-only, already answered). */
  locked?: boolean;
  /** Whether the user already answered this message's choice blocks. */
  alreadyAnswered?: boolean;
  /**
   * When true, only renders choices as interactive on this message
   * (used by DevSession for "only last message interactive").
   */
  interactive?: boolean;
  /** Starting question number offset for choice numbering. */
  questionOffset?: number;
  /** Renders the agent avatar/header; if omitted uses default AI avatar. */
  renderHeader?: () => React.ReactNode;
  /** Whether to show the read-aloud button. Default: true. */
  showReadAloud?: boolean;
  /** Additional CSS class for the wrapper. */
  className?: string;
  /** data-message-id for highlighting / scroll-to. */
  messageId?: string;
  /** When true, message is highlighted (e.g. from search). */
  highlighted?: boolean;
}

export const AgentMessage: React.FC<AgentMessageProps> = ({
  text,
  ts,
  onChoiceSubmit,
  isRunning = false,
  locked = false,
  alreadyAnswered = false,
  interactive = true,
  questionOffset = 0,
  renderHeader,
  showReadAloud = true,
  className,
  messageId,
  highlighted = false,
}) => {
  const parts = parseAgentMessage(text);
  const choiceBlocks = parts.filter((p): p is ChoiceBlockType => p.type === 'choices');

  const [selections, setSelections] = useState<Record<string, QuestionState>>(() => {
    const init: Record<string, QuestionState> = {};
    for (const b of choiceBlocks) init[b.id] = { selected: null, freeform: '' };
    return init;
  });
  const [sent, setSent] = useState(alreadyAnswered);

  // Sync alreadyAnswered prop into local state
  React.useEffect(() => {
    if (alreadyAnswered) setSent(true);
  }, [alreadyAnswered]);

  const allAnswered = choiceBlocks.every((b) => {
    const s = selections[b.id];
    if (!s) return false;
    if (s.selected === 'other') return s.freeform.trim().length > 0;
    return s.selected !== null;
  });

  const handleSelect = useCallback((blockId: string, letter: string) => {
    setSelections((prev) => ({ ...prev, [blockId]: { ...prev[blockId], selected: letter } }));
  }, []);

  const handleFreeform = useCallback((blockId: string, value: string) => {
    setSelections((prev) => ({ ...prev, [blockId]: { ...prev[blockId], freeform: value } }));
  }, []);

  const handleSubmit = useCallback(() => {
    if (!allAnswered || sent || !onChoiceSubmit) return;
    const lines: string[] = [];
    let qNum = questionOffset + 1;
    for (const block of choiceBlocks) {
      const s = selections[block.id];
      if (!s) continue;
      if (s.selected === 'other') {
        lines.push(`Q${qNum}: ${s.freeform.trim()}`);
      } else if (s.selected) {
        const opt = block.options.find((o) => o.letter === s.selected);
        lines.push(`Q${qNum}: ${s.selected.toUpperCase()} — ${opt?.text ?? s.selected}`);
        if (s.freeform.trim()) lines.push(`  Notes: ${s.freeform.trim()}`);
      }
      qNum++;
    }
    onChoiceSubmit(lines.join('\n'));
    setSent(true);
  }, [allAnswered, sent, onChoiceSubmit, questionOffset, choiceBlocks, selections]);

  const effectiveLocked = locked || sent || !interactive;

  // Simple markdown-only message (no choice blocks)
  if (choiceBlocks.length === 0) {
    return (
      <div
        data-message-id={messageId}
        className={`${styles.agentBubble} ${highlighted ? styles.agentBubbleHighlighted : ''} ${className ?? ''}`}
      >
        {renderHeader?.()}
        <div className={styles.agentBubbleContent}>
          {showReadAloud && (
            <div className={styles.bubbleActions}>
              <ReadAloudButton text={text} {...{ 'data-testid': 'agent-message-read-aloud' }} />
            </div>
          )}
          <div className={styles.markdownBody}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
          </div>
        </div>
        {ts && <span className={styles.agentMsgMeta}>{new Date(ts).toLocaleTimeString()}</span>}
      </div>
    );
  }

  // Message with choice blocks
  let questionCounter = questionOffset;
  return (
    <div
      data-message-id={messageId}
      className={`${styles.agentBubble} ${highlighted ? styles.agentBubbleHighlighted : ''} ${className ?? ''}`}
    >
      {renderHeader?.()}
      <div className={styles.agentBubbleContent}>
        {showReadAloud && (
          <div className={styles.bubbleActions}>
            <ReadAloudButton text={text} {...{ 'data-testid': 'agent-message-read-aloud' }} />
          </div>
        )}
        {parts.map((part) => {
          if (part.type === 'markdown') {
            return (
              <div key={part.id} className={styles.markdownBody}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{part.content}</ReactMarkdown>
              </div>
            );
          }
          questionCounter++;
          const qNum = questionCounter;
          const s = selections[part.id] ?? { selected: null, freeform: '' };
          return (
            <ChoiceBlock
              key={part.id}
              block={part}
              questionNumber={qNum}
              selection={s.selected}
              freeform={s.freeform}
              locked={effectiveLocked}
              onSelect={(letter) => handleSelect(part.id, letter)}
              onFreeform={(value) => handleFreeform(part.id, value)}
              onSubmit={handleSubmit}
              {...{ 'data-testid': `agent-choice-block-${part.id}` }}
            />
          );
        })}
        {choiceBlocks.length > 0 && !effectiveLocked && onChoiceSubmit && (
          <button
            className={styles.choiceSendBtn}
            onClick={handleSubmit}
            disabled={!allAnswered || isRunning}
            type="button"
            {...{ 'data-testid': 'agent-choice-submit-btn' }}
          >
            {isRunning ? 'Agent is thinking…' : 'Submit answers ↑'}
          </button>
        )}
        {sent && choiceBlocks.length > 0 && (
          <div className={styles.choiceSentLabel}>✓ Answers sent</div>
        )}
      </div>
      {ts && <span className={styles.agentMsgMeta}>{new Date(ts).toLocaleTimeString()}</span>}
    </div>
  );
};
