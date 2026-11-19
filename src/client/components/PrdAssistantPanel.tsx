import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useQueryClient } from '@tanstack/react-query';
import { useAgentChatSession } from '../hooks/useAgentChatSession';
import { useChatAttachments } from '../hooks/useChatAttachments';
import {
  AgentHarnessPanel,
  AgentMessage,
  AgentPanelShell,
  AgentThoughtProcess,
  AssistantConversation,
} from './agentChat';
import chatStyles from './agentChat/agentChat.module.css';
import styles from './PrdAssistantPanel.module.css';

const PRD_ASSISTANT_SUGGESTIONS = [
  'Summarize the open review comments',
  "What's missing before this PRD is ready for review?",
  'Tighten the acceptance criteria for the weakest PBI',
  'Add a test case for a PBI',
] as const;

interface AssistantThreadResponse {
  threadId: string;
  created?: boolean;
}

export interface PrdAssistantPanelProps {
  prdId: string;
  open: boolean;
  onClose: () => void;
  existingThreadId?: string | null;
  /** Optional PRD diff review controls rendered in the AgentHarnessPanel proposal slot (BR-001). */
  proposal?: React.ReactNode;
}

const MIN_PANEL_WIDTH = 280;
const MAX_PANEL_WIDTH = 800;
const DEFAULT_PANEL_WIDTH = 380;

export const PrdAssistantPanel: React.FC<PrdAssistantPanelProps> = ({
  prdId,
  open,
  onClose,
  existingThreadId,
  proposal,
}) => {
  const [threadId, setThreadId] = useState<string | null>(existingThreadId ?? null);
  // Only a thread this panel just created is known to be empty; an existing
  // thread's history arrives over SSE after the panel renders.
  const [createdThreadId, setCreatedThreadId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [showNewConvConfirm, setShowNewConvConfirm] = useState(false);
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);
  const [isDragging, setIsDragging] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const skipAutoCreateRef = useRef(false);

  const qc = useQueryClient();

  const session = useAgentChatSession(threadId, {
    harnessArea: 'prd-assistant',
    area: 'prd-assistant',
  });
  const {
    attachments,
    attachmentError,
    addFiles,
    removeAttachment,
    clearAttachments,
  } = useChatAttachments();
  const {
    messages,
    streamingText,
    isRunning,
    isSending,
    progressLabel,
    progressPhase,
    toolProgress,
  } = session;
  const wasRunningRef = useRef(false);

  // When the assistant finishes a run, invalidate the PRD, generated test
  // cases, and review comments so the main pane picks up any changes from
  // update_prd / add_test_case / resolve_prd_comment without a manual reload.
  useEffect(() => {
    if (wasRunningRef.current && !isRunning) {
      void qc.invalidateQueries({ queryKey: ['prd', prdId] });
      void qc.invalidateQueries({ queryKey: ['prd-test-cases', prdId] });
      void qc.invalidateQueries({ queryKey: ['review-comments', 'prd', prdId] });
      void qc.invalidateQueries({ queryKey: ['unresolved-comment-count', 'prd', prdId] });
    }
    wasRunningRef.current = isRunning;
  }, [isRunning, qc, prdId]);

  // Auto-create thread when the panel is open and no thread exists yet.
  useEffect(() => {
    if (!open) return;
    if (threadId) return;
    if (skipAutoCreateRef.current) {
      skipAutoCreateRef.current = false;
      return;
    }
    setIsCreating(true);
    setCreateError(null);
    fetch(`/api/interviews/prds/${prdId}/assistant-thread`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
    })
      .then(async (r) => {
        if (!r.ok) {
          let msg = `Server error ${r.status}`;
          try { const body = await r.json() as { error?: string }; if (body.error) msg = body.error; } catch { /* non-JSON body */ }
          throw new Error(msg);
        }
        return r.json() as Promise<AssistantThreadResponse>;
      })
      .then((data) => {
        setThreadId(data.threadId);
        if (data.created) setCreatedThreadId(data.threadId);
      })
      .catch((err: unknown) => setCreateError(err instanceof Error ? err.message : 'Failed to start assistant. Please try again.'))
      .finally(() => setIsCreating(false));
  }, [open, prdId, threadId]);

  // Horizontal resize via drag handle on the left edge of the panel.
  const dragStartXRef = useRef(0);
  const dragStartWidthRef = useRef(DEFAULT_PANEL_WIDTH);

  const handleResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragStartXRef.current = e.clientX;
    dragStartWidthRef.current = panelWidth;
    setIsDragging(true);
  }, [panelWidth]);

  useEffect(() => {
    if (!isDragging) return;
    const onMouseMove = (e: MouseEvent) => {
      const delta = dragStartXRef.current - e.clientX;
      const next = Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, dragStartWidthRef.current + delta));
      setPanelWidth(next);
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

  const handleAttachmentChange = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    await addFiles(event.currentTarget.files);
    event.currentTarget.value = '';
  }, [addFiles]);

  const handleSend = useCallback(async (textFromHarness: string) => {
    const text = textFromHarness.trim();
    const outgoing = [...attachments];
    if (!text && outgoing.length === 0) return false;
    const message = text || 'Please use the attached files as additional context.';
    const sent = await session.send(
      message,
      outgoing.length > 0 ? { attachments: outgoing } : undefined,
    );
    if (sent && outgoing.length > 0) clearAttachments();
    return sent;
  }, [attachments, clearAttachments, session]);

  const rawMessages = session.visibleMessages ?? messages;
  const visibleMessages = useMemo(
    () =>
      rawMessages.filter(
        (m) =>
          m.role !== 'tool' &&
          !m.hidden &&
          m.toolName !== '_reasoning' &&
          m.toolName !== '_thinking',
      ),
    [rawMessages],
  );

  const harnessSession = useMemo(
    () => ({
      ...session,
      visibleMessages,
      snapshotLoaded:
        !threadId || Boolean(createError) || threadId === createdThreadId
          ? true
          : session.snapshotLoaded,
    }),
    [session, visibleMessages, threadId, createError, createdThreadId],
  );

  const cachedPrd = qc.getQueryData<{
    proposedContent?: string | null;
    proposedBacklogJson?: string | null;
  }>(['prd', prdId]);
  const hasCachedProposal = Boolean(
    cachedPrd &&
      (cachedPrd.proposedContent != null || cachedPrd.proposedBacklogJson != null),
  );
  const resolvedProposal =
    proposal ??
    (hasCachedProposal ? (
      <div {...{ 'data-testid': 'prd-assistant-proposal-notice' }}>
        Proposed PRD changes are ready for your review. Accept or reject them in the document review banner — edits are never applied automatically.
      </div>
    ) : undefined);

  if (!open) return null;

  return (
    <>
      {showNewConvConfirm && (
        <div
          className={styles.confirmOverlay}
          onClick={(e) => { if (e.target === e.currentTarget) setShowNewConvConfirm(false); }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="prd-new-conv-confirm-title"
          {...{ 'data-testid': 'prd-assistant-new-confirm-dialog' }}
        >
          <div className={styles.confirmCard}>
            <div className={styles.confirmIconWrap} aria-hidden="true">
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M13 3v4H9" /><path d="M13 7A6 6 0 1 1 9.5 2.5" />
              </svg>
            </div>
            <h2 className={styles.confirmTitle} id="prd-new-conv-confirm-title">Start new conversation?</h2>
            <p className={styles.confirmBody}>The current thread will be cleared and a fresh session with Apex will begin.</p>
            <div className={styles.confirmActions}>
              <button
                className={styles.confirmBtnCancel}
                onClick={() => setShowNewConvConfirm(false)}
                type="button"
                {...{ 'data-testid': 'prd-assistant-new-confirm-cancel' }}
              >
                Cancel
              </button>
              <button
                className={styles.confirmBtnConfirm}
                onClick={async () => {
                  setShowNewConvConfirm(false);
                  skipAutoCreateRef.current = true;
                  setThreadId(null);
                  setCreateError(null);
                  setIsCreating(true);
                  try {
                    const r = await fetch(`/api/interviews/prds/${prdId}/assistant-thread`, {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      credentials: 'include',
                      body: JSON.stringify({ forceNew: true }),
                    });
                    if (!r.ok) {
                      let msg = `Server error ${r.status}`;
                      try { const body = await r.json() as { error?: string }; if (body.error) msg = body.error; } catch { /* non-JSON */ }
                      throw new Error(msg);
                    }
                    const data = await r.json() as AssistantThreadResponse;
                    setThreadId(data.threadId);
                    if (data.created) setCreatedThreadId(data.threadId);
                  } catch (err) {
                    setCreateError(err instanceof Error ? err.message : 'Failed to start new conversation. Please try again.');
                  } finally {
                    setIsCreating(false);
                  }
                }}
                type="button"
                {...{ 'data-testid': 'prd-assistant-new-confirm-start' }}
              >
                Start new
              </button>
            </div>
          </div>
        </div>
      )}

      <div {...{ 'data-testid': 'prd-assistant-panel' }}>
        <AgentPanelShell
          title="Apex Assistant"
          ariaLabel="PRD assistant panel"
          onClose={onClose}
          closeAriaLabel="Close assistant"
          closeTestId="prd-assistant-close-btn"
          width={panelWidth}
          onResizeMouseDown={handleResizeMouseDown}
          actions={(
            <button
              className={styles.iconBtn}
              onClick={() => setShowNewConvConfirm(true)}
              type="button"
              title="New conversation"
              aria-label="New conversation"
              {...{ 'data-testid': 'prd-assistant-new-btn' }}
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M13 3v4H9" /><path d="M13 7A6 6 0 1 1 9.5 2.5" />
              </svg>
            </button>
          )}
        >
          <AgentHarnessPanel
            area="prd-assistant"
            session={harnessSession}
            testIdPrefix="prd-assistant"
            draft={input}
            onDraftChange={setInput}
            onSend={handleSend}
            slots={resolvedProposal ? { proposal: resolvedProposal } : undefined}
            fallbackProgressLabel="Starting agent…"
            composer={{
              allowEmptySend: true,
              disabled: isCreating || !threadId,
              placeholder: isCreating
                ? 'Starting assistant…'
                : isRunning
                  ? 'Steer the agent… (Enter to steer)'
                  : 'Ask about this PRD… (Enter to send)',
              textareaRef,
              attachments,
              attachmentError,
              onRemoveAttachment: removeAttachment,
              onAttachClick: () => fileInputRef.current?.click(),
              onPasteFiles: (files) => { void addFiles(files); },
              fileInput: (
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  hidden
                  onChange={(event) => { void handleAttachmentChange(event); }}
                  disabled={isRunning || isSending || isCreating || !threadId}
                  {...{ 'data-testid': 'prd-assistant-file-input' }}
                />
              ),
            }}
            renderTranscript={({ items, isWorking, liveWorkBox, streamingPreview, messageFailure }) => {
              const showAssistantChrome =
                isCreating ||
                Boolean(createError) ||
                (items.length === 0 && !isWorking && !streamingText && !messageFailure);

              if (showAssistantChrome) {
                return (
                  <AssistantConversation
                    messages={[]}
                    streamingText=""
                    isWorking={false}
                    isStarting={isCreating}
                    startError={createError}
                    progressLabel={progressLabel}
                    progressPhase={progressPhase}
                    toolProgress={toolProgress}
                    welcome={
                      threadId && threadId === createdThreadId
                        ? {
                            title: 'Ask about this PRD',
                            description:
                              'Apex can answer questions, edit the PRD or backlog, add test cases, and resolve review comments. Edits come back as a proposed change for the owner to accept.',
                            suggestions: PRD_ASSISTANT_SUGGESTIONS,
                            onSuggestion: fillComposer,
                          }
                        : undefined
                    }
                    testIdPrefix="prd-assistant"
                  />
                );
              }

              return (
                <div
                  className={chatStyles.conversation}
                  {...{ 'data-testid': 'prd-assistant-conversation' }}
                >
                  {items.map((item) => {
                    if (item.role === 'user') {
                      return (
                        <div key={item.id} data-message-id={item.id} className={chatStyles.userBubble}>
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text}</ReactMarkdown>
                          {item.failed ? (
                            <span
                              className={chatStyles.messageFailureBadge}
                              {...{ 'data-testid': `prd-assistant-message-failed-${item.id}` }}
                            >
                              Failed
                            </span>
                          ) : null}
                        </div>
                      );
                    }
                    if (item.role === 'system') {
                      return (
                        <div key={item.id} data-message-id={item.id} className={chatStyles.systemBubble}>
                          {item.text}
                        </div>
                      );
                    }
                    if (item.role === 'agent') {
                      return (
                        <div key={item.id} data-message-id={item.id}>
                          {item.activity?.length || item.activityUnavailable ? (
                            <AgentThoughtProcess
                              items={item.activity}
                              isUnavailable={item.activityUnavailable}
                              testIdPrefix="prd-assistant"
                              testIds={{
                                drawer: 'prd-assistant-thought-process',
                                toggle: 'prd-assistant-thought-process-toggle',
                                thinking: `prd-assistant-saved-thinking-${item.id}`,
                                steps: `prd-assistant-saved-steps-${item.id}`,
                                toolGroup: `prd-assistant-saved-tool-group-${item.id}`,
                              }}
                            />
                          ) : null}
                          <AgentMessage
                            text={item.text}
                            ts={item.ts}
                            messageId={item.id}
                            locked
                            className={chatStyles.assistantReply}
                          />
                        </div>
                      );
                    }
                    return null;
                  })}
                  {liveWorkBox}
                  {streamingPreview}
                  {messageFailure}
                </div>
              );
            }}
            {...{ 'data-testid': 'prd-assistant-harness-panel' }}
          />
        </AgentPanelShell>
      </div>
    </>
  );
};
