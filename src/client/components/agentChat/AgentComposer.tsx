import React, { useRef, useEffect, useCallback, useState, type KeyboardEvent } from 'react';
import styles from './agentChat.module.css';

export interface AgentComposerProps {
  /** Controlled input value. */
  value: string;
  /** Input change handler. */
  onChange: (value: string) => void;
  /** Called when the user submits (Enter without Shift). */
  onSend: () => void;
  /** Called when user clicks "Stop" to cancel the running agent. */
  onCancel?: () => void;
  /** Whether any interaction is in progress (disables input + send). */
  disabled?: boolean;
  /** Whether the agent is actively running (shows stop button). */
  isRunning?: boolean;
  /** Whether a message is currently being sent. */
  isSending?: boolean;
  /** Placeholder text for the textarea. */
  placeholder?: string;
  /** Left-side slot (e.g. attachment button, mic button). */
  leftSlot?: React.ReactNode;
  /** Right-side slot (e.g. model picker, send button override). */
  rightSlot?: React.ReactNode;
  /** Additional CSS class for the wrapper. */
  className?: string;
  /** Max height in px for auto-growing textarea. Default: 120. */
  maxHeight?: number;
}

export const AgentComposer: React.FC<AgentComposerProps> = ({
  value,
  onChange,
  onSend,
  onCancel,
  disabled = false,
  isRunning = false,
  isSending = false,
  placeholder,
  leftSlot,
  rightSlot,
  className,
  maxHeight = 120,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [focused, setFocused] = useState(false);

  // Auto-resize
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [value, maxHeight]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!disabled && !isRunning && !isSending) {
        onSend();
      }
    }
  }, [disabled, isRunning, isSending, onSend]);

  const resolvedPlaceholder = placeholder
    ?? (isRunning ? 'Agent is thinking…' : 'Type a message… (Enter to send)');

  return (
    <div className={`${styles.composer} ${focused ? styles.composerFocused : ''} ${className ?? ''}`}>
      {leftSlot && <div className={styles.composerLeft}>{leftSlot}</div>}
      <textarea
        ref={textareaRef}
        className={styles.composerTextarea}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={resolvedPlaceholder}
        disabled={disabled}
        rows={1}
        {...{ 'data-testid': 'agent-composer-input' }}
      />
      <div className={styles.composerRight}>
        {isRunning && onCancel ? (
          <button
            className={styles.composerStopBtn}
            onClick={onCancel}
            type="button"
            title="Stop agent"
            {...{ 'data-testid': 'agent-composer-stop-btn' }}
          >
            Stop
          </button>
        ) : (
          <button
            className={styles.composerSendBtn}
            onClick={onSend}
            disabled={disabled || isRunning || isSending || !value.trim()}
            type="button"
            title="Send message"
            {...{ 'data-testid': 'agent-composer-send-btn' }}
          >
            {isSending ? '…' : '↑'}
          </button>
        )}
        {rightSlot}
      </div>
    </div>
  );
};
