import React, { useCallback, useEffect, useRef, type KeyboardEvent } from 'react';
import { formatAttachmentSize } from '../../hooks/useChatAttachments';
import styles from './agentChat.module.css';

export interface AgentComposerAttachment {
  id: string;
  name: string;
  size: number;
}

export interface AgentComposerModelOption {
  id: string;
  displayName: string;
}

export interface AgentComposerSpeechProps {
  isListening: boolean;
  isSpeechSupported: boolean;
  speechError?: string | null;
  onToggle: () => void;
}

export interface AgentComposerTestIds {
  input?: string;
  send?: string;
  stop?: string;
  attach?: string;
  microphone?: string;
  model?: string;
}

export interface AgentComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onCancel?: () => void;
  disabled?: boolean;
  isRunning?: boolean;
  isSending?: boolean;
  /** Greys the shell while any interaction is in progress. Defaults to disabled || isRunning || isSending. */
  isBusy?: boolean;
  /** Soft-disable chrome (e.g. skill selection required) without treating as busy. */
  shellDisabled?: boolean;
  isCancelling?: boolean;
  placeholder?: string;
  rows?: number;
  maxHeight?: number;
  autoFocus?: boolean;
  /** Allow send when value is empty but attachments exist. */
  allowEmptySend?: boolean;
  /** Override derived send enablement (e.g. Agent Home skill-gate). */
  canSend?: boolean;
  /** Prefix for stable test ids, e.g. `adr` → `adr-message-input`. */
  testIdPrefix?: string;
  /** Optional explicit test ids that override prefix defaults. */
  testIds?: AgentComposerTestIds;
  className?: string;
  /** Extra class on the input shell (inside composerArea). */
  shellClassName?: string;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null> | React.MutableRefObject<HTMLTextAreaElement | null>;
  attachments?: AgentComposerAttachment[];
  attachmentError?: string | null;
  onRemoveAttachment?: (id: string) => void;
  onAttachClick?: () => void;
  speech?: AgentComposerSpeechProps;
  model?: string;
  models?: AgentComposerModelOption[];
  modelsLoading?: boolean;
  onModelChange?: (modelId: string) => void;
  /** Extra controls rendered before the send/stop button (e.g. standup submit). */
  trailingActions?: React.ReactNode;
  /** When not running, replaces the default send button (e.g. interview context confirm). */
  sendButton?: React.ReactNode;
  /** Content above the input shell (skill picker, banners). */
  before?: React.ReactNode;
  /** Content below the input shell (hints). */
  after?: React.ReactNode;
  /** Hidden file input element owned by the parent. */
  fileInput?: React.ReactNode;
  /** Optional keydown handler. If it calls preventDefault(), Enter-to-send is skipped. */
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  /** Root landmark test id (also accepted via spread `'data-testid'`). */
  'data-testid'?: string;
}

const PaperPlaneIcon: React.FC = () => (
  <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
    <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
  </svg>
);

const AttachIcon: React.FC = () => (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M7 10.5l5.2-5.2a3 3 0 114.2 4.2l-6.7 6.7a5 5 0 01-7.1-7.1l6.4-6.4" />
  </svg>
);

const MicIcon: React.FC = () => (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="7" y="2.5" width="6" height="10" rx="3" />
    <path d="M4.5 9.5v0.5a5.5 5.5 0 0 0 11 0v-0.5" />
    <path d="M10 15.5v2.5" />
    <path d="M7.5 18h5" />
  </svg>
);

function testId(prefix: string | undefined, suffix: string): string | undefined {
  return prefix ? `${prefix}-${suffix}` : undefined;
}

export const AgentComposer: React.FC<AgentComposerProps> = ({
  value,
  onChange,
  onSend,
  onCancel,
  disabled = false,
  isRunning = false,
  isSending = false,
  isBusy,
  shellDisabled = false,
  isCancelling = false,
  placeholder,
  rows = 1,
  maxHeight = 120,
  autoFocus = false,
  allowEmptySend = false,
  canSend: canSendOverride,
  testIdPrefix,
  testIds,
  className,
  shellClassName,
  textareaRef: externalTextareaRef,
  attachments = [],
  attachmentError,
  onRemoveAttachment,
  onAttachClick,
  speech,
  model,
  models,
  modelsLoading = false,
  onModelChange,
  trailingActions,
  sendButton,
  before,
  after,
  fileInput,
  onKeyDown,
  'data-testid': dataTestId,
}) => {
  const internalTextareaRef = useRef<HTMLTextAreaElement>(null);
  const textareaRef = externalTextareaRef ?? internalTextareaRef;
  const busy = isBusy ?? (disabled || isRunning || isSending);
  const canType = !disabled && !isSending;
  const derivedCanSend = !disabled && !isRunning && !isSending
    && (value.trim().length > 0 || (allowEmptySend && attachments.length > 0));
  const canSend = canSendOverride ?? derivedCanSend;

  const resolveTestId = (key: keyof AgentComposerTestIds, suffix: string, fallback?: string): string | undefined =>
    testIds?.[key] ?? testId(testIdPrefix, suffix) ?? fallback;

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [value, maxHeight, textareaRef]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      if (canSend) onSend();
    }
  }, [canSend, onKeyDown, onSend]);

  const resolvedPlaceholder = placeholder
    ?? (isRunning ? 'Agent is thinking…' : 'Type a message… (Enter to send)');

  const showModel = typeof model === 'string' && typeof onModelChange === 'function';
  const showAttach = typeof onAttachClick === 'function';
  const showSpeech = Boolean(speech);
  const inputTestId = resolveTestId('input', 'message-input', 'agent-composer-input');
  const attachTestId = resolveTestId('attach', 'attach');
  const micTestId = resolveTestId('microphone', 'microphone');
  const modelTestId = resolveTestId('model', 'model');
  const stopTestId = resolveTestId('stop', 'stop-btn', 'agent-composer-stop-btn');
  const sendTestId = resolveTestId('send', 'send-btn', 'agent-composer-send-btn');

  const rootTestId = dataTestId
    ?? testId(testIdPrefix, 'composer')
    ?? 'agent-composer';

  return (
    <div
      className={`${styles.composerArea} ${className ?? ''}`}
      {...{ 'data-testid': rootTestId }}
    >
      {before}
      {fileInput}
      <div
        className={[
          styles.inputBox,
          busy ? styles.inputBoxBusy : '',
          shellDisabled ? styles.inputBoxDisabled : '',
          shellClassName ?? '',
        ].filter(Boolean).join(' ')}
        aria-busy={busy}
      >
        <textarea
          ref={textareaRef as React.RefObject<HTMLTextAreaElement>}
          className={styles.inputField}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={resolvedPlaceholder}
          rows={rows}
          disabled={!canType}
          // eslint-disable-next-line jsx-a11y/no-autofocus -- opt-in compose UX
          autoFocus={autoFocus}
          {...(inputTestId ? { 'data-testid': inputTestId } : {})}
        />

        {attachments.length > 0 && (
          <div className={styles.attachmentList}>
            {attachments.map((attachment) => (
              <span key={attachment.id} className={styles.attachmentChip}>
                <span className={styles.attachmentName}>{attachment.name}</span>
                <span className={styles.attachmentSize}>{formatAttachmentSize(attachment.size)}</span>
                {onRemoveAttachment && (
                  <button
                    type="button"
                    className={styles.attachmentRemove}
                    onClick={() => onRemoveAttachment(attachment.id)}
                    disabled={busy || shellDisabled}
                    aria-label={`Remove ${attachment.name}`}
                    {...(testId(testIdPrefix, `attachment-remove-${attachment.id}`)
                      ? { 'data-testid': testId(testIdPrefix, `attachment-remove-${attachment.id}`) }
                      : {})}
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
          </div>
        )}

        {attachmentError && <div className={styles.attachmentError}>{attachmentError}</div>}
        {speech?.speechError && <div className={styles.speechError}>{speech.speechError}</div>}

        <div className={styles.inputActions}>
            {showAttach && (
              <button
                className={styles.attachBtn}
                onClick={onAttachClick}
                type="button"
                aria-label="Attach files"
                title="Attach files for context"
                disabled={busy || shellDisabled}
                {...(attachTestId ? { 'data-testid': attachTestId } : {})}
              >
                <AttachIcon />
              </button>
            )}

            {showSpeech && speech && (
              <button
                className={`${styles.micBtn} ${speech.isListening ? styles.micBtnActive : ''}`}
                onClick={speech.onToggle}
                type="button"
                aria-label={speech.isListening ? 'Stop voice transcription' : 'Start voice transcription'}
                title={speech.isSpeechSupported
                  ? (speech.isListening ? 'Stop listening' : 'Talk to transcribe into chat')
                  : 'Speech recognition not supported in this browser'}
                disabled={!speech.isSpeechSupported || busy || shellDisabled}
                {...(micTestId ? { 'data-testid': micTestId } : {})}
              >
                <MicIcon />
              </button>
            )}

            {showModel && (
              <select
                className={styles.modelSelect}
                value={model}
                onChange={(event) => onModelChange?.(event.target.value)}
                disabled={busy || shellDisabled}
                aria-label="Model"
                {...(modelTestId ? { 'data-testid': modelTestId } : {})}
              >
                {modelsLoading || !models?.length ? (
                  <option value={model}>{model || 'Loading models…'}</option>
                ) : (
                  <>
                    {!models.some((item) => item.id === model) && model && (
                      <option value={model}>{model}</option>
                    )}
                    {models.map((item) => (
                      <option key={item.id} value={item.id}>{item.displayName}</option>
                    ))}
                  </>
                )}
              </select>
            )}

            {trailingActions}

            {isRunning && onCancel ? (
              <button
                className={`${styles.sendBtn} ${styles.stopBtn} ${isCancelling ? styles.stopBtnStopping : ''}`}
                onClick={onCancel}
                type="button"
                aria-label={isCancelling ? 'Stopping' : 'Stop'}
                title="Stop"
                disabled={isCancelling}
                {...(stopTestId ? { 'data-testid': stopTestId } : {})}
              >
                {isCancelling ? (
                  <span className={styles.stopSpinner} aria-hidden="true" />
                ) : (
                  <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                    <rect x="4" y="4" width="12" height="12" rx="2" />
                  </svg>
                )}
                <span>{isCancelling ? 'Stopping…' : 'Stop'}</span>
              </button>
            ) : (
              sendButton ?? (
                <button
                  className={styles.sendBtn}
                  onClick={onSend}
                  disabled={!canSend}
                  type="button"
                  aria-label="Send"
                  title="Send message"
                  {...(sendTestId ? { 'data-testid': sendTestId } : {})}
                >
                  {isSending ? '…' : <PaperPlaneIcon />}
                </button>
              )
            )}
        </div>

        {speech?.isListening && (
          <div className={styles.speechStatus}>Listening… your speech is being transcribed.</div>
        )}
      </div>
      {after}
    </div>
  );
};
