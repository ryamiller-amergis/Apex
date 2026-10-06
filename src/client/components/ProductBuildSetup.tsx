import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { z } from 'zod';
import {
  productBuildStatusLabel,
  type ProductBuildBrief,
  type ProductBuildStatus,
} from '../../shared/types/productBuild';
import type { UiLabDesign } from '../../shared/types/uiLab';
import type { UiMock, UiMockHistoryEntry } from '../../shared/types/backlog';
import { useAgentChatSession } from '../hooks/useAgentChatSession';
import { useChatThread } from '../hooks/useChatThreads';
import {
  useApproveProductBuild,
  useRegenerateProductPrototype,
  useSyncProductBuild,
  type ProductBuildSetupStatus,
} from '../hooks/useProductSetup';
import { parseAgentMessage } from '../utils/parseAgentMessage';
import { UiMockPreview } from './UiMockPreview';
import { BuildHistory } from './BuildHistory';
import styles from './ProductBuildSetup.module.css';

const PAST_APPROVAL: ReadonlySet<ProductBuildStatus> = new Set(['approved', 'building', 'pr-open', 'merged', 'failed']);

const answerSchema = z.object({
  answer: z.string().trim().min(1, 'Write an answer before sending.'),
});

type AnswerValues = z.infer<typeof answerSchema>;

export interface ProductBuildSetupProps {
  project: string;
  status: ProductBuildSetupStatus;
}

function designToUiMock(design: UiLabDesign): UiMock {
  const history: UiMockHistoryEntry[] = design.history.map((entry) => ({
    version: entry.version,
    decision: 'new-page' as const,
    rationale: design.title,
    mockHtml: entry.html,
    feedback: entry.feedback,
    createdAt: entry.createdAt,
  }));
  if (!history.some((entry) => entry.version === design.version)) {
    history.push({
      version: design.version,
      decision: 'new-page',
      rationale: design.title,
      mockHtml: design.html ?? undefined,
      createdAt: design.updatedAt,
    });
  }
  return {
    decision: 'new-page',
    rationale: design.prompt || design.title,
    targetPageTitle: design.title,
    mockHtml: design.html ?? undefined,
    mockVersion: design.version,
    status: 'draft',
    history,
  };
}

function scopeList(items: string[], testId: string) {
  return (
    <ul {...{ 'data-testid': testId }}>
      {items.length === 0 ? <li>None</li> : items.map((item) => <li key={item}>{item}</li>)}
    </ul>
  );
}

function DiscoveryAgentMessage({
  text,
  disabled,
  onAnswer,
}: {
  text: string;
  disabled: boolean;
  onAnswer: (answer: string) => void;
}) {
  const parts = parseAgentMessage(text);

  return (
    <>
      {parts.map((part) => {
        if (part.type === 'markdown') {
          return <ReactMarkdown key={part.id} remarkPlugins={[remarkGfm]}>{part.content}</ReactMarkdown>;
        }
        return (
          <section key={part.id} className={styles.choiceBlock}>
            {part.question && (
              <div className={styles.choiceQuestion}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{part.question}</ReactMarkdown>
              </div>
            )}
            <div className={styles.choiceOptions}>
              {part.options.map((option) => (
                <button
                  key={option.letter}
                  type="button"
                  className={styles.choiceOption}
                  disabled={disabled}
                  onClick={() => onAnswer(`${option.letter.toUpperCase()} — ${option.text}`)}
                  {...{ 'data-testid': `product-build-choice-${option.letter}` }}
                >
                  <span className={styles.choiceLetter}>{option.letter.toUpperCase()}</span>
                  <span>{option.text}</span>
                </button>
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}

export const ProductBuildSetup: React.FC<ProductBuildSetupProps> = ({ project, status }) => {
  const [feedback, setFeedback] = useState('');
  const wasRunningRef = useRef(false);
  const threadQuery = useChatThread(status.chatThreadId);
  const syncBuild = useSyncProductBuild(project);
  const regenerateBuild = useRegenerateProductPrototype(project);
  const approveBuild = useApproveProductBuild(project);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<AnswerValues>({
    resolver: zodResolver(answerSchema),
    defaultValues: { answer: '' },
  });
  const session = useAgentChatSession(status.chatThreadId, {
    initialMessages: threadQuery.data?.messages,
    initialStatus: threadQuery.data?.status,
    enablePreparationState: true,
  });

  const build = status.build;
  const brief = build.brief;
  const design = status.design;
  const designReady = design?.status === 'ready' && Boolean(design.html?.trim());
  const pastApproval = PAST_APPROVAL.has(build.status) || build.approvedAt != null;
  const generationFailed = design?.status === 'generation_failed';
  const actionError = approveBuild.error?.message
    || regenerateBuild.error?.message
    || syncBuild.error?.message
    || build.errorMessage
    || (generationFailed ? (design?.generationError || 'The prototype could not be generated.') : null);
  const showChat = !brief && !pastApproval;
  const showGenerating = Boolean(brief)
    && !designReady
    && !pastApproval
    && !actionError
    && (
      build.status === 'prototype'
      || build.status === 'brief-confirmed'
      || design?.status === 'generating'
      || design?.status === 'streaming'
    );
  const showPrototype = designReady && !pastApproval;
  const busy = syncBuild.isPending
    || regenerateBuild.isPending
    || approveBuild.isPending
    || session.isInteractionBusy;
  const turnRunning = session.isRunning || session.isAwaitingAgentResponse;

  const syncMutate = syncBuild.mutate;
  const sendMessage = session.send;

  const submitAnswer = useCallback((values: AnswerValues) => {
    void sendMessage(values.answer).then(() => reset({ answer: '' }));
  }, [reset, sendMessage]);

  useEffect(() => {
    if (wasRunningRef.current && !session.isRunning && !brief) {
      syncMutate(build.id);
    }
    wasRunningRef.current = session.isRunning;
  }, [brief, build.id, session.isRunning, syncMutate]);

  const retryAction = () => {
    if (approveBuild.error) {
      approveBuild.mutate(build.id);
      return;
    }
    if (regenerateBuild.error) {
      regenerateBuild.mutate({ buildId: build.id, feedback });
      return;
    }
    syncMutate(build.id);
  };

  const guidance = approveBuild.error
    ? 'Approval did not start the build. Try again.'
    : regenerateBuild.error
      ? 'The preview was not updated. Describe the change and try again.'
      : 'Try again. Your place in this build is saved.';

  const visibleMessages = session.visibleMessages.filter((message) =>
    message.role !== 'tool' && !message.hidden && message.toolName !== '_reasoning' && message.toolName !== '_thinking');
  const latestAgentMessageId = [...visibleMessages]
    .reverse()
    .find((message) => message.role === 'agent')?.id;

  const currentRequest = (status.history ?? []).find((item) => item.id === build.id)?.request ?? '';
  const heading = build.kind === 'initial'
    ? "Let's plan your app"
    : (currentRequest || "Let's plan your app");

  return (
    <section className={styles.panel} {...{ 'data-testid': 'product-build-setup' }}>
      <header>
        <h1 className={styles.heading}>{heading}</h1>
        <p className={styles.northStar} {...{ 'data-testid': 'product-build-intro' }}>
          We'll ask a few questions, then show you a preview of this build.
        </p>
      </header>

      {actionError && (
        <div className={styles.error} role="alert" {...{ 'data-testid': 'product-build-error' }}>
          <p>{actionError}</p>
          <p className={styles.guidance} {...{ 'data-testid': 'product-build-error-guidance' }}>{guidance}</p>
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={retryAction}
            {...{ 'data-testid': 'product-build-error-retry' }}
          >
            Try again
          </button>
        </div>
      )}

      {showChat && (
        <div className={styles.messages} {...{ 'data-testid': 'product-build-messages' }}>
          {visibleMessages.map((message) => (
            <article
              key={message.id}
              className={message.role === 'user' ? styles.userMessage : styles.agentMessage}
              {...{ 'data-testid': `product-build-message-${message.id}` }}
            >
              {message.role === 'agent'
                ? (
                  <DiscoveryAgentMessage
                    text={message.text}
                    disabled={busy || message.id !== latestAgentMessageId}
                    onAnswer={(answer) => { void sendMessage(answer); }}
                  />
                )
                : message.text}
            </article>
          ))}
          {session.streamingText && (
            <p className={styles.streaming} aria-live="polite" {...{ 'data-testid': 'product-build-streaming' }}>
              {session.streamingText}
            </p>
          )}
          {session.progressLabel && (
            <p className={styles.progress} role="status" {...{ 'data-testid': 'product-build-progress' }}>
              {session.progressLabel}
            </p>
          )}
        </div>
      )}

      {showChat && session.sendError && (
        <p className={styles.error} role="alert" {...{ 'data-testid': 'product-build-send-error' }}>
          {session.sendError}
        </p>
      )}

      {showChat && (
        <form
          className={styles.form}
          onSubmit={(event) => {
            if (turnRunning) {
              event.preventDefault();
              return;
            }
            void handleSubmit(submitAnswer)(event);
          }}
          {...{ 'data-testid': 'product-build-answer-form' }}
        >
          <label className={styles.label} htmlFor="product-build-answer">Answer</label>
          <textarea
            id="product-build-answer"
            className={styles.answer}
            rows={3}
            placeholder="Answer the latest question"
            disabled={turnRunning || session.isSending}
            {...register('answer')}
            {...{ 'data-testid': 'product-build-answer' }}
          />
          {errors.answer && (
            <p className={styles.fieldError} role="alert">{errors.answer.message}</p>
          )}
          <div className={styles.actions}>
            {(session.sendError || session.hasConnectionError) && (
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => session.retryLast()}
                {...{ 'data-testid': 'product-build-retry' }}
              >
                Retry
              </button>
            )}
            {turnRunning ? (
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => { void session.cancel(); }}
                {...{ 'data-testid': 'product-build-stop' }}
              >
                Stop
              </button>
            ) : (
              <button
                type="submit"
                className={styles.primaryButton}
                disabled={session.isSending}
                {...{ 'data-testid': 'product-build-send' }}
              >
                Send
              </button>
            )}
          </div>
        </form>
      )}

      {brief && (showGenerating || showPrototype || pastApproval) && (
        <div className={showPrototype ? styles.reviewLayout : undefined}>
          <BuildScope brief={brief} />
          <div>
            {showGenerating && (
              <div
                className={styles.generating}
                role="status"
                aria-live="polite"
                aria-busy="true"
                {...{ 'data-testid': 'product-build-generating' }}
              >
                <span className={styles.dots} aria-hidden="true"><span /><span /><span /></span>
                <div className={styles.generatingText}>
                  <strong>Creating the prototype</strong>
                  <span>The build brief is set. The interactive prototype is being generated.</span>
                </div>
              </div>
            )}
            {showPrototype && design && (
              <UiMockPreview
                mock={designToUiMock(design)}
                feedback={feedback}
                onFeedbackChange={setFeedback}
                onRegenerate={() => regenerateBuild.mutate({ buildId: build.id, feedback })}
                isBusy={regenerateBuild.isPending || approveBuild.isPending}
              />
            )}
            {(showGenerating || showPrototype) && (
              <div className={styles.approveRow}>
                <button
                  type="button"
                  className={`${styles.primaryButton} ${styles.approveButton}`}
                  disabled={!designReady || busy}
                  onClick={() => approveBuild.mutate(build.id)}
                  {...{ 'data-testid': 'product-build-approve' }}
                >
                  Build this
                </button>
                <p className={styles.note} {...{ 'data-testid': 'product-build-approve-note' }}>
                  We'll build this and let you know when it's ready to review.
                </p>
              </div>
            )}
            {pastApproval && (
              <BuildOutcome status={build.status} />
            )}
          </div>
        </div>
      )}
      <BuildHistory history={status.history ?? []} />
    </section>
  );
};

const BuildScope: React.FC<{ brief: ProductBuildBrief }> = ({ brief }) => (
  <aside className={styles.scope} {...{ 'data-testid': 'product-build-scope' }}>
    <h2>This build</h2>
    <p className={styles.summary} {...{ 'data-testid': 'product-build-summary' }}>{brief.initialBuild.summary}</p>
    <h3>Out of scope</h3>
    {scopeList(brief.initialBuild.outOfScope, 'product-build-out-of-scope')}
    <h3>Deferred</h3>
    {scopeList(brief.initialBuild.deferred, 'product-build-deferred')}
  </aside>
);

const BuildOutcome: React.FC<{ status: ProductBuildStatus }> = ({ status }) => (
  <section className={styles.outcome} {...{ 'data-testid': 'product-build-outcome' }}>
    <h2>{productBuildStatusLabel(status)}</h2>
  </section>
);
