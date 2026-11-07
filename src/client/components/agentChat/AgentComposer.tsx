import React, { useCallback, useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import { formatAttachmentSize } from '../../hooks/useChatAttachments';
import styles from './agentChat.module.css';

export interface AgentComposerAttachment {
  id: string;
  name: string;
  size: number;
  type?: string;
  content?: string;
  encoding?: 'base64';
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
  /** Optional clipboard paste handler (e.g. pasting screenshots or files into the composer). */
  onPaste?: (event: ClipboardEvent<HTMLTextAreaElement>) => void;
  /** Optional callback to add pasted files directly into attachments. */
  onPasteFiles?: (files: File[]) => void;
  /** Optional pill badge rendered on the left side of the bottom action bar (e.g. "∞ Collaborator"). */
  modeBadge?: React.ReactNode;
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

function describeModelOption(item: AgentComposerModelOption): { badge: string; subtitle: string; family: 'composer' | 'claude' | 'gpt' | 'gemini' | 'grok' | 'other' } {
  const lower = `${item.id} ${item.displayName}`.toLowerCase();
  if (lower.includes('composer')) {
    return {
      badge: 'Cursor',
      subtitle: 'Fast multi-step reasoning and codebase synthesis',
      family: 'composer',
    };
  }
  if (lower.includes('opus')) {
    return {
      badge: 'Anthropic',
      subtitle: 'Deep architectural reasoning and complex trade-offs',
      family: 'claude',
    };
  }
  if (lower.includes('sonnet') || lower.includes('claude')) {
    return {
      badge: 'Anthropic',
      subtitle: 'Balanced speed, structured writing, and code analysis',
      family: 'claude',
    };
  }
  if (lower.includes('gpt') || lower.includes('o1') || lower.includes('o3')) {
    return {
      badge: 'OpenAI',
      subtitle: 'High-precision analytical reasoning and problem solving',
      family: 'gpt',
    };
  }
  if (lower.includes('gemini')) {
    return {
      badge: 'Google',
      subtitle: 'Broad context synthesis and multimodal exploration',
      family: 'gemini',
    };
  }
  if (lower.includes('grok')) {
    return {
      badge: 'xAI',
      subtitle: 'Direct technical exploration and fast iteration',
      family: 'grok',
    };
  }
  return {
    badge: 'Model',
    subtitle: 'AI collaborator model for this session',
    family: 'other',
  };
}

const ModelGlyph: React.FC<{ family: ReturnType<typeof describeModelOption>['family'] }> = ({ family }) => {
  switch (family) {
    case 'composer':
      return (
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M10 2.8l2 4.4 4.4 2-4.4 2-2 4.4-2-4.4-4.4-2 4.4-2 2-4.4z" />
        </svg>
      );
    case 'claude':
      return (
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="10" cy="10" r="6.8" />
          <path d="M10 5.5v9M5.5 10h9" />
        </svg>
      );
    case 'gpt':
      return (
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polygon points="10 3 16.2 6.5 16.2 13.5 10 17 3.8 13.5 3.8 6.5 10 3" />
          <circle cx="10" cy="10" r="2.2" />
        </svg>
      );
    case 'gemini':
      return (
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M10 3c1.6 3.8 3.2 5.4 7 7-3.8 1.6-5.4 3.2-7 7-1.6-3.8-3.2-5.4-7-7 3.8-1.6 5.4-3.2 7-7z" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="4" y="4" width="12" height="12" rx="3" />
          <circle cx="10" cy="10" r="2" />
        </svg>
      );
  }
};

const AgentModelPicker: React.FC<{
  model: string;
  models: AgentComposerModelOption[] | undefined;
  modelsLoading: boolean;
  disabled: boolean;
  modelTestId?: string;
  testIdPrefix?: string;
  onModelChange?: (modelId: string) => void;
}> = ({
  model,
  models,
  modelsLoading,
  disabled,
  modelTestId,
  testIdPrefix,
  onModelChange,
}) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleOutside = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open]);

  const normalizedOptions: AgentComposerModelOption[] = React.useMemo(() => {
    if (modelsLoading || !models?.length) {
      return model ? [{ id: model, displayName: model }] : [];
    }
    const hasCurrent = models.some((item) => item.id === model);
    if (!hasCurrent && model) {
      return [{ id: model, displayName: model }, ...models];
    }
    return models;
  }, [model, models, modelsLoading]);

  const currentOption = normalizedOptions.find((item) => item.id === model)
    ?? { id: model, displayName: model || (modelsLoading ? 'Loading models…' : 'Select model') };
  const currentMeta = describeModelOption(currentOption);
  const triggerTestId = testId(testIdPrefix, 'model-trigger') ?? 'agent-composer-model-trigger';
  const menuTestId = testId(testIdPrefix, 'model-menu') ?? 'agent-composer-model-menu';

  return (
    <div ref={wrapRef} className={styles.modelPickerWrap}>
      <button
        type="button"
        className={`${styles.modelTrigger} ${open ? styles.modelTriggerOpen : ''}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Selected model: ${currentOption.displayName}`}
        title={currentMeta.subtitle}
        onClick={() => setOpen((prev) => !prev)}
        {...{ 'data-testid': triggerTestId }}
      >
        <span className={styles.modelTriggerIcon} aria-hidden="true">
          <ModelGlyph family={currentMeta.family} />
        </span>
        <span className={styles.modelTriggerLabel}>{currentOption.displayName}</span>
        <span className={styles.modelCaret} aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>

      {/* Accessible native select kept synchronized for keyboard/screen-reader and test compatibility */}
      <select
        className={styles.srOnlyModelSelect}
        tabIndex={-1}
        value={model}
        onChange={(event) => {
          onModelChange?.(event.target.value);
          setOpen(false);
        }}
        disabled={disabled}
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

      {open && (
        <div
          className={styles.modelMenu}
          role="listbox"
          aria-label="Select AI model"
          {...{ 'data-testid': menuTestId }}
        >
          <div className={styles.modelMenuHeader}>Model — powers the collaborator</div>
          <div className={styles.modelMenuList}>
            {normalizedOptions.map((item) => {
              const active = item.id === model;
              const meta = describeModelOption(item);
              const optionTestId = testId(testIdPrefix, `model-option-${item.id}`) ?? `agent-composer-model-option-${item.id}`;
              return (
                <button
                  key={item.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`${styles.modelOption} ${active ? styles.modelOptionActive : ''}`}
                  onClick={() => {
                    onModelChange?.(item.id);
                    setOpen(false);
                  }}
                  {...{ 'data-testid': optionTestId }}
                >
                  <span className={styles.modelOptionIcon} aria-hidden="true">
                    <ModelGlyph family={meta.family} />
                  </span>
                  <span className={styles.modelOptionBody}>
                    <span className={styles.modelOptionTitleRow}>
                      <span className={styles.modelOptionTitle}>{item.displayName}</span>
                      <span className={styles.modelOptionPill}>{meta.badge}</span>
                    </span>
                    <span className={styles.modelOptionSubtitle}>{meta.subtitle}</span>
                  </span>
                  {active && (
                    <span className={styles.modelOptionCheck} aria-hidden="true">✓</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

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
  onPaste,
  onPasteFiles,
  modeBadge,
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

  const handlePaste = useCallback((event: ClipboardEvent<HTMLTextAreaElement>) => {
    onPaste?.(event);
    if (event.defaultPrevented || !onPasteFiles) return;
    const clipboard = event.clipboardData;
    if (!clipboard) return;
    const extracted: File[] = [];
    if (clipboard.items && clipboard.items.length > 0) {
      for (let i = 0; i < clipboard.items.length; i += 1) {
        const item = clipboard.items[i];
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) {
            const hasExt = /\.[a-z0-9]+$/i.test(file.name);
            const fallbackExt = (file.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '');
            const named = !file.name || file.name === 'image.png' || !hasExt
              ? new File([file], `screenshot-${Date.now()}-${i + 1}.${fallbackExt}`, { type: file.type || 'image/png' })
              : file;
            extracted.push(named);
          }
        }
      }
    } else if (clipboard.files && clipboard.files.length > 0) {
      extracted.push(...Array.from(clipboard.files));
    }
    if (extracted.length > 0) {
      event.preventDefault();
      onPasteFiles(extracted);
    }
  }, [onPaste, onPasteFiles]);

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
          onPaste={handlePaste}
          placeholder={resolvedPlaceholder}
          rows={rows}
          disabled={!canType}
          // eslint-disable-next-line jsx-a11y/no-autofocus -- opt-in compose UX
          autoFocus={autoFocus}
          {...(inputTestId ? { 'data-testid': inputTestId } : {})}
        />

        {attachments.length > 0 && (
          <div className={styles.attachmentList} {...{ 'data-testid': testId(testIdPrefix, 'attachments') ?? 'agent-composer-attachments' }}>
            {attachments.map((attachment) => {
              const isImage = Boolean(
                attachment.type?.startsWith('image/') && attachment.content && attachment.encoding === 'base64',
              );
              return (
                <span key={attachment.id} className={styles.attachmentChip}>
                  {isImage && (
                    <img
                      src={`data:${attachment.type};base64,${attachment.content}`}
                      alt={attachment.name}
                      className={styles.attachmentThumb}
                    />
                  )}
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
              );
            })}
          </div>
        )}

        {attachmentError && <div className={styles.attachmentError} role="alert">{attachmentError}</div>}
        {speech?.speechError && <div className={styles.speechError} role="alert">{speech.speechError}</div>}

        <div className={`${styles.inputActions} ${(modeBadge || showModel) ? styles.inputActionsSplit : ''}`}>
          {(modeBadge || showModel) && (
            <div className={styles.inputActionsLeft}>
              {modeBadge}
              {showModel && typeof model === 'string' && (
                // data-testid-exempt — AgentModelPicker forwards modelTestId and option testids
                <AgentModelPicker
                  model={model}
                  models={models}
                  modelsLoading={modelsLoading}
                  disabled={busy || shellDisabled}
                  modelTestId={modelTestId}
                  testIdPrefix={testIdPrefix}
                  onModelChange={onModelChange}
                />
              )}
            </div>
          )}

          <div className={styles.inputActionsRight}>
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

            {showAttach && (
              <button
                className={styles.attachBtn}
                onClick={onAttachClick}
                type="button"
                aria-label="Attach files"
                title="Attach files or paste a screenshot (Ctrl+V)"
                disabled={busy || shellDisabled}
                {...(attachTestId ? { 'data-testid': attachTestId } : {})}
              >
                <AttachIcon />
              </button>
            )}

            {trailingActions}

            {isRunning && onCancel ? (
              <button
                className={`${styles.sendBtn} ${styles.stopBtn} ${isCancelling ? styles.stopBtnStopping : ''}`}
                onClick={onCancel}
                type="button"
                aria-label={isCancelling ? 'Stopping agent' : 'Stop'}
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
        </div>

        {speech?.isListening && (
          <div className={styles.speechStatus}>Listening… your speech is being transcribed.</div>
        )}
      </div>
      {after}
    </div>
  );
};
