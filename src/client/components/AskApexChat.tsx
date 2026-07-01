import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useAskApex } from '../hooks/useAskApex';
import type { AskApexMessage } from '../hooks/useAskApex';
import styles from './AskApexChat.module.css';

const WELCOME_MESSAGE = "Hi! I'm the Apex product assistant. Ask me anything about the application — features, workflows, how things work, or what's planned.";

interface AskApexChatProps {
  onClose: () => void;
}

export const AskApexChat: React.FC<AskApexChatProps> = ({ onClose }) => {
  const [inputText, setInputText] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { messages, streamingText, status, startSession, sendMessage, closeSession } = useAskApex();

  useEffect(() => {
    startSession();
    return () => { closeSession(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingText]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSend = useCallback(() => {
    const text = inputText.trim();
    if (!text || status === 'streaming') return;
    setInputText('');
    sendMessage(text);
  }, [inputText, status, sendMessage]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const handleClose = useCallback(() => {
    closeSession();
    onClose();
  }, [closeSession, onClose]);

  const isStreaming = status === 'streaming';

  return (
    <>
      <div className={styles.overlay} onClick={handleClose} aria-hidden="true" />
      <div className={styles['chat-window']} role="dialog" aria-label="Ask Apex Chat">
        <div className={styles.header}>
          <span className={styles['header-title']}>
            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z" />
            </svg>
            Ask Apex
          </span>
          <button
            className={styles['close-btn']}
            onClick={handleClose}
            type="button"
            aria-label="Close chat"
          >
            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" />
            </svg>
          </button>
        </div>

        <div className={styles.messages}>
          <div className={`${styles.message} ${styles['message-welcome']}`}>
            {WELCOME_MESSAGE}
          </div>
          {messages.map((msg: AskApexMessage) => (
            <div
              key={msg.id}
              className={`${styles.message} ${
                msg.role === 'user' ? styles['message-user'] : styles['message-assistant']
              }`}
            >
              {msg.text}
            </div>
          ))}
          {isStreaming && streamingText && (
            <div className={styles['streaming-indicator']}>
              {streamingText}
            </div>
          )}
          {isStreaming && !streamingText && (
            <div className={styles['typing-dots']}>
              <span />
              <span />
              <span />
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className={styles['input-area']}>
          <textarea
            ref={inputRef}
            className={styles['input-field']}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a question..."
            rows={1}
            disabled={isStreaming}
          />
          <button
            className={styles['send-btn']}
            onClick={handleSend}
            disabled={!inputText.trim() || isStreaming}
            type="button"
            aria-label="Send message"
          >
            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
            </svg>
          </button>
        </div>
      </div>
    </>
  );
};
