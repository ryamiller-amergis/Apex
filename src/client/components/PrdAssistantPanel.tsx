import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAgentChatSession } from '../hooks/useAgentChatSession';
import { AgentComposer, AgentPanelShell } from './agentChat';
import styles from './PrdAssistantPanel.module.css';

export interface PrdAssistantPanelProps {
  prdId: string;
  open: boolean;
  onClose: () => void;
  existingThreadId?: string | null;
}

const MIN_PANEL_WIDTH = 280;
const MAX_PANEL_WIDTH = 800;
const DEFAULT_PANEL_WIDTH = 380;

export const PrdAssistantPanel: React.FC<PrdAssistantPanelProps> = ({
  prdId,
  open,
  onClose,
  existingThreadId,
}) => {
  const [threadId, setThreadId] = useState<string | null>(existingThreadId ?? null);
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [showNewConvConfirm, setShowNewConvConfirm] = useState(false);
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);
  const [isDragging, setIsDragging] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const skipAutoCreateRef = useRef(false);

  const qc = useQueryClient();

  const session = useAgentChatSession(threadId);
  const { messages, streamingText, isRunning, isSending, showTypingIndicator } = session;
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
        return r.json() as Promise<{ threadId: string }>;
      })
      .then((data) => setThreadId(data.threadId))
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

  // Auto-scroll to the latest message.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, streamingText]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    await session.send(text);
  }, [input, session]);

  const visibleMessages = messages.filter((m) => m.role !== 'tool' && !m.hidden && m.toolName !== '_reasoning' && m.toolName !== '_thinking');

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
                    const data = await r.json() as { threadId: string };
                    setThreadId(data.threadId);
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
          composer={(
            <AgentComposer
              className={styles.composerEmbed}
              value={input}
              onChange={setInput}
              onSend={() => void handleSend()}
              onCancel={isRunning ? () => void session.cancel() : undefined}
              disabled={isRunning || isSending || isCreating || !threadId}
              isRunning={isRunning}
              isSending={isSending}
              placeholder={
                isCreating ? 'Starting assistant…' :
                isRunning ? 'Agent is thinking…' :
                'Ask about this PRD… (Enter to send)'
              }
              testIdPrefix="prd-assistant"
              textareaRef={textareaRef}
              {...{ 'data-testid': 'prd-assistant-composer' }}
            />
          )}
        >
          <div className={styles.messages}>
          <div className={styles.messageList}>
            {isCreating && (
              <div className={styles.initializing}>
                <div className={styles.typingIndicator}>
                  <span className={styles.typingDot} />
                  <span className={styles.typingDot} />
                  <span className={styles.typingDot} />
                </div>
                <span>Starting assistant…</span>
              </div>
            )}
            {createError && (
              <div className={styles.messageBubbleSystem}>{createError}</div>
            )}
            {visibleMessages.map((msg) => {
              if (msg.role === 'system') {
                return <div key={msg.id} className={styles.messageBubbleSystem}>{msg.text}</div>;
              }
              if (msg.role === 'user') {
                return (
                  <div key={msg.id} className={`${styles.messageBubble} ${styles.messageBubbleUser}`}>
                    {msg.text}
                  </div>
                );
              }
              return (
                <div key={msg.id} className={`${styles.messageBubble} ${styles.messageBubbleAssistant}`}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.text}</ReactMarkdown>
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
          </div>
        </AgentPanelShell>
      </div>
    </>
  );
};
