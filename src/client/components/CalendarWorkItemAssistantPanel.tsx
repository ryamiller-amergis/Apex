import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  useWorkItemHierarchy,
  useCreateSession,
  useSessionWithProposal,
  useCalendarAssistantChat,
  useScopeSelection,
} from '../hooks/useCalendarWorkItemAssistant';
import { CalendarWorkItemChangesReview } from './CalendarWorkItemChangesReview';
import { AgentComposer, AgentPanelShell } from './agentChat';
import type { WorkItemHierarchyNode } from '../../shared/types/calendarWorkItemAssistant';
import styles from './CalendarWorkItemAssistantPanel.module.css';

interface Props {
  anchorWorkItemId: number;
  anchorTitle: string;
  project: string;
  areaPath: string;
  open: boolean;
  onClose: () => void;
}

const MIN_WIDTH = 320;
const MAX_WIDTH = 860;
const DEFAULT_WIDTH = 420;

type Step = 'scope' | 'chat';

/** Strip ADO HTML tags to readable plain text for inline display. */
function stripHtml(html: string | undefined): string {
  if (!html) return '';
  return html
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
    .split('\n').map(l => l.trim()).filter(Boolean).join('\n')
    .trim();
}

export const CalendarWorkItemAssistantPanel: React.FC<Props> = ({
  anchorWorkItemId,
  anchorTitle,
  project,
  areaPath,
  open,
  onClose,
}) => {
  const [step, setStep] = useState<Step>('scope');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [panelWidth, setPanelWidth] = useState(DEFAULT_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const resizeDragStartRef = useRef({ x: 0, width: DEFAULT_WIDTH });

  const [showNewConvConfirm, setShowNewConvConfirm] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const [showCurrentContent, setShowCurrentContent] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const qc = useQueryClient();

  // Hierarchy load
  const { data: contextData, isLoading: contextLoading, error: contextError } = useWorkItemHierarchy({
    project,
    areaPath,
    anchorWorkItemId,
    enabled: open,
  });

  const nodes = contextData?.nodes ?? [];

  const { selected, selectedArray, toggle, selectAll, clearAll, isAtLimit } = useScopeSelection(
    nodes,
    anchorWorkItemId,
  );

  const createSession = useCreateSession();

  const { data: sessionData } = useSessionWithProposal(sessionId);
  const latestProposal = sessionData?.latestProposal ?? null;

  const chat = useCalendarAssistantChat(threadId);
  const isRunning = chat.status === 'running';

  // Refresh session query when a run completes (proposal may have appeared)
  const wasRunningRef = useRef(false);
  useEffect(() => {
    if (wasRunningRef.current && !isRunning && sessionId) {
      void qc.invalidateQueries({ queryKey: ['calendar-assistant-session', sessionId] });
    }
    wasRunningRef.current = isRunning;
  }, [isRunning, sessionId, qc]);

  // Auto-open review when a pending proposal arrives
  useEffect(() => {
    if (latestProposal?.status === 'pending') {
      setShowReview(true);
    }
  }, [latestProposal?.status]);

  // Scroll to latest message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chat.messages.length, chat.streamingText]);

  // Resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [input]);

  const handleResizeMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    resizeDragStartRef.current = { x: e.clientX, width: panelWidth };
    setIsResizing(true);
  }, [panelWidth]);

  useEffect(() => {
    if (!isResizing) return;
    const onMove = (e: MouseEvent) => {
      const delta = resizeDragStartRef.current.x - e.clientX;
      setPanelWidth(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, resizeDragStartRef.current.width + delta)));
    };
    const onUp = () => setIsResizing(false);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [isResizing]);

  // Focus trap: close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showReview) { setShowReview(false); return; }
        if (showNewConvConfirm) { setShowNewConvConfirm(false); return; }
        onClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, showReview, showNewConvConfirm, onClose]);

  const handleStartSession = useCallback(async () => {
    try {
      const result = await createSession.mutateAsync({
        project,
        areaPath,
        anchorWorkItemId,
        selectedWorkItemIds: selectedArray,
        forceNew: false,
      });
      setSessionId(result.sessionId);
      setThreadId(result.threadId);
      setStep('chat');
    } catch {
      // error shown inline
    }
  }, [project, areaPath, anchorWorkItemId, selectedArray, createSession]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isRunning || isSending || !threadId) return;
    setInput('');
    setIsSending(true);
    try {
      await chat.sendMessage(text);
    } finally {
      setIsSending(false);
    }
  }, [input, isRunning, isSending, threadId, chat]);

  const handleNewConversation = useCallback(async () => {
    setShowNewConvConfirm(false);
    try {
      const result = await createSession.mutateAsync({
        project,
        areaPath,
        anchorWorkItemId,
        selectedWorkItemIds: selectedArray,
        forceNew: true,
      });
      setSessionId(result.sessionId);
      setThreadId(result.threadId);
      setShowReview(false);
    } catch {
      // error shown inline
    }
  }, [project, areaPath, anchorWorkItemId, selectedArray, createSession]);

  const rawMessages = chat.messages.filter(
    m => m.role !== 'tool' && !m.hidden && m.toolName !== '_reasoning',
  );

  // Merge consecutive agent messages so fragments don't render as separate pills
  const visibleMessages = rawMessages.reduce<Array<{ id: string; role: string; text: string }>>((acc, msg) => {
    if (msg.role === 'agent' && acc.length > 0 && acc[acc.length - 1].role === 'agent') {
      const last = acc[acc.length - 1];
      return [...acc.slice(0, -1), { ...last, text: last.text + '\n\n' + msg.text }];
    }
    return [...acc, msg];
  }, []);

  // Tools currently running (for the status pill)
  const runningTools = chat.toolProgress.filter(t => t.status === 'running');
  const latestTool = runningTools[0] ?? chat.toolProgress[chat.toolProgress.length - 1];
  const isWaitingForFirstToken = isRunning && !chat.streamingText && !latestTool;
  const isUsingTool = isRunning && !!latestTool && latestTool.status === 'running';

  // Dedup: don't show streaming text if the last message already contains it
  const lastAgentMsg = [...visibleMessages].reverse().find(m => m.role === 'agent');
  const showStreamingText = !!chat.streamingText &&
    !(lastAgentMsg?.text.includes(chat.streamingText.slice(0, 40)));

  if (!open) return null;

  return (
    <>
      {showNewConvConfirm && (
        <div
          className={styles.overlay}
          role="dialog"
          aria-modal="true"
          aria-labelledby="cal-new-conv-title"
          onClick={(e) => { if (e.target === e.currentTarget) setShowNewConvConfirm(false); }}
          {...{ 'data-testid': 'calendar-assistant-new-confirm-dialog' }}
        >
          <div className={styles.confirmCard}>
            <h2 id="cal-new-conv-title" className={styles.confirmTitle}>Start new conversation?</h2>
            <p className={styles.confirmBody}>
              The current thread and any staged proposals will be cleared.
            </p>
            <div className={styles.confirmActions}>
              <button
                type="button"
                className={styles.btnSecondary}
                onClick={() => setShowNewConvConfirm(false)}
                {...{ 'data-testid': 'calendar-assistant-new-confirm-cancel' }}
              >
                Cancel
              </button>
              <button
                type="button"
                className={styles.btnPrimary}
                onClick={() => void handleNewConversation()}
                {...{ 'data-testid': 'calendar-assistant-new-confirm-start' }}
              >
                Start new
              </button>
            </div>
          </div>
        </div>
      )}

      {showReview && sessionId && latestProposal && (
        <CalendarWorkItemChangesReview
          sessionId={sessionId}
          proposal={latestProposal}
          snapshot={sessionData?.session.contextSnapshot ?? []}
          onClose={() => setShowReview(false)}
          onApplied={() => {
            setShowReview(false);
            void qc.invalidateQueries({ queryKey: ['workItems'] });
          }}
        />
      )}

      <div {...{ 'data-testid': 'calendar-assistant-panel' }}>
        <AgentPanelShell
          title="Work-Item Assistant"
          ariaLabel="Calendar Work-Item Assistant"
          onClose={onClose}
          closeAriaLabel="Close assistant"
          closeTestId="calendar-assistant-close-btn"
          width={panelWidth}
          onResizeMouseDown={handleResizeMouseDown}
          actions={(
            <>
            {step === 'chat' && (
              <button
                type="button"
                className={styles.iconBtn}
                onClick={() => setShowNewConvConfirm(true)}
                title="New conversation"
                aria-label="New conversation"
                {...{ 'data-testid': 'calendar-assistant-new-btn' }}
              >
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M13 3v4H9" /><path d="M13 7A6 6 0 1 1 9.5 2.5" />
                </svg>
              </button>
            )}
            {step === 'chat' && latestProposal?.status === 'pending' && (
              <button
                type="button"
                className={styles.reviewBtn}
                onClick={() => setShowReview(true)}
                aria-label="Review proposed changes"
                {...{ 'data-testid': 'calendar-assistant-review-header-btn' }}
              >
                Review changes
              </button>
            )}
            </>
          )}
        >

        {step === 'scope' && (
          <div className={styles.scopePane}>
            <div className={styles.scopeIntro}>
              <p className={styles.scopeDesc}>
                Select which work items you want the assistant to review and propose changes for.
                The anchor item (<strong>#{anchorWorkItemId}</strong>) is always included.
              </p>
              {isAtLimit && (
                <p className={styles.limitWarning} role="alert">
                  Maximum 50 items selected.
                </p>
              )}
            </div>

            {contextLoading && (
              <div className={styles.loading}>Loading hierarchy…</div>
            )}

            {contextError && (
              <div className={styles.errorMsg} role="alert">
                Failed to load work items: {(contextError as Error).message}
              </div>
            )}

            {!contextLoading && !contextError && nodes.length === 0 && (
              <div className={styles.empty}>No work items found under this item.</div>
            )}

            {nodes.length > 0 && (
              <>
                <div className={styles.scopeControls}>
                  <button
                    type="button"
                    className={styles.btnLink}
                    onClick={selectAll}
                    {...{ 'data-testid': 'calendar-assistant-select-all' }}
                  >
                    Select all ({Math.min(nodes.length, 50)})
                  </button>
                  <button
                    type="button"
                    className={styles.btnLink}
                    onClick={clearAll}
                    {...{ 'data-testid': 'calendar-assistant-clear-all' }}
                  >
                    Clear
                  </button>
                  <span className={styles.selectedCount}>
                    {selected.size} selected
                  </span>
                </div>

                <ul className={styles.nodeList} aria-label="Work items to include">
                  {nodes.map(node => (
                    <ScopeNodeRow
                      key={node.id}
                      node={node}
                      checked={selected.has(node.id)}
                      disabled={node.id === anchorWorkItemId || (isAtLimit && !selected.has(node.id))}
                      onChange={() => toggle(node.id)}
                      {...{ 'data-testid': `calendar-assistant-scope-node-${node.id}` }}
                    />
                  ))}
                </ul>
              </>
            )}

            {createSession.error && (
              <div className={styles.errorMsg} role="alert">
                {createSession.error.message}
              </div>
            )}

            <div className={styles.scopeActions}>
              <button
                type="button"
                className={styles.btnPrimary}
                onClick={() => void handleStartSession()}
                disabled={selected.size === 0 || createSession.isPending || contextLoading}
                aria-busy={createSession.isPending}
                {...{ 'data-testid': 'calendar-assistant-start-btn' }}
              >
                {createSession.isPending ? 'Starting…' : 'Start assistant →'}
              </button>
            </div>
          </div>
        )}

        {step === 'chat' && (
          <div className={styles.chatPane}>
            <div className={styles.scopeSummary}>
              Scope: #{anchorWorkItemId} {anchorTitle}
              {selected.size > 1 && <> +{selected.size - 1} more</>}
              <button
                type="button"
                className={styles.btnLinkSmall}
                onClick={() => setShowNewConvConfirm(true)}
                title="Change scope (starts new session)"
                {...{ 'data-testid': 'calendar-assistant-change-scope' }}
              >
                change
              </button>
            </div>

            {/* Current content accordion */}
            {sessionData?.session.contextSnapshot && sessionData.session.contextSnapshot.length > 0 && (
              <div className={styles.currentContent}>
                <button
                  type="button"
                  className={styles.currentContentToggle}
                  onClick={() => setShowCurrentContent(v => !v)}
                  aria-expanded={showCurrentContent}
                  {...{ 'data-testid': 'calendar-assistant-current-content-toggle' }}
                >
                  <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"
                    style={{ transform: showCurrentContent ? 'rotate(180deg)' : undefined, transition: 'transform 0.2s', flexShrink: 0 }}
                  >
                    <path d="M2 4l4 4 4-4" />
                  </svg>
                  Current content
                  <span className={styles.currentContentCount}>
                    {sessionData.session.contextSnapshot.length} item{sessionData.session.contextSnapshot.length !== 1 ? 's' : ''}
                  </span>
                </button>

                {showCurrentContent && (
                  <div className={styles.currentContentBody}>
                    {sessionData.session.contextSnapshot.map(node => {
                      const desc = stripHtml(node.description);
                      const ac = stripHtml(node.acceptanceCriteria);
                      const hasContent = desc || ac;
                      return (
                        <div key={node.id} className={styles.contentItem}>
                          <div className={styles.contentItemHeader}>
                            <span className={styles.contentItemType}>{node.workItemType}</span>
                            <span className={styles.contentItemId}>#{node.id}</span>
                            <span className={styles.contentItemTitle}>{node.title}</span>
                          </div>
                          {!hasContent && (
                            <p className={styles.contentEmpty}>No description or criteria yet.</p>
                          )}
                          {desc && (
                            <div className={styles.contentField}>
                              <div className={styles.contentFieldLabel}>Description</div>
                              <pre className={styles.contentFieldText}>{desc}</pre>
                            </div>
                          )}
                          {ac && node.supportedFields.includes('acceptanceCriteria') && (
                            <div className={styles.contentField}>
                              <div className={styles.contentFieldLabel}>Acceptance Criteria</div>
                              <pre className={styles.contentFieldText}>{ac}</pre>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            <div className={styles.messages} aria-live="polite" aria-label="Conversation">
              <div className={styles.messageList}>
                {visibleMessages.length === 0 && !isRunning && (
                  <div className={styles.emptyChat}>
                    <p>
                      Ask the assistant to review and improve Description or Acceptance Criteria
                      for the selected work items.
                    </p>
                    <p className={styles.emptyChatHint}>
                      Example: "Improve the acceptance criteria for the PBIs to use Given/When/Then format."
                    </p>
                  </div>
                )}

                {visibleMessages.map((msg) => (
                  <div
                    key={msg.id}
                    className={`${styles.message} ${msg.role === 'user' ? styles.messageUser : styles.messageAgent}`}
                  >
                    <div className={styles.messageBubble}>
                      {msg.role === 'agent' ? (
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.text}</ReactMarkdown>
                      ) : (
                        msg.text
                      )}
                    </div>
                  </div>
                ))}

                {/* Streaming text (deduped against last message) */}
                {showStreamingText && (
                  <div className={`${styles.message} ${styles.messageAgent}`}>
                    <div className={`${styles.messageBubble} ${styles.messageBubbleStreaming}`}>
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{chat.streamingText}</ReactMarkdown>
                    </div>
                  </div>
                )}

                {/* Tool activity pill */}
                {isUsingTool && (
                  <div className={styles.toolPill} aria-live="polite">
                    <span className={styles.toolSpinner} aria-hidden="true" />
                    <span className={styles.toolName}>
                      {latestTool.toolName.replace(/_/g, ' ')}
                    </span>
                    <span className={styles.toolDots}>
                      <span /><span /><span />
                    </span>
                  </div>
                )}

                {/* Waiting for first token — pure thinking indicator */}
                {isWaitingForFirstToken && (
                  <div className={styles.thinkingRow} aria-label="Thinking">
                    <span className={styles.thinkingDot} />
                    <span className={styles.thinkingDot} />
                    <span className={styles.thinkingDot} />
                  </div>
                )}

                <div ref={messagesEndRef} />
              </div>
            </div>

            {latestProposal?.status === 'pending' && (
              <div className={styles.proposalBanner} role="status">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <circle cx="12" cy="12" r="10" /><path d="M12 8v4l3 3" />
                </svg>
                Changes proposed — review before applying
                <button
                  type="button"
                  className={styles.btnReview}
                  onClick={() => setShowReview(true)}
                  {...{ 'data-testid': 'calendar-assistant-review-banner-btn' }}
                >
                  Review
                </button>
              </div>
            )}

            <AgentComposer
              className={styles.composerEmbed}
              value={input}
              onChange={setInput}
              onSend={() => void handleSend()}
              onCancel={isRunning ? () => void chat.cancelRun() : undefined}
              disabled={isRunning || isSending}
              isRunning={isRunning}
              isSending={isSending}
              placeholder="Message the assistant… (Enter to send)"
              testIdPrefix="calendar-assistant"
              {...{ 'data-testid': 'calendar-assistant-composer' }}
              textareaRef={textareaRef}
            />
          </div>
        )}
        </AgentPanelShell>
      </div>
    </>
  );
};

interface ScopeNodeRowProps {
  node: WorkItemHierarchyNode;
  checked: boolean;
  disabled: boolean;
  onChange: () => void;
  'data-testid'?: string;
}

const ScopeNodeRow: React.FC<ScopeNodeRowProps> = ({
  node,
  checked,
  disabled,
  onChange,
  'data-testid': dataTestId,
}) => {
  const indent = node.depth * 16;
  const isTerminal = ['Closed', 'Done', 'Removed', 'Resolved', 'Cancelled'].includes(node.state);
  const hasNoFields = node.supportedFields.length === 0;

  return (
    <li
      className={`${styles.nodeRow} ${hasNoFields ? styles.nodeRowDisabled : ''}`}
      style={{ paddingLeft: indent }}
      {...(dataTestId ? { 'data-testid': dataTestId } : {})}
    >
      <label className={styles.nodeLabel}>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled || hasNoFields}
          onChange={onChange}
          aria-label={`${node.workItemType} #${node.id}: ${node.title}`}
          {...{ 'data-testid': `calendar-assistant-scope-checkbox-${node.id}` }}
        />
        <span className={styles.nodeType}>{node.workItemType}</span>
        <span className={styles.nodeId}>#{node.id}</span>
        <span className={styles.nodeTitle}>{node.title}</span>
        {isTerminal && <span className={styles.nodeTerminal}>{node.state}</span>}
        {hasNoFields && <span className={styles.nodeUnsupported}>not editable</span>}
      </label>
      {checked && (
        <span className={styles.nodeFields}>
          {node.supportedFields.join(', ')}
        </span>
      )}
    </li>
  );
};

export default CalendarWorkItemAssistantPanel;
