import React, { useRef, useEffect, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { ChatMessage } from '../../../shared/types/chat';
import { parseAgentMessage } from '../../utils/parseAgentMessage';
import { AgentMessage } from './AgentMessage';
import { AgentTypingIndicator } from './AgentTypingIndicator';
import styles from './agentChat.module.css';

export interface AgentTranscriptProps {
  /** Visible messages to render. */
  messages: ChatMessage[];
  /** Currently streaming text (partial agent response). */
  streamingText?: string;
  /** Whether the agent is currently running. */
  isRunning?: boolean;
  /** Called when user submits a choice-block answer. */
  onChoiceSubmit?: (text: string) => void;
  /** Whether all choice blocks should be locked. */
  choicesLocked?: boolean;
  /**
   * When true, only the last agent message's choices are interactive (DevSession).
   */
  interactiveLastOnly?: boolean;
  /** Message ID that should be highlighted (scroll-to from search). */
  highlightedMessageId?: string;
  /** Render prop for user messages. If omitted, renders a default user bubble. */
  renderUserMessage?: (message: ChatMessage) => React.ReactNode;
  /** Render prop for system messages. If omitted, renders a default system bubble. */
  renderSystemMessage?: (message: ChatMessage) => React.ReactNode;
  /** Whether to merge consecutive agent messages (Calendar assistant pattern). */
  mergeConsecutiveAgent?: boolean;
  /** Extra content to render at the end (e.g. retry banner). */
  footer?: React.ReactNode;
  /** Additional CSS class for the transcript container. */
  className?: string;
}

export const AgentTranscript: React.FC<AgentTranscriptProps> = ({
  messages,
  streamingText = '',
  isRunning = false,
  onChoiceSubmit,
  choicesLocked = false,
  interactiveLastOnly = false,
  highlightedMessageId,
  renderUserMessage,
  renderSystemMessage,
  mergeConsecutiveAgent = false,
  footer,
  className,
}) => {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, streamingText]);

  // When interactiveLastOnly, find the last agent message index
  const lastAgentIdx = interactiveLastOnly
    ? messages.reduce((acc, m, i) => (m.role === 'agent' ? i : acc), -1)
    : -1;

  // Optionally merge consecutive agent messages
  const processedMessages = mergeConsecutiveAgent
    ? mergeConsecutiveAgentMessages(messages)
    : messages.map((m) => ({ message: m, merged: false }));

  // Pre-compute question offsets for each agent message
  const questionOffsets = useMemo(() => {
    const offsets: Record<string, number> = {};
    let offset = 0;
    for (const { message: msg } of processedMessages) {
      if (msg.role === 'agent') {
        offsets[msg.id] = offset;
        const parts = parseAgentMessage(msg.text);
        offset += parts.filter((p) => p.type === 'choices').length;
      }
    }
    return offsets;
  }, [processedMessages]);

  return (
    <div className={`${styles.transcript} ${className ?? ''}`}>
      {processedMessages.map(({ message: msg }, idx) => {
        if (msg.role === 'user') {
          if (renderUserMessage) return <React.Fragment key={msg.id}>{renderUserMessage(msg)}</React.Fragment>;
          return (
            <div key={msg.id} className={styles.userBubble}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.text}</ReactMarkdown>
            </div>
          );
        }

        if (msg.role === 'system') {
          if (renderSystemMessage) return <React.Fragment key={msg.id}>{renderSystemMessage(msg)}</React.Fragment>;
          return (
            <div key={msg.id} className={styles.systemBubble}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.text}</ReactMarkdown>
            </div>
          );
        }

        if (msg.role === 'agent') {
          const isLastAgent = interactiveLastOnly
            ? idx === lastAgentIdx
            : true;

          return (
            <AgentMessage
              key={msg.id}
              text={msg.text}
              ts={msg.ts}
              messageId={msg.id}
              onChoiceSubmit={onChoiceSubmit}
              isRunning={isRunning}
              locked={choicesLocked}
              interactive={isLastAgent && !isRunning}
              questionOffset={questionOffsets[msg.id] ?? 0}
              highlighted={highlightedMessageId === msg.id}
            />
          );
        }

        // tool messages — render minimal or skip
        return null;
      })}

      {/* Streaming bubble */}
      {streamingText && (
        <div className={styles.agentBubble}>
          <div className={styles.agentBubbleContent}>
            <div className={styles.markdownBody}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingText}</ReactMarkdown>
            </div>
          </div>
        </div>
      )}

      {/* Typing indicator */}
      {isRunning && !streamingText && (
        <AgentTypingIndicator />
      )}

      {footer}
      <div ref={endRef} />
    </div>
  );
};

// Helper: merge consecutive agent messages into single entries
function mergeConsecutiveAgentMessages(messages: ChatMessage[]) {
  const result: { message: ChatMessage; merged: boolean }[] = [];
  for (const msg of messages) {
    if (
      msg.role === 'agent'
      && result.length > 0
      && result[result.length - 1].message.role === 'agent'
    ) {
      const prev = result[result.length - 1];
      result[result.length - 1] = {
        message: {
          ...prev.message,
          text: prev.message.text + '\n\n' + msg.text,
        },
        merged: true,
      };
    } else {
      result.push({ message: msg, merged: false });
    }
  }
  return result;
}
