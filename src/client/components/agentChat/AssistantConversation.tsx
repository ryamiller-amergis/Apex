import React, { useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { AgentRunPhase, ChatMessage } from '../../../shared/types/chat';
import type { ToolProgress } from '../../hooks/useChatStream';
import { ChatRunProgressLabel } from '../ChatRunProgressLabel';
import { AgentMessage } from './AgentMessage';
import styles from './agentChat.module.css';

export interface AssistantWelcome {
  title: string;
  description: string;
  suggestions: readonly string[];
  /** Puts the prompt in the composer; the user still sends it. */
  onSuggestion?: (prompt: string) => void;
}

export interface AssistantConversationProps {
  messages: ChatMessage[];
  streamingText: string;
  /** True while a turn is queued, starting, or running and nothing has streamed yet. */
  isWorking: boolean;
  isStarting?: boolean;
  startError?: string | null;
  progressLabel: string | null;
  progressPhase: AgentRunPhase | null;
  toolProgress?: ToolProgress[];
  welcome?: AssistantWelcome;
  /** Re-runs the failed turn; offered on the last message when it is an error. */
  onRetry?: () => void;
  testIdPrefix: string;
}

function RunProgress({
  label,
  progressPhase,
  toolProgress,
  testId,
}: {
  label: string;
  progressPhase: AgentRunPhase | null;
  toolProgress: ToolProgress[];
  testId: string;
}) {
  return (
    <div className={styles.runProgress} role="status" aria-live="polite" {...{ 'data-testid': testId }}>
      <span className={styles.runSpinner} aria-hidden="true" />
      <span className={styles.runProgressLabel}>
        {progressPhase === 'queued' ? 'Queued' : progressPhase === 'dispatched' ? 'Dispatched' : (
          <ChatRunProgressLabel
            fallbackLabel={label}
            progressPhase={progressPhase}
            toolProgress={toolProgress}
          />
        )}
      </span>
    </div>
  );
}

/**
 * Transcript for the document assistants (PRD, design doc): a welcome with
 * suggested prompts before the first turn, Home-style replies, and the live
 * run step in place of typing dots.
 */
export const AssistantConversation: React.FC<AssistantConversationProps> = ({
  messages,
  streamingText,
  isWorking,
  isStarting = false,
  startError,
  progressLabel,
  progressPhase,
  toolProgress = [],
  welcome,
  onRetry,
  testIdPrefix,
}) => {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, streamingText, isWorking]);

  const showWelcome = Boolean(welcome)
    && !isStarting
    && !startError
    && !isWorking
    && messages.length === 0
    && !streamingText;

  return (
    <div className={styles.conversation} {...{ 'data-testid': `${testIdPrefix}-conversation` }}>
      {showWelcome && welcome && (
        <div className={styles.welcome} {...{ 'data-testid': `${testIdPrefix}-welcome` }}>
          <h3 className={styles.welcomeTitle}>{welcome.title}</h3>
          <p className={styles.welcomeDescription}>{welcome.description}</p>
          {welcome.suggestions.length > 0 && (
            <div className={styles.suggestionList}>
              {welcome.suggestions.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  className={styles.suggestionBtn}
                  onClick={() => welcome.onSuggestion?.(prompt)}
                  disabled={!welcome.onSuggestion}
                  {...{ 'data-testid': `${testIdPrefix}-suggestion` }}
                >
                  {prompt}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {isStarting && (
        <RunProgress
          label="Starting assistant…"
          progressPhase={null}
          toolProgress={[]}
          testId={`${testIdPrefix}-starting`}
        />
      )}
      {startError && <div className={styles.systemBubble}>{startError}</div>}

      {messages.map((message, index) => {
        if (message.role === 'user') {
          return (
            <div key={message.id} className={styles.userBubble}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.text}</ReactMarkdown>
            </div>
          );
        }
        if (message.role === 'system') {
          const canRetry = Boolean(onRetry)
            && !isWorking
            && index === messages.length - 1
            && message.text.startsWith('Error:');
          return (
            <div
              key={message.id}
              className={styles.systemBubble}
              role={message.text.startsWith('Error:') ? 'alert' : undefined}
            >
              {message.text}
              {canRetry && (
                <button
                  type="button"
                  className={styles.retryButton}
                  onClick={onRetry}
                  {...{ 'data-testid': `${testIdPrefix}-retry` }}
                >
                  ↺ Try again
                </button>
              )}
            </div>
          );
        }
        if (message.role === 'agent') {
          return (
            <AgentMessage
              key={message.id}
              text={message.text}
              messageId={message.id}
              locked
              className={styles.assistantReply}
            />
          );
        }
        return null;
      })}

      {isWorking && !streamingText && (
        <RunProgress
          label={progressLabel ?? 'Starting agent…'}
          progressPhase={progressPhase}
          toolProgress={toolProgress}
          testId={`${testIdPrefix}-progress`}
        />
      )}

      {streamingText && (
        <div className={`${styles.agentBubble} ${styles.assistantReply}`}>
          {toolProgress.length > 0 && (
            <RunProgress
              label={progressLabel ?? 'Working…'}
              progressPhase={progressPhase}
              toolProgress={toolProgress}
              testId={`${testIdPrefix}-progress`}
            />
          )}
          <div className={styles.markdownBody}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingText}</ReactMarkdown>
          </div>
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
};
