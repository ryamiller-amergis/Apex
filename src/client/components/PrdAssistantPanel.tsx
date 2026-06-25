import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useChatStream } from '../hooks/useChatStream';
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
  const [isSending, setIsSending] = useState(false);
  const [showNewConvConfirm, setShowNewConvConfirm] = useState(false);
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);
  const [isDragging, setIsDragging] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const skipAutoCreateRef = useRef(false);

  const qc = useQueryClient();

  const { messages, streamingText, status: threadStatus } = useChatStream(threadId);
  const isRunning = threadStatus === 'running';
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

  // Auto-resize the textarea as the user types.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [input]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isRunning || isSending || !threadId) return;
    setInput('');
    setIsSending(true);
    try {
      await fetch(`/api/chat/threads/${threadId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ text }),
      });
    } finally {
      setIsSending(false);
    }
  }, [input, isRunning, isSending, threadId]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }, [handleSend]);

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
              >
                Start new
              </button>
            </div>
          </div>
        </div>
      )}

      <div className={styles.panel} style={{ width: panelWidth }}>
        <div
          className={`${styles.resizeHandle} ${isDragging ? styles.resizeHandleDragging : ''}`}
          onMouseDown={handleResizeMouseDown}
          role="separator"
          aria-label="Resize panel"
          aria-orientation="vertical"
        />

        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <span className={styles.title}>Apex Assistant</span>
          </div>
          <div className={styles.headerActions}>
            <button
              className={styles.iconBtn}
              onClick={() => setShowNewConvConfirm(true)}
              type="button"
              title="New conversation"
              aria-label="New conversation"
            >
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M13 3v4H9" /><path d="M13 7A6 6 0 1 1 9.5 2.5" />
              </svg>
            </button>
            <button
              className={styles.closeBtn}
              onClick={onClose}
              type="button"
              aria-label="Close assistant"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path d="M1 1l12 12M13 1L1 13" />
              </svg>
            </button>
          </div>
        </div>

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
            {isRunning && !streamingText && (
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

        <div className={styles.inputArea}>
          <div className={styles.inputBox}>
            <textarea
              ref={textareaRef}
              className={styles.inputField}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                isCreating ? 'Starting assistant…' :
                isRunning ? 'Agent is thinking…' :
                'Ask about this PRD… (Enter to send)'
              }
              rows={1}
              disabled={isRunning || isSending || isCreating || !threadId}
            />
            <button
              className={styles.sendBtn}
              onClick={() => void handleSend()}
              disabled={!input.trim() || isRunning || isSending || isCreating || !threadId}
              type="button"
              aria-label="Send"
            >
              <svg viewBox="0 0 20 20" fill="currentColor">
                <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </>
  );
};
