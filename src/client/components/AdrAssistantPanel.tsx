import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useChatStream } from '../hooks/useChatStream';
import styles from './PrdAssistantPanel.module.css';

export interface AdrAssistantPanelProps {
  adrId: string;
  open: boolean;
  onClose: () => void;
  existingThreadId?: string | null;
}

export const AdrAssistantPanel: React.FC<AdrAssistantPanelProps> = ({
  adrId,
  open,
  onClose,
  existingThreadId,
}) => {
  const [threadId, setThreadId] = useState<string | null>(existingThreadId ?? null);
  const [input, setInput] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [showNewConfirm, setShowNewConfirm] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const queryClient = useQueryClient();
  const { messages, streamingText, status } = useChatStream(threadId);
  const isRunning = status === 'running';
  const wasRunning = useRef(false);

  const createThread = useCallback(async (forceNew = false) => {
    setIsCreating(true);
    setCreateError(null);
    try {
      const response = await fetch(`/api/adr/${adrId}/assistant-thread`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: forceNew ? JSON.stringify({ forceNew: true }) : undefined,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `Server error ${response.status}`);
      }
      const data = await response.json() as { threadId: string };
      setThreadId(data.threadId);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : 'Failed to start the ADR Assistant');
    } finally {
      setIsCreating(false);
    }
  }, [adrId]);

  useEffect(() => {
    setThreadId(existingThreadId ?? null);
  }, [existingThreadId]);

  useEffect(() => {
    if (open && !threadId && !isCreating && !createError) void createThread();
  }, [open, threadId, isCreating, createError, createThread]);

  useEffect(() => {
    if (wasRunning.current && !isRunning) {
      void queryClient.invalidateQueries({ queryKey: ['adr', adrId] });
    }
    wasRunning.current = isRunning;
  }, [adrId, isRunning, queryClient]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, streamingText]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || !threadId || isRunning || isSending) return;
    setInput('');
    setIsSending(true);
    try {
      const response = await fetch(`/api/chat/threads/${threadId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ text }),
      });
      if (!response.ok) throw new Error('Failed to send message');
    } finally {
      setIsSending(false);
    }
  }, [input, threadId, isRunning, isSending]);

  if (!open) return null;
  const visibleMessages = messages.filter((message) =>
    message.role !== 'tool' && !message.hidden && message.toolName !== '_reasoning' && message.toolName !== '_thinking');

  return (
    <>
      {showNewConfirm && (
        <div className={styles.confirmOverlay} role="dialog" aria-modal="true" aria-labelledby="adr-new-conversation-title">
          <div className={styles.confirmCard}>
            <h2 className={styles.confirmTitle} id="adr-new-conversation-title">Start new conversation?</h2>
            <p className={styles.confirmBody}>A fresh ADR refinement conversation will replace the current assistant thread.</p>
            <div className={styles.confirmActions}>
              <button className={styles.confirmBtnCancel} type="button" onClick={() => setShowNewConfirm(false)}>Cancel</button>
              <button className={styles.confirmBtnConfirm} type="button" onClick={() => {
                setShowNewConfirm(false);
                void createThread(true);
              }}>Start new</button>
            </div>
          </div>
        </div>
      )}
      <div className={styles.panel}>
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <span className={styles.title}>ADR Apex Assistant</span>
          </div>
          <div className={styles.headerActions}>
            <button className={styles.iconBtn} type="button" aria-label="New conversation" onClick={() => setShowNewConfirm(true)}>↻</button>
            <button className={styles.closeBtn} type="button" aria-label="Close assistant" onClick={onClose}>×</button>
          </div>
        </div>
        <div className={styles.messages}>
          <div className={styles.messageList}>
            {isCreating && <div className={styles.initializing}>Starting assistant…</div>}
            {createError && <div className={styles.messageBubbleSystem}>{createError}</div>}
            {visibleMessages.map((message) => (
              <div key={message.id} className={`${styles.messageBubble} ${
                message.role === 'user' ? styles.messageBubbleUser :
                message.role === 'system' ? styles.messageBubbleSystem :
                styles.messageBubbleAssistant
              }`}>
                {message.role === 'agent'
                  ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown>
                  : message.text}
              </div>
            ))}
            {isRunning && !streamingText && <div className={styles.typingIndicator}><span /><span /><span /></div>}
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
              rows={1}
              disabled={!threadId || isCreating || isRunning || isSending}
              placeholder={isRunning ? 'Assistant is investigating…' : 'Ask about refinements or trade-offs…'}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            <button className={styles.sendBtn} type="button" aria-label="Send" disabled={!input.trim() || !threadId || isRunning || isSending} onClick={() => void send()}>→</button>
          </div>
        </div>
      </div>
    </>
  );
};

export default AdrAssistantPanel;
