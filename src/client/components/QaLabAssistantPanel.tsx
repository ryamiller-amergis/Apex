import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAgentChatSession } from '../hooks/useAgentChatSession';
import { useAvailableModels, useGlobalDefaultModel } from '../hooks/useProjectSkillConfig';
import { AgentComposer, AgentPanelShell, AssistantConversation } from './agentChat';
import styles from './QaLabAssistantPanel.module.css';

/** What owns the cases in view; the assistant thread is scoped to it. */
export type QaLabAssistantTarget =
  | { kind: 'prd'; prdId: string }
  | { kind: 'suite'; suiteId: string };

export interface QaLabAssistantPanelProps {
  target: QaLabAssistantTarget;
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

const PRD_SUGGESTIONS = [
  'Add cases for any acceptance criterion or business rule with no coverage yet',
  'Add negative and authorization cases where the actor is blocked or the input is invalid',
  'Add boundary and edge cases for limits, empty states, and maximum values',
] as const;

const SUITE_SUGGESTIONS = [
  'Review the unpublished cases against the skill and list the problems by case id. Do not change anything yet.',
  'Add a case for each acceptance criterion that no case covers yet',
  'Make each login step sign in as the role the case tests, and move other roles\' setup into the precondition step',
] as const;

interface TargetConfig {
  title: string;
  threadUrl: string;
  storageKey: string | null;
  suggestions: readonly string[];
  invalidateKeys: unknown[][];
  welcomeTitle: string;
  welcomeBody: string;
  placeholder: string;
}

function configFor(target: QaLabAssistantTarget): TargetConfig {
  switch (target.kind) {
    case 'prd':
      return {
        title: 'QA Assistant',
        // The PRD assistant thread carries the add_test_case tool, so QA Lab reuses it.
        threadUrl: `/api/interviews/prds/${target.prdId}/assistant-thread`,
        storageKey: null,
        suggestions: PRD_SUGGESTIONS,
        invalidateKeys: [['prd-test-cases', target.prdId], ['qa-lab']],
        welcomeTitle: 'Generate test cases on demand',
        welcomeBody: 'Ask for extra coverage in plain language, or use a shortcut below. New cases are traced back to their acceptance criteria and appear in the grid automatically.',
        placeholder: 'Ask for more test cases… (Enter to send)',
      };
    case 'suite':
      return {
        title: 'Ask Apex',
        threadUrl: `/api/interviews/ado-test-suites/${target.suiteId}/assistant-thread`,
        storageKey: `qa-lab-assistant-thread:${target.suiteId}`,
        suggestions: SUITE_SUGGESTIONS,
        invalidateKeys: [['qa-lab']],
        welcomeTitle: 'Change these cases in plain language',
        welcomeBody: 'Ask Apex can explain, edit, add, delete, comment on, or regenerate the unpublished cases. Edits show what changed on the case and can be restored. Publishing stays with you.',
        placeholder: 'Ask Apex to change the cases… (Enter to send)',
      };
    default: {
      const unhandled: never = target;
      return unhandled;
    }
  }
}

function readStoredThread(key: string | null): string | null {
  if (!key) return null;
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function storeThread(key: string | null, threadId: string): void {
  if (!key) return;
  try {
    window.sessionStorage.setItem(key, threadId);
  } catch { /* storage unavailable */ }
}

export const QaLabAssistantPanel: React.FC<QaLabAssistantPanelProps> = ({
  target,
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

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const wasRunningRef = useRef(false);
  const dragStartXRef = useRef(0);
  const dragStartWidthRef = useRef(DEFAULT_PANEL_WIDTH);

  const config = configFor(target);
  const { threadUrl, storageKey, invalidateKeys } = config;
  const queryClient = useQueryClient();
  const { data: availableModels, isLoading: modelsLoading } = useAvailableModels();
  const { data: globalDefaultModel } = useGlobalDefaultModel();

  const session = useAgentChatSession(threadId);
  const {
    messages,
    streamingText,
    isRunning,
    isSending,
    showTypingIndicator,
    progressLabel,
    progressPhase,
    toolProgress,
  } = session;

  // Seed the picker from the global default once models resolve.
  useEffect(() => {
    if (selectedModel) return;
    const fallback = globalDefaultModel?.value ?? availableModels?.[0]?.id;
    if (fallback) setSelectedModel(fallback);
  }, [selectedModel, globalDefaultModel?.value, availableModels]);

  // A finished run may have changed cases through its tools — refetch the grid.
  useEffect(() => {
    if (wasRunningRef.current && !isRunning) {
      for (const queryKey of invalidateKeys) void queryClient.invalidateQueries({ queryKey });
      onRunComplete?.();
    }
    wasRunningRef.current = isRunning;
  }, [isRunning, queryClient, invalidateKeys, onRunComplete]);

  useEffect(() => {
    if (!open || threadId) return;
    setIsCreating(true);
    setCreateError(null);
    const storedThreadId = readStoredThread(storageKey);
    fetch(threadUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      ...(storageKey ? { body: JSON.stringify({ threadId: storedThreadId }) } : {}),
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
      .then((data) => {
        storeThread(storageKey, data.threadId);
        setThreadId(data.threadId);
      })
      .catch((err: unknown) =>
        setCreateError(
          err instanceof Error ? err.message : 'Could not start the assistant. Please try again.',
        ),
      )
      .finally(() => setIsCreating(false));
  }, [open, threadUrl, storageKey, threadId]);

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

  const fillComposer = useCallback((prompt: string) => {
    setInput(prompt);
    textareaRef.current?.focus();
  }, []);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    await session.send(text, selectedModel ? { model: selectedModel } : undefined);
  }, [input, session, selectedModel]);

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
        title={config.title}
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
                  : config.placeholder
            }
            testIdPrefix="qa-lab-assistant"
            textareaRef={textareaRef}
            model={selectedModel}
            models={availableModels}
            modelsLoading={modelsLoading}
            onModelChange={setSelectedModel}
            {...{ 'data-testid': 'qa-lab-assistant-composer' }}
          />
        )}
      >
        <AssistantConversation
          messages={visibleMessages}
          streamingText={streamingText}
          isWorking={showTypingIndicator}
          isStarting={isCreating}
          startError={createError}
          progressLabel={progressLabel}
          progressPhase={progressPhase}
          toolProgress={toolProgress}
          welcome={{
            title: config.welcomeTitle,
            description: config.welcomeBody,
            suggestions: config.suggestions,
            onSuggestion: fillComposer,
          }}
          testIdPrefix="qa-lab-assistant"
        />
      </AgentPanelShell>
    </div>
  );
};

export default QaLabAssistantPanel;
