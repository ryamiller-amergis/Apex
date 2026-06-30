import React, { useState, useRef, useEffect, useCallback, Suspense, lazy } from 'react';
import { useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useChatThread, useSendMessage } from '../hooks/useChatThreads';
import { useChatStream } from '../hooks/useChatStream';
import { useAppShell } from '../hooks/useAppShell';
import { useSpeechInput } from '../hooks/useSpeechInput';
import type { WorkItem } from '../types/workitem';
import styles from './StandupCeremonyView.module.css';

const DetailsPanel = lazy(() => import('./DetailsPanel').then(m => ({ default: m.DetailsPanel })));

interface MySessionResponse {
  participantId: string;
  sessionId: string;
  threadId: string;
  status: string;
  sessionDate: string;
  sessionStatus: string;
}

const StandupSubNav: React.FC<{ active: 'standup' | 'standup-summary' | 'standup-manage' }> = ({ active }) => {
  const navigate = useNavigate();
  const { can } = useAppShell();
  return (
    <div className={styles.subNav}>
      <button
        className={`${styles.subNavBtn} ${active === 'standup' ? styles.subNavActive : ''}`}
        onClick={() => navigate('/standup')}
      >
        My Standup
      </button>
      {can('standup:participate') && (
        <button
          className={`${styles.subNavBtn} ${active === 'standup-summary' ? styles.subNavActive : ''}`}
          onClick={() => navigate('/standup-summary')}
        >
          Summary
        </button>
      )}
      {can('standup:manage') && (
        <button
          className={`${styles.subNavBtn} ${active === 'standup-manage' ? styles.subNavActive : ''}`}
          onClick={() => navigate('/standup-manage')}
        >
          Manage
        </button>
      )}
    </div>
  );
};

async function fetchWorkItem(id: number, project: string, areaPath: string): Promise<WorkItem | null> {
  const params = new URLSearchParams({ project, areaPath });
  const res = await fetch(`/api/workitems/${id}?${params}`, { credentials: 'include' });
  if (!res.ok) return null;
  return res.json();
}

function flattenText(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(flattenText).join('');
  if (React.isValidElement(node)) return flattenText(node.props.children);
  return '';
}

function workItemTypeClass(type: string): string {
  const key = type.trim().toLowerCase().replace(/\s+/g, '-');
  const map: Record<string, string> = {
    epic: styles.typeEpic,
    feature: styles.typeFeature,
    bug: styles.typeBug,
    'product-backlog-item': styles.typePbi,
    'technical-backlog-item': styles.typeTbi,
    task: styles.typeTask,
  };
  return map[key] ?? styles.typeDefault;
}

function isReleaseLine(text: string): boolean {
  return /Release:\s*[\w.]+/.test(text) || text.includes('🎯');
}

function renderWorkItemLinks(text: string, onWorkItemClick: (id: number) => void, keyPrefix: string): React.ReactNode[] {
  const parts = text.split(/(#\d+)/g);
  return parts.map((part, i) => {
    const match = part.match(/^#(\d+)$/);
    if (match) {
      const id = parseInt(match[1], 10);
      return (
        <button
          key={`${keyPrefix}-id-${i}`}
          className={styles.workItemLink}
          onClick={(e) => { e.preventDefault(); onWorkItemClick(id); }}
          title={`View work item #${id}`}
        >
          {part}
        </button>
      );
    }
    return <React.Fragment key={`${keyPrefix}-txt-${i}`}>{part}</React.Fragment>;
  });
}

function processStandupText(text: string, onWorkItemClick: (id: number) => void, keyPrefix: string): React.ReactNode {
  const releaseSuffix = text.match(/( · Release: [^🎯\n]+)( 🎯)?$/);
  const withoutRelease = releaseSuffix ? text.slice(0, releaseSuffix.index) : text;

  const typeMatch = withoutRelease.match(/^(#\d+)( · )([A-Za-z][A-Za-z ]*?)( — )(.*)$/);
  if (typeMatch) {
    const [, idPart, sep1, type, sep2, rest] = typeMatch;
    return (
      <>
        {renderWorkItemLinks(idPart, onWorkItemClick, `${keyPrefix}-id`)}
        {sep1}
        <span className={`${styles.workItemTypeBadge} ${workItemTypeClass(type)}`}>{type.trim()}</span>
        {sep2}
        {renderWorkItemLinks(rest, onWorkItemClick, `${keyPrefix}-rest`)}
        {releaseSuffix && (
          <span className={styles.releaseBadge}>
            {releaseSuffix[1].replace(/^ · /, '')}
            {releaseSuffix[2] ?? ''}
          </span>
        )}
      </>
    );
  }

  const nodes = renderWorkItemLinks(withoutRelease, onWorkItemClick, keyPrefix);
  if (!releaseSuffix) return <>{nodes}</>;
  return (
    <>
      {nodes}
      <span className={styles.releaseBadge}>
        {releaseSuffix[1].replace(/^ · /, '')}
        {releaseSuffix[2] ?? ''}
      </span>
    </>
  );
}

/**
 * Custom renderer for ReactMarkdown that makes work item IDs clickable,
 * renders work item type badges, and highlights release-targeted items.
 */
function makeMarkdownComponents(onWorkItemClick: (id: number) => void) {
  const wrap = (Tag: 'p' | 'td' | 'strong', children: React.ReactNode, props: Record<string, unknown>) => {
    const processed = processChildren(children, onWorkItemClick);
    return React.createElement(Tag, props, processed);
  };

  return {
    p: ({ children, ...props }: React.ComponentProps<'p'>) => wrap('p', children, props),
    td: ({ children, ...props }: React.ComponentProps<'td'>) => wrap('td', children, props),
    strong: ({ children, ...props }: React.ComponentProps<'strong'>) => wrap('strong', children, props),
    li: ({ children, ...props }: React.ComponentProps<'li'>) => {
      const text = flattenText(children);
      const processed = processChildren(children, onWorkItemClick);
      const className = [props.className, isReleaseLine(text) ? styles.releaseItem : ''].filter(Boolean).join(' ') || undefined;
      return <li {...props} className={className}>{processed}</li>;
    },
  };
}

function processChildren(children: React.ReactNode, onWorkItemClick: (id: number) => void): React.ReactNode {
  return React.Children.map(children, (child, index) => {
    if (typeof child !== 'string') return child;
    if (!/#\d+/.test(child) && !/Release:\s*[\w.]+/.test(child)) return child;
    return <React.Fragment key={`standup-text-${index}`}>{processStandupText(child, onWorkItemClick, `seg-${index}`)}</React.Fragment>;
  });
}

export const StandupCeremonyView: React.FC = () => {
  const navigate = useNavigate();
  const { can, selectedProject, selectedAreaPath } = useAppShell();
  const [session, setSession] = useState<MySessionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [input, setInput] = useState('');
  const [selectedItem, setSelectedItem] = useState<WorkItem | null>(null);
  const [panelLoading, setPanelLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const threadId = session?.threadId ?? null;
  const { data: thread } = useChatThread(threadId);
  const {
    messages,
    streamingText,
    thinkingText,
    status: streamStatus,
    isRetrying,
    retryReason,
  } = useChatStream(threadId, {
    initialMessages: thread?.messages,
    initialStatus: thread?.status,
  });
  const sendMessage = useSendMessage(threadId ?? '');
  const speech = useSpeechInput(useCallback((text: string) => setInput(text), []));

  useEffect(() => {
    fetch('/api/standup/my-session')
      .then((r) => r.json())
      .then((data) => {
        setSession(data);
        setLoading(false);
        if (data?.threadId) syncToken(data.threadId);
      })
      .catch((err) => {
        setError((err as Error).message);
        setLoading(false);
      });
  }, []);

  const syncToken = useCallback(async (tid: string) => {
    try {
      await fetch(`/api/standup/threads/${tid}/sync-token`, { method: 'POST' });
    } catch {
      // non-fatal
    }
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingText, thinkingText, streamStatus]);

  const handleWorkItemClick = useCallback(async (id: number) => {
    setPanelLoading(true);
    const item = await fetchWorkItem(id, selectedProject, selectedAreaPath);
    if (item) setSelectedItem(item);
    setPanelLoading(false);
  }, [selectedProject, selectedAreaPath]);

  const handleSend = useCallback(async () => {
    if (!input.trim() || !threadId) return;
    if (speech.isListening) speech.stop();
    await syncToken(threadId);
    sendMessage.mutate({ text: input.trim() });
    setInput('');
  }, [input, threadId, sendMessage, syncToken, speech]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [handleSend]);

  const handleSubmit = useCallback(async () => {
    if (!session) return;
    setSubmitting(true);
    try {
      await fetch(`/api/standup/participants/${session.participantId}/submit`, { method: 'POST' });
      setSession((prev) => prev ? { ...prev, status: 'submitted' } : prev);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }, [session]);

  const mdComponents = React.useMemo(() => makeMarkdownComponents(handleWorkItemClick), [handleWorkItemClick]);

  if (loading) {
    return (
      <div className={styles.container}>
        <StandupSubNav active="standup" />
        <div className={styles.loading}>Loading your standup session...</div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className={styles.container}>
        <StandupSubNav active="standup" />
        <div className={styles.empty}>
          <h2>No Standup Today</h2>
          <p>You don't have a standup session scheduled for today.</p>
          {can('standup:manage') && (
            <button className={styles.manageBtn} onClick={() => navigate('/standup-manage')}>
              Go to Standup Management →
            </button>
          )}
        </div>
      </div>
    );
  }

  const isSubmitted = session.status === 'submitted';
  const visibleMessages = messages.filter((m) =>
    !m.hidden &&
    !(m.role === 'user' && m.text === 'Begin.') &&
    m.role !== 'tool' &&
    m.toolName !== '_thinking' &&
    m.toolName !== '_reasoning'
  );
  const isRunning = streamStatus === 'running';

  return (
    <div className={styles.container}>
      <StandupSubNav active="standup" />
      <div className={styles.bodyWrapper}>
        <div className={`${styles.body} ${selectedItem ? styles.bodyWithPanel : ''}`}>
          <header className={styles.header}>
            <h1>Daily Standup</h1>
            <span className={styles.date}>{session.sessionDate}</span>
            {isSubmitted && <span className={styles.badge}>Submitted</span>}
          </header>

          <div className={styles.messages}>
            {visibleMessages.map((msg, idx) => {
              const prevRole = idx > 0 ? visibleMessages[idx - 1].role : null;
              const nextRole = idx < visibleMessages.length - 1 ? visibleMessages[idx + 1].role : null;
              const isFirstInGroup = prevRole !== msg.role;
              const isLastInGroup = nextRole !== msg.role;
              return (
                <div
                  key={msg.id}
                  className={[
                    styles.message,
                    styles[msg.role],
                    !isFirstInGroup ? styles.messageGrouped : '',
                    !isLastInGroup ? styles.messageGroupedTop : '',
                  ].join(' ')}
                >
                  {isFirstInGroup && (
                    <div className={styles.role}>{msg.role === 'agent' ? 'Standup Bot' : 'You'}</div>
                  )}
                  <div className={styles.bubble}>
                    {msg.role === 'agent' ? (
                      <div className={styles.mdContent}>
                        <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                          {msg.text}
                        </ReactMarkdown>
                      </div>
                    ) : (
                      msg.text
                    )}
                  </div>
                </div>
              );
            })}

            {streamingText && (
              <div className={`${styles.message} ${styles.agent} ${visibleMessages.length > 0 && visibleMessages[visibleMessages.length - 1].role === 'agent' ? styles.messageGrouped : ''}`}>
                {!(visibleMessages.length > 0 && visibleMessages[visibleMessages.length - 1].role === 'agent') && (
                  <div className={styles.role}>Standup Bot</div>
                )}
                <div className={styles.bubble}>
                  <div className={styles.mdContent}>
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                      {streamingText}
                    </ReactMarkdown>
                    <span className={styles.streamCursor} aria-hidden="true" />
                  </div>
                </div>
              </div>
            )}

            {isRunning && !streamingText && (
              <div className={`${styles.message} ${styles.agent}`}>
                <div className={styles.role}>Standup Bot</div>
                <div className={styles.bubble}>
                  <div className={styles.thinkingBubble}>
                    {thinkingText ? (
                      <span className={styles.thinkingText}>{thinkingText}</span>
                    ) : (
                      <div className={styles.typingIndicator} aria-label="Agent is thinking">
                        <span className={styles.typingDot} />
                        <span className={styles.typingDot} />
                        <span className={styles.typingDot} />
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {isRetrying && retryReason && (
              <div className={styles.thinking}>{retryReason}</div>
            )}

            {panelLoading && (
              <div className={styles.thinking}>Loading work item…</div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {!isSubmitted && (
            <div className={styles.inputArea}>
              <textarea
                className={styles.textarea}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Type your response… (Enter to send, Shift+Enter for new line)"
                disabled={isRunning}
                rows={2}
              />
              {speech.speechError && (
                <div className={styles.speechError}>{speech.speechError}</div>
              )}
              <div className={styles.actions}>
                <button
                  className={`${styles.micBtn} ${speech.isListening ? styles.micBtnActive : ''}`}
                  onClick={() => speech.toggle(input)}
                  type="button"
                  aria-label={speech.isListening ? 'Stop voice transcription' : 'Start voice transcription'}
                  title={speech.isSpeechSupported
                    ? (speech.isListening ? 'Stop listening' : 'Talk to transcribe into chat')
                    : 'Speech recognition is not supported in this browser'}
                  disabled={!speech.isSpeechSupported || isRunning}
                >
                  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="7" y="2.5" width="6" height="10" rx="3" />
                    <path d="M4.5 9.5v0.5a5.5 5.5 0 0 0 11 0v-0.5" />
                    <path d="M10 15.5v2.5" />
                    <path d="M7.5 18h5" />
                  </svg>
                </button>
                <button
                  className={styles.sendBtn}
                  onClick={handleSend}
                  disabled={!input.trim() || isRunning}
                >
                  Send
                </button>
                <button
                  className={styles.submitBtn}
                  onClick={handleSubmit}
                  disabled={submitting || isRunning}
                >
                  {submitting ? 'Submitting…' : 'Submit Standup'}
                </button>
              </div>
              {speech.isListening && (
                <div className={styles.speechStatus}>
                  Listening… your speech is being transcribed into the draft.
                </div>
              )}
            </div>
          )}

          {error && <div className={styles.error}>{error}</div>}
        </div>

        {selectedItem && (
          <Suspense fallback={null}>
            <DetailsPanel
              workItem={selectedItem}
              onClose={() => setSelectedItem(null)}
              onUpdateDueDate={() => {}}
              onUpdateField={() => {}}
              isSaving={false}
              project={selectedProject}
              areaPath={selectedAreaPath}
              onSelectItem={(item) => setSelectedItem(item)}
            />
          </Suspense>
        )}
      </div>
    </div>
  );
};

export default StandupCeremonyView;
