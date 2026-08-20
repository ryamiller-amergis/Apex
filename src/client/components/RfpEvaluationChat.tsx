import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { RFP_EVALUATION_CHAT_MAX_MESSAGE_CHARS } from '../../shared/types/rfpIntake';
import { useAskRfpEvaluationChat, useRfpEvaluationChat } from '../hooks/useRfpIntake';
import styles from './RfpEvaluationCard.module.css';

interface RfpEvaluationChatProps {
  requestId: string;
}

export const RfpEvaluationChat: React.FC<RfpEvaluationChatProps> = ({ requestId }) => {
  const [draft, setDraft] = useState('');
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const chatQuery = useRfpEvaluationChat(requestId, true);
  const ask = useAskRfpEvaluationChat();
  const messages = chatQuery.data ?? [];

  useEffect(() => {
    const node = transcriptRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages.length, ask.isPending]);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const message = draft.trim();
    if (!message || ask.isPending) return;
    try {
      await ask.mutateAsync({ id: requestId, message });
      setDraft('');
    } catch {
      // Error is shown below the composer.
    }
  };

  return (
    <section className={styles.chat} {...{ 'data-testid': 'rfp-evaluation-chat' }}>
      <h3 className={styles.headline}>Ask about this evaluation</h3>
      <p className={styles.helper}>
        Probe the reasoning — for example whether a standalone SDLC build is valid.
        This does not change the verdict.
      </p>
      <div
        ref={transcriptRef}
        className={styles.transcript}
        aria-live="polite"
        {...{ 'data-testid': 'rfp-evaluation-chat-transcript' }}
      >
        {chatQuery.isLoading && <p className={styles.helper}>Loading conversation…</p>}
        {chatQuery.isError && (
          <p className={styles.error} role="alert">Could not load the conversation.</p>
        )}
        {!chatQuery.isLoading && messages.length === 0 && (
          <p className={styles.helper}>No questions yet. Ask why the evaluator made this call.</p>
        )}
        {messages.map((item) => (
          <div
            key={item.id}
            className={`${styles.bubble} ${item.role === 'user' ? styles.user : styles.assistant}`}
            {...{ 'data-testid': `rfp-evaluation-chat-${item.role}-${item.id}` }}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.body}</ReactMarkdown>
          </div>
        ))}
        {ask.isPending && (
          <p className={styles.helper} {...{ 'data-testid': 'rfp-evaluation-chat-pending' }}>
            Thinking…
          </p>
        )}
      </div>
      <form className={styles.composer} onSubmit={(event) => void onSubmit(event)} {...{ 'data-testid': 'rfp-evaluation-chat-form' }}>
        <label className={styles.helper} htmlFor="rfp-evaluation-chat-input">Question</label>
        <textarea
          id="rfp-evaluation-chat-input"
          className={styles.textarea}
          value={draft}
          maxLength={RFP_EVALUATION_CHAT_MAX_MESSAGE_CHARS}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Would a committed SDLC build as a standalone app be valid?"
          aria-label="Ask about this evaluation"
          {...{ 'data-testid': 'rfp-evaluation-chat-input' }}
        />
        {ask.isError && (
          <p className={styles.error} role="alert">
            {ask.error.message || 'Could not ask the evaluator. Try again.'}
          </p>
        )}
        <button
          type="submit"
          className={styles.primaryButton}
          disabled={ask.isPending || draft.trim() === ''}
          {...{ 'data-testid': 'rfp-evaluation-chat-submit' }}
        >
          {ask.isPending ? 'Asking…' : 'Ask'}
        </button>
      </form>
    </section>
  );
};
