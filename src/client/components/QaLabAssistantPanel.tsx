import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAgentChatSession } from '../hooks/useAgentChatSession';
import { useAvailableModels, useGlobalDefaultModel } from '../hooks/useProjectSkillConfig';
import { AgentComposer, AgentPanelShell } from './agentChat';
import styles from './QaLabAssistantPanel.module.css';

export interface QaLabAssistantPanelProps {
  /** PRD that owns the test cases in view; the assistant thread is scoped to it. */
  prdId: string;
  /** Shown in the panel header so QA knows which requirement is in context. */
  contextLabel?: string;
  open: boolean;
  onClose: () => void;
  /** Invoked after an agent run finishes so the parent can refetch test cases. */
  onRunComplete?: () => void;
}

const MIN_PANEL_WIDTH = 300;
const MAX_PANEL_WIDTH = 820;
const DEFAULT_PANEL_WIDTH = 400;

/** Canned openers so QA does not have to phrase prompts from scratch. */
const QUICK_PROMPTS: { label: string; prompt: string }[] = [
  {
    label: 'Fill coverage gaps',
    prompt:
      'Review the generated test cases for this requirement and add cases for any acceptance criterion or business rule that has no coverage yet. Use add_test_case for each one.',
  },
  {
    label: 'Add negative cases',
    prompt:
      'Add negative and authorization test cases for this requirement — scenarios where the actor is blocked or the input is invalid. Use add_test_case for each one.',
  },
  {
    label: 'Add edge cases',
    prompt:
      'Add boundary and edge-case tests for this requirement, covering limits, empty states, and maximum values. Use add_test_case for each one.',
  },
];

export const QaLabAssistantPanel: React.FC<QaLabAssistantPanelProps> = ({
  prdId,
  contextLabel,
  open,
  onClose,
  onRunComplete,
}) => {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);
  const [isDragging, setIsDragging] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const wasRunningRef = useRef(false);
  const dragStartXRef = useRef(0);
  const dragStartWidthRef = useRef(DEFAULT_PANEL_WIDTH);

  const queryClient = useQueryClient();
  const { data: availableModels, isLoading: modelsLoading } = useAvailableModels();
  const { data: globalDefaultModel } = useGlobalDefaultModel();

  const session = useAgentChatSession(threadId);
  const { messages, streamingText, isRunning, isSending, showTypingIndicator } = session;

  // Seed the picker from the global default once models resolve.
  useEffect(() => {
    if (selectedModel) return;
    const fallback = globalDefaultModel?.value ?? availableModels?.[0]?.id;
    if (fallback) setSelectedModel(fallback);
  }, [selectedModel, globalDefaultModel?.value, availableModels]);

  // A finished run may have added cases via add_test_case — refetch the grid.
  useEffect(() => {
    if (wasRunningRef.current && !isRunning) {
      void queryClient.invalidateQueries({ queryKey: ['prd-test-cases', prdId] });
      void queryClient.invalidateQueries({ queryKey: ['qa-lab'] });
      onRunComplete?.();
    }
    wasRunningRef.current = isRunning;
  }, [isRunning, queryClient, prdId, onRunComplete]);

  // The PRD assistant thread carries the add_test_case tool, so QA Lab reuses it.
  useEffect(() => {
    if (!open || threadId) return;
    setIsCreating(true);
    setCreateError(null);
    fetch(`/api/interviews/prds/${prdId}/assistant-thread`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
    })
      .then(async (response) => {
        if (!response.ok) {
          let message = `Server error ${response.status}`;
          try {
            const body = (await response.json()) as { error?: string };
            if (body.error) message = body.error;
          } catch { /* non-JSON body */ }
          throw new Error(message);
        }
        return response.json() as Promise<{ threadId: string }>;
      })
      .then((data) => setThreadId(data.threadId))
      .catch((err: unknown) =>
        setCreateError(
          err instanceof Error ? err.message : 'Could not start the assistant. Please try again.',
        ),
      )
      .finally(() => setIsCreating(false));
  }, [open, prdId, threadId]);

  const handleResizeMouseDown = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    dragStartXRef.current = event.clientX;
    dragStartWidthRef.current = panelWidth;
    setIsDragging(true);
  }, [panelWidth]);

  useEffect(() => {
    if (!isDragging) return;
    const onMouseMove = (event: MouseEvent) => {
      const delta = dragStartXRef.current - event.clientX;
      setPanelWidth(
        Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, dragStartWidthRef.current + delta)),
      );
    };
    const onMouseUp = () => setIsDragging(false);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [isDragging]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, streamingText]);

  const sendPrompt = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    await session.send(trimmed, selectedModel ? { model: selectedModel } : undefined);
  }, [session, selectedModel]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    await sendPrompt(text);
  }, [input, sendPrompt]);

  const visibleMessages = messages.filter(
    (message) =>
      message.role !== 'tool'
      && !message.hidden
      && message.toolName !== '_reasoning'
      && message.toolName !== '_thinking',
  );

  if (!open) return null;

  const composerBusy = isRunning || isSending || isCreating || !threadId;

  return (
    <div {...{ 'data-testid': 'qa-lab-assistant-panel' }}>
      <AgentPanelShell
        title="QA Assistant"
        ariaLabel="QA Lab assistant panel"
        onClose={onClose}
        closeAriaLabel="Close QA assistant"
        closeTestId="qa-lab-assistant-close-btn"
        width={panelWidth}
        onResizeMouseDown={handleResizeMouseDown}
        status={contextLabel ? (
          <div className={styles.contextBar} {...{ 'data-testid': 'qa-lab-assistant-context' }}>
            <span className={styles.contextLabel}>Context</span>
            <span className={styles.contextValue}>{contextLabel}</span>
          </div>
        ) : undefined}
        composer={(
          <AgentComposer
            className={styles.composerEmbed}
            value={input}
            onChange={setInput}
            onSend={() => void handleSend()}
            onCancel={isRunning ? () => void session.cancel() : undefined}
            disabled={composerBusy}
            isRunning={isRunning}
            isSending={isSending}
            placeholder={
              isCreating
                ? 'Starting assistant…'
                : isRunning
                  ? 'Agent is thinking…'
                  : 'Ask for more test cases… (Enter to send)'
            }
            testIdPrefix="qa-lab-assistant"
            textareaRef={textareaRef}
            model={selectedModel}
            models={availableModels}
            modelsLoading={modelsLoading}
            onModelChange={setSelectedModel}
            before={(
              <div className={styles.quickPrompts}>
                {QUICK_PROMPTS.map((quick) => (
                  <button
                    key={quick.label}
                    type="button"
                    className={styles.quickPrompt}
                    disabled={composerBusy}
                    onClick={() => void sendPrompt(quick.prompt)}
                    {...{ 'data-testid': `qa-lab-quick-${quick.label.toLowerCase().replace(/\s+/g, '-')}` }}
                  >
                    {quick.label}
                  </button>
                ))}
              </div>
            )}
            {...{ 'data-testid': 'qa-lab-assistant-composer' }}
          />
        )}
      >
        <div className={styles.messages}>
          {isCreating && (
            <div className={styles.initializing}>
              <span className={styles.spinner} aria-hidden="true" />
              <span>Starting assistant…</span>
            </div>
          )}
          {createError && <div className={styles.messageBubbleSystem}>{createError}</div>}
          {!isCreating && !createError && visibleMessages.length === 0 && (
            <div className={styles.emptyState}>
              <p className={styles.emptyTitle}>Generate test cases on demand</p>
              <p className={styles.emptyBody}>
                Ask for extra coverage in plain language, or use a shortcut below. New cases are
                traced back to their acceptance criteria and appear in the grid automatically.
              </p>
            </div>
          )}
          {visibleMessages.map((message) => {
            if (message.role === 'system') {
              return (
                <div key={message.id} className={styles.messageBubbleSystem}>{message.text}</div>
              );
            }
            if (message.role === 'user') {
              return (
                <div
                  key={message.id}
                  className={`${styles.messageBubble} ${styles.messageBubbleUser}`}
                >
                  {message.text}
                </div>
              );
            }
            return (
              <div
                key={message.id}
                className={`${styles.messageBubble} ${styles.messageBubbleAssistant}`}
              >
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown>
              </div>
            );
          })}
          {showTypingIndicator && (
            <div className={styles.typingIndicator}>
              <span className={styles.typingDot} />
              <span className={styles.typingDot} />
              <span className={styles.typingDot} />
            </div>
          )}
          {streamingText && (
            <div className={`${styles.messageBubble} ${styles.messageBubbleAssistant}`}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingText}</ReactMarkdown>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      </AgentPanelShell>
    </div>
  );
};

export default QaLabAssistantPanel;
