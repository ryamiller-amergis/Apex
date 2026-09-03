import React, { useState, useCallback, useEffect, useRef, useReducer, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAppShell } from '../hooks/useAppShell';
import {
  useDesignDoc,
  usePrd,
  useUpdateDesignDocContent,
  useSubmitDesignDoc,
  useWithdrawDesignDoc,
  useReviewDesignDoc,
  useDeleteDesignDoc,
  useMarkValidationReady,
  useRefreshValidation,
  useCancelValidation,
  useCreateValidationThread,
  useValidationReport,
  useFixValidation,
  useAcceptFixValidation,
  useDismissDesignDocFixSession,
  useRevertDesignDocSection,
  useDocumentAssignments,
  useReassignApprovers,
  useFixDesignDocWithAi,
  useFixDesignDocCommentWithAi,
  useDesignDocOwnerApproval,
  useDesignDocOwnerApprove,
  useRetryGenerateDesignDoc,
  useOverrideDesignDocValidation,
} from '../hooks/useInterviews';
import { ProposedDesignDocChangesReview } from './ProposedDesignDocChangesReview';
import { useAgentChatSession } from '../hooks/useAgentChatSession';
import { AgentComposer, AgentPanelShell } from './agentChat';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import { ApproverSelectModal } from './ApproverSelectModal';
import { ReviewReasonModal } from './ReviewReasonModal';
import { ArtifactUsageStrip } from './ArtifactUsageStrip';
import { ValidationOverrideAudit } from './ValidationOverrideAudit';
import { AnnotationLayer, unwrapCommentMarks } from './AnnotationLayer';
import { ReviewCommentSidebar } from './ReviewCommentSidebar';
import { FixValidationPanel } from './FixValidationPanel';
import { ApexFixRunningBanner } from './ApexFixRunningBanner';
import type { ContentSnapshot, GapChangeEntry } from './FixValidationPanel';
import type { DesignDocStatus, ValidationScorecardGap, ValidationScorecard, ValidationScorecardFeature } from '../../shared/types/interview';
import {
  collectValidationGaps,
  designDocFeatureSectionScore,
} from '../../shared/utils/validationReport';
import {
  designDocHasProposedChanges,
  isDesignDocSingleCommentFixPending,
} from '../utils/apexFixHelpers';
import {
  APEX_FIX_TIMEOUT_MS,
  agentErrorFromChatThreadStatus,
  cancelChatThread,
  clearApexFixInProgress,
  fetchChatThreadStatus,
  isTerminalChatThreadStatus,
  markApexFixInProgress,
  readApexFixInProgress,
} from '../utils/apexFixSession';
import { downloadArtifactZip, sanitizeArtifactName } from '../utils/artifactDownload';
import {
  useReviewComments,
  useUnresolvedCommentCount,
  useCreateComment,
  useResolveComment,
  useReopenComment as useReopenReviewComment,
  useDeleteComment,
} from '../hooks/useReviewComments';
import { MarkdownWithMermaid, MermaidDiagram } from './MarkdownWithMermaid';
import type { ReviewSectionKey, TextSelector } from '../../shared/types/reviewComments';
import styles from './DesignDocReviewView.module.css';
import { ApexLoader } from './ApexLoader';

type TabId = 'design' | 'tech-spec' | 'assumptions' | 'validation';

// ── Fix Validation Flow state machine ─────────────────────────────────────────

type FixFlowState =
  | { phase: 'idle' }
  | { phase: 'fixing'; baseline: ContentSnapshot; threadId: string }
  | { phase: 'reviewing'; baseline: ContentSnapshot; gapChanges: GapChangeEntry[]; agentError?: string }
  | { phase: 'discussing'; baseline: ContentSnapshot; gapChanges: GapChangeEntry[]; activeSection: string };

type FixFlowAction =
  | { type: 'START_FIX'; baseline: ContentSnapshot; threadId: string }
  | { type: 'FIX_COMPLETE'; gapChanges: GapChangeEntry[]; agentError?: string }
  | { type: 'START_DISCUSS'; activeSection: string }
  | { type: 'END_DISCUSS' }
  | { type: 'RESET' };

function parseGapChangesFromMessages(messages: Array<{ role: string; text: string }>): GapChangeEntry[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== 'assistant' && msg.role !== 'agent') continue;
    const startMarker = '<!-- GAP_CHANGES_START -->';
    const endMarker = '<!-- GAP_CHANGES_END -->';
    const startIdx = msg.text.indexOf(startMarker);
    const endIdx = msg.text.indexOf(endMarker);
    if (startIdx === -1 || endIdx === -1) continue;
    const jsonStr = msg.text.slice(startIdx + startMarker.length, endIdx).trim();
    try {
      const parsed = JSON.parse(jsonStr);
      if (parsed?.gap_changes && Array.isArray(parsed.gap_changes)) {
        return parsed.gap_changes;
      }
    } catch { /* AI didn't produce valid JSON */ }
  }
  return [];
}

function fixFlowReducer(state: FixFlowState, action: FixFlowAction): FixFlowState {
  switch (action.type) {
    case 'START_FIX':
      return { phase: 'fixing', baseline: action.baseline, threadId: action.threadId };
    case 'FIX_COMPLETE':
      if (state.phase !== 'fixing') return state;
      return { phase: 'reviewing', baseline: state.baseline, gapChanges: action.gapChanges, agentError: action.agentError };
    case 'START_DISCUSS':
      if (state.phase !== 'reviewing' && state.phase !== 'discussing') return state;
      return { phase: 'discussing', baseline: (state as any).baseline, gapChanges: (state as any).gapChanges ?? [], activeSection: action.activeSection };
    case 'END_DISCUSS':
      if (state.phase !== 'discussing') return state;
      return { phase: 'reviewing', baseline: state.baseline, gapChanges: state.gapChanges };
    case 'RESET':
      return { phase: 'idle' };
    default:
      return state;
  }
}

function statusBadgeClass(status: DesignDocStatus): string {
  switch (status) {
    case 'generating': return styles.badgeGenerating;
    case 'generation_failed': return styles.badgeRevisionRequested;
    case 'validating': return styles.badgeValidating;
    case 'draft': return styles.badgeDraft;
    case 'pending_review': return styles.badgePendingReview;
    case 'reviewer_approved': return styles.badgePendingReview;
    case 'approved': return styles.badgeApproved;
    case 'revision_requested': return styles.badgeRevisionRequested;
  }
}

function statusLabel(status: DesignDocStatus): string {
  switch (status) {
    case 'generating': return 'Generating';
    case 'generation_failed': return 'Failed';
    case 'validating': return 'Validating';
    case 'draft': return 'Draft';
    case 'pending_review': return 'Pending Review';
    case 'reviewer_approved': return 'Reviewer Approved';
    case 'approved': return 'Approved';
    case 'revision_requested': return 'Revision Requested';
  }
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Document outline (table of contents) helpers ──────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

function nodeToText(node: React.ReactNode): string {
  if (node == null || node === false) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeToText).join('');
  if (React.isValidElement(node)) return nodeToText((node.props as { children?: React.ReactNode }).children);
  return '';
}

interface OutlineItem {
  id: string;
  text: string;
  level: number;
}

function buildOutline(markdown: string): OutlineItem[] {
  if (!markdown) return [];
  const items: OutlineItem[] = [];
  let inFence = false;
  for (const raw of markdown.split('\n')) {
    const line = raw.trimEnd();
    const trimmed = line.trimStart();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^(#{1,3})\s+(.+?)\s*#*$/.exec(line);
    if (!match) continue;
    const level = match[1].length;
    const text = match[2].replace(/[*_`]/g, '').trim();
    if (!text) continue;
    items.push({ id: slugify(text), text, level });
  }
  return items;
}

const PinIcon: React.FC = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 2h4M7 2v4.5L4.5 9.5h7L9 6.5V2M8 9.5V14" />
  </svg>
);

const SplitIcon: React.FC = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="1" y="2" width="6" height="12" rx="1" />
    <rect x="9" y="2" width="6" height="12" rx="1" />
  </svg>
);

const MIN_PINNED_WIDTH = 320;
const MAX_PINNED_WIDTH = 760;
const DEFAULT_PINNED_WIDTH = 440;

const MIN_SPLIT_PERCENT = 0.20; // right pane minimum 20 % of center
const MAX_SPLIT_PERCENT = 0.75; // right pane maximum 75 % of center
const DEFAULT_SPLIT_PERCENT = 0.50; // 50 / 50

interface ContentPaneProps {
  content: string;
  isEditing: boolean;
  editValue: string;
  isDirty: boolean;
  isSaving: boolean;
  canEdit: boolean;
  placeholder: string;
  markdownComponents: Components;
  onEditChange: (v: string) => void;
  onSave: () => void;
  onDiscard: () => void;
}

const ContentPane: React.FC<ContentPaneProps> = ({
  content,
  isEditing,
  editValue,
  isDirty,
  isSaving,
  canEdit,
  placeholder,
  markdownComponents,
  onEditChange,
  onSave,
  onDiscard,
}) => {
  if (isEditing) {
    return (
      <div className={styles.editArea}>
        <textarea
          className={styles.textarea}
          value={editValue}
          onChange={(e) => onEditChange(e.target.value)}
          placeholder={placeholder}
        />
        <div className={styles.editActions}>
          <button
            className={styles.btnPrimary}
            onClick={onSave}
            disabled={!isDirty || isSaving}
            type="button"
          >
            {isSaving ? 'Saving…' : 'Save'}
          </button>
          <button
            className={styles.btnSecondary}
            onClick={onDiscard}
            type="button"
          >
            Discard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.previewWrapper}>
      <div className={styles.preview}>
        {content ? (
          <MarkdownWithMermaid content={content} components={markdownComponents} />
        ) : (
          <div className={styles.emptyPreview}>
            No content yet.{canEdit ? ' Click Edit to write this section.' : ''}
          </div>
        )}
      </div>
    </div>
  );
};

// ── Q&A embedded chat components removed ─────────────────────────────────────
// The Q&A phase has been removed. Design docs are generated immediately upon prototype approval.


// ── Doc Assistant slide-in panel ─────────────────────────────────────────────

const ASSISTANT_THREAD_LS_KEY = (docId: string) => `design-doc-assistant-thread:${docId}`;

interface DiscussContext {
  section: 'design' | 'tech-spec' | 'assumptions';
  sectionLabel: string;
  gaps: ValidationScorecardGap[];
  gapChanges: GapChangeEntry[];
}

interface DesignDocAssistantPanelProps {
  designDocId: string;
  onClose: () => void;
  discussContext?: DiscussContext;
  docAssistantThreadId?: string | null;
  canCreateThread: boolean;
  readOnly: boolean;
}

const MIN_PANEL_WIDTH = 280;
const MAX_PANEL_WIDTH = 800;
const DEFAULT_PANEL_WIDTH = 380;

const DesignDocAssistantPanel: React.FC<DesignDocAssistantPanelProps> = ({
  designDocId,
  onClose,
  discussContext,
  docAssistantThreadId,
  canCreateThread,
  readOnly,
}) => {
  const [threadId, setThreadId] = useState<string | null>(() => {
    if (discussContext) return null;
    return docAssistantThreadId ?? localStorage.getItem(ASSISTANT_THREAD_LS_KEY(designDocId));
  });
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

  const session = useAgentChatSession(threadId, { locked: readOnly });
  const { messages, streamingText, isRunning, isSending, showTypingIndicator } = session;
  const wasRunningRef = useRef(false);

  // When the assistant finishes a run, invalidate the design doc so the main
  // pane picks up any content changes saved by the update_design_doc MCP tool.
  useEffect(() => {
    if (wasRunningRef.current && !isRunning) {
      void qc.invalidateQueries({ queryKey: ['design-doc', designDocId] });
    }
    wasRunningRef.current = isRunning;
  }, [isRunning, qc, designDocId]);

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

  useEffect(() => {
    if (threadId) return;
    if (skipAutoCreateRef.current) {
      skipAutoCreateRef.current = false;
      return;
    }
    if (!canCreateThread && !docAssistantThreadId) {
      setCreateError('No assistant conversation is available for this document.');
      return;
    }
    if (!canCreateThread && docAssistantThreadId) {
      setThreadId(docAssistantThreadId);
      return;
    }
    setIsCreating(true);
    setCreateError(null);
    fetch(`/api/interviews/design-docs/${designDocId}/assistant-thread`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: discussContext ? JSON.stringify({ forceNew: true }) : undefined,
    })
      .then((r) => r.json() as Promise<{ threadId: string }>)
      .then((data) => {
        setThreadId(data.threadId);
        if (!discussContext) {
          localStorage.setItem(ASSISTANT_THREAD_LS_KEY(designDocId), data.threadId);
        }
      })
      .catch(() => setCreateError('Failed to start assistant. Please try again.'))
      .finally(() => setIsCreating(false));
  }, [designDocId, threadId, discussContext, canCreateThread, docAssistantThreadId]);

  const discussContextSentRef = useRef(false);
  useEffect(() => {
    if (!discussContext || !threadId || isRunning || discussContextSentRef.current) return;
    discussContextSentRef.current = true;

    const { sectionLabel, gaps, gapChanges } = discussContext;

    // Extract the first meaningful sentence from what_changed.
    // The AI sometimes writes multi-paragraph descriptions with ## headings despite
    // being instructed to write one sentence — we strip heading markers and take
    // only the first non-empty line to keep the message clean.
    const firstSentence = (text: string): string => {
      const firstLine = text.split('\n')
        .map((l) => l.replace(/^#+\s*/, '').trim())
        .find((l) => l.length > 0) ?? text.trim();
      return firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine;
    };

    const gapLines = gaps.length > 0
      ? gaps.map((g) => `- **${g.description}** (score: ${g.score}/3)\n  → What a score of 3 looks like: *${g.what_3_looks_like}*`).join('\n')
      : '_(no gaps recorded for this section)_';

    const changeLines = gapChanges.length > 0
      ? gapChanges.map((c) => `- **${c.gap_id}**: ${firstSentence(c.what_changed)}`).join('\n')
      : '_(no changes recorded for this section)_';

    const contextMsg = [
      `I'd like to discuss the proposed **${sectionLabel}** changes from the Apex fix validation.`,
      '',
      `## Gaps in the ${sectionLabel} section`,
      gapLines,
      '',
      '## What Apex changed',
      changeLines,
      '',
      'Please help me review whether these changes adequately address the gaps and discuss any concerns.',
    ].join('\n');

    void fetch(`/api/chat/threads/${threadId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ text: contextMsg }),
    });
  }, [threadId, isRunning, discussContext]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, streamingText]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    await session.send(text);
  }, [input, session]);

  const visibleMessages = messages.filter((m) => m.role !== 'tool' && m.toolName !== '_reasoning' && m.toolName !== '_thinking');

  return (
    <>
    {showNewConvConfirm && (
      <div
        className={styles.confirmOverlay}
        onClick={(e) => { if (e.target === e.currentTarget) setShowNewConvConfirm(false); }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-conv-confirm-title"
        {...{ 'data-testid': 'design-doc-assistant-new-confirm-dialog' }}
      >
        <div className={styles.confirmCard}>
          <div className={styles.confirmIconWrap} aria-hidden="true">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M13 3v4H9" /><path d="M13 7A6 6 0 1 1 9.5 2.5" />
            </svg>
          </div>
          <h2 className={styles.confirmTitle} id="new-conv-confirm-title">Start new conversation?</h2>
          <p className={styles.confirmBody}>The current thread will be cleared and a fresh session with Apex will begin.</p>
          <div className={styles.confirmActions}>
            <button className={styles.confirmBtnCancel} onClick={() => setShowNewConvConfirm(false)} type="button" {...{ 'data-testid': 'design-doc-assistant-new-confirm-cancel' }}>Cancel</button>
            <button
              className={styles.confirmBtnConfirm}
              onClick={async () => {
                setShowNewConvConfirm(false);
                skipAutoCreateRef.current = true;
                localStorage.removeItem(ASSISTANT_THREAD_LS_KEY(designDocId));
                setThreadId(null);
                setCreateError(null);
                setIsCreating(true);
                try {
                  const r = await fetch(`/api/interviews/design-docs/${designDocId}/assistant-thread`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ forceNew: true }),
                  });
                  const data = await r.json() as { threadId: string };
                  setThreadId(data.threadId);
                  localStorage.setItem(ASSISTANT_THREAD_LS_KEY(designDocId), data.threadId);
                } catch {
                  setCreateError('Failed to start new conversation. Please try again.');
                } finally {
                  setIsCreating(false);
                }
              }}
              type="button"
              {...{ 'data-testid': 'design-doc-assistant-new-confirm-start' }}
            >
              Start new
            </button>
          </div>
        </div>
      </div>
    )}
    <div {...{ 'data-testid': 'design-doc-assistant-panel' }}>
      <AgentPanelShell
        title="Apex Assistant"
        ariaLabel="Design document assistant panel"
        onClose={onClose}
        closeAriaLabel="Close assistant"
        closeTestId="design-doc-assistant-close-btn"
        width={panelWidth}
        onResizeMouseDown={handleResizeMouseDown}
        actions={!readOnly && canCreateThread ? (
          <button
            className={styles.assistantPanelIconBtn}
            onClick={() => setShowNewConvConfirm(true)}
            type="button"
            title="New conversation"
            aria-label="New conversation"
            {...{ 'data-testid': 'design-doc-assistant-new-btn' }}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M13 3v4H9" /><path d="M13 7A6 6 0 1 1 9.5 2.5" />
            </svg>
          </button>
        ) : undefined}
        composer={!readOnly ? (
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
              'Ask about this design doc… (Enter to send)'
            }
            testIdPrefix="design-doc-assistant"
            {...{ 'data-testid': 'design-doc-assistant-composer' }}
            textareaRef={textareaRef}
          />
        ) : (
          <div className={styles.qaMessageBubbleSystem} style={{ margin: '0 12px 12px' }}>
            Assistant is read-only — you can view the conversation but cannot send messages.
          </div>
        )}
      >
      <div className={styles.assistantMessages}>
        <div className={styles.assistantMessageList}>
          {isCreating && (
            <div className={styles.assistantInitializing}>
              <div className={styles.qaTypingIndicator}>
                <span className={styles.qaTypingDot} />
                <span className={styles.qaTypingDot} />
                <span className={styles.qaTypingDot} />
              </div>
              <span>Starting assistant…</span>
            </div>
          )}
          {createError && (
            <div className={styles.qaMessageBubbleSystem}>{createError}</div>
          )}
          {visibleMessages.map((msg) => {
            if (msg.role === 'system') {
              return <div key={msg.id} className={styles.qaMessageBubbleSystem}>{msg.text}</div>;
            }
            if (msg.role === 'user') {
              return (
                <div key={msg.id} className={`${styles.qaMessageBubble} ${styles.qaMessageBubbleUser}`}>
                  {msg.text}
                </div>
              );
            }
            return (
              <div key={msg.id} className={`${styles.qaMessageBubble} ${styles.qaMessageBubbleAssistant}`}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.text}</ReactMarkdown>
              </div>
            );
          })}
          {showTypingIndicator && (
            <div className={styles.qaTypingIndicator}>
              <span className={styles.qaTypingDot} />
              <span className={styles.qaTypingDot} />
              <span className={styles.qaTypingDot} />
            </div>
          )}
          {streamingText && (
            <div className={`${styles.qaMessageBubble} ${styles.qaMessageBubbleAssistant}`}>
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

// ── Validation Side Panel ─────────────────────────────────────────────────────

interface ValidationSidePanelProps {
  score: number | null | undefined;
  scorecard: ValidationScorecard | null | undefined;
  reportMarkdown: string | null | undefined;
  isValidating: boolean;
  onCollapse: () => void;
  markdownComponents: Components;
}

function scoreColor(s: number): string {
  if (s >= 90) return 'var(--success-color)';
  if (s >= 70) return '#d97706';
  return 'var(--error-color)';
}

function scoreBarBg(s: number): string {
  if (s >= 90) return 'rgba(34,197,94,0.2)';
  if (s >= 70) return 'rgba(245,158,11,0.2)';
  return 'rgba(239,68,68,0.12)';
}

function gapResolutionDot(resolution: ValidationScorecardGap['resolution']): string {
  switch (resolution) {
    case 'filled': return styles.valGapDotFilled;
    case 'accepted': return styles.valGapDotAccepted;
    case 'deferred': return styles.valGapDotDeferred;
    default: return styles.valGapDotPending;
  }
}

interface CommentsSidePanelProps {
  openCount: number;
  onCollapse: () => void;
  children: React.ReactNode;
}

const CommentsSidePanel: React.FC<CommentsSidePanelProps> = ({
  openCount,
  onCollapse,
  children,
}) => {
  return (
    <div className={styles.commentsPanel}>
      <button
        className={styles.commentsPanelHeader}
        onClick={onCollapse}
        type="button"
        aria-expanded={true}
        aria-label="Collapse comments panel"
      >
        <svg className={styles.commentsPanelChevron} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 6l4 4 4-4" />
        </svg>
        <span className={styles.commentsPanelTitle}>Comments</span>
        {openCount > 0 && (
          <span className={styles.commentsPanelCountBadge}>{openCount} open</span>
        )}
      </button>
      <div className={styles.commentsPanelBody}>
        {children}
      </div>
    </div>
  );
};

interface ReviewSideDockProps {
  showComments: boolean;
  showValidation: boolean;
  commentsCollapsed: boolean;
  validationCollapsed: boolean;
  onToggleComments: () => void;
  onToggleValidation: () => void;
  openCommentCount: number;
  validationScore: number | null | undefined;
  isValidating: boolean;
  commentsPanel: React.ReactNode;
  validationPanel: React.ReactNode;
}

const ReviewSideDock: React.FC<ReviewSideDockProps> = ({
  showComments,
  showValidation,
  commentsCollapsed,
  validationCollapsed,
  onToggleComments,
  onToggleValidation,
  openCommentCount,
  validationScore,
  isValidating,
  commentsPanel,
  validationPanel,
}) => {
  if (!showComments && !showValidation) return null;

  return (
    <div className={styles.reviewDock} {...{ 'data-testid': 'dd-review-dock' }}>
      {showComments && !commentsCollapsed && commentsPanel}
      {showValidation && !validationCollapsed && validationPanel}

      <div className={styles.reviewDockTabs} role="tablist" aria-orientation="vertical" aria-label="Review tools">
        {showComments && (
          <button
            className={`${styles.reviewDockTab} ${styles.reviewDockTabComments} ${!commentsCollapsed ? styles.reviewDockTabActive : ''}`}
            onClick={onToggleComments}
            type="button"
            role="tab"
            aria-selected={!commentsCollapsed}
            title={commentsCollapsed ? 'Expand comments' : 'Collapse comments'}
            {...{ 'data-testid': 'dd-dock-comments-tab' }}
          >
            {openCommentCount > 0 && (
              <span className={styles.reviewDockTabBadge}>{openCommentCount}</span>
            )}
            <span className={styles.reviewDockTabLabel}>Comments</span>
          </button>
        )}
        {showValidation && (
          <button
            className={`${styles.reviewDockTab} ${!validationCollapsed ? styles.reviewDockTabActive : ''}`}
            onClick={onToggleValidation}
            type="button"
            role="tab"
            aria-selected={!validationCollapsed}
            title={validationCollapsed ? 'Expand validation' : 'Collapse validation'}
            {...{ 'data-testid': 'dd-dock-validation-tab' }}
            style={
              validationScore !== null && validationScore !== undefined
                ? { borderLeftColor: scoreColor(validationScore) }
                : undefined
            }
          >
            {isValidating && (validationScore === null || validationScore === undefined) && (
              <svg className={styles.valPanelSpinner} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
            )}
            {validationScore !== null && validationScore !== undefined && (
              <span
                className={styles.reviewDockTabScore}
                style={{ color: scoreColor(validationScore) }}
                {...{ 'data-testid': 'dd-validation-score' }}
              >
                {validationScore}%
              </span>
            )}
            <span className={styles.reviewDockTabLabel}>Validation</span>
          </button>
        )}
      </div>
    </div>
  );
};

const ValidationSidePanel: React.FC<ValidationSidePanelProps> = ({
  score,
  scorecard,
  reportMarkdown,
  isValidating,
  onCollapse,
  markdownComponents,
}) => {
  const [reportExpanded, setReportExpanded] = useState(false);

  const features: ValidationScorecardFeature[] = scorecard?.features ?? [];
  const allGaps: ValidationScorecardGap[] = collectValidationGaps(scorecard);
  const pendingCount = allGaps.filter((g) => g.resolution === 'pending').length;

  const avgSection = (key: 'design_score' | 'tech_spec_score' | 'assumptions_score') => {
    if (!features.length) return null;
    const scores = features
      .map((f) => designDocFeatureSectionScore(f as unknown as Record<string, unknown>, key))
      .filter((n): n is number => n !== null);
    if (!scores.length) return null;
    return Math.round(scores.reduce((sum, n) => sum + n, 0) / scores.length);
  };

  const sectionRows: Array<{ label: string; key: 'design_score' | 'tech_spec_score' | 'assumptions_score' }> = [
    { label: 'Design', key: 'design_score' },
    { label: 'Tech Spec', key: 'tech_spec_score' },
    { label: 'Assumptions', key: 'assumptions_score' },
  ];

  return (
    <div
      className={styles.valPanel}
      style={score !== null && score !== undefined ? { borderTopColor: scoreColor(score) } : undefined}
    >
      <button
        className={styles.valPanelHeader}
        onClick={onCollapse}
        type="button"
        aria-expanded={true}
        aria-label="Collapse validation panel"
      >
        <svg className={styles.valPanelChevron} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 6l4 4 4-4" />
        </svg>
        <span className={styles.valPanelTitle}>Validation</span>
        {isValidating && !score && (
          <svg className={styles.valPanelSpinner} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
        )}
        {score !== null && score !== undefined && (
          <span
            className={styles.valPanelScoreBadge}
            style={{ background: scoreBarBg(score), color: scoreColor(score) }}
          >
            {score}%
          </span>
        )}
      </button>

      <div className={styles.valPanelBody}>
          {isValidating && !scorecard && (
            <div className={styles.valPanelValidating}>
              <svg className={styles.valPanelSpinner} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
              <span>Validation in progress…</span>
            </div>
          )}

          {features.length > 0 && (
            <div className={styles.valPanelSection}>
              <div className={styles.valPanelSectionLabel}>Section Scores</div>
              {sectionRows.map(({ label, key }) => {
                const avg = avgSection(key);
                if (avg === null) return null;
                return (
                  <div key={key} className={styles.valPanelScoreRow}>
                    <span className={styles.valPanelScoreRowLabel}>{label}</span>
                    <div className={styles.valPanelBar}>
                      <div
                        className={styles.valPanelBarFill}
                        style={{ width: `${avg}%`, background: scoreColor(avg) }}
                      />
                    </div>
                    <span className={styles.valPanelScoreRowPct} style={{ color: scoreColor(avg) }}>{avg}%</span>
                  </div>
                );
              })}
            </div>
          )}

          {allGaps.length > 0 && (
            <div className={styles.valPanelSection}>
              <div className={styles.valPanelSectionLabel}>
                Gaps{pendingCount > 0 ? ` · ${pendingCount} pending` : ''}
              </div>
              {allGaps.map((gap) => {
                const featureTitle =
                  features.find((f) => Array.isArray(f.gaps) && f.gaps.some((g) => g.id === gap.id))
                    ?.feature_title
                  ?? (features[0] as { feature_title?: string; name?: string } | undefined)?.feature_title
                  ?? (features[0] as { name?: string } | undefined)?.name
                  ?? gap.file
                  ?? 'Feature';
                return (
                  <div key={gap.id} className={`${styles.valPanelGapCard} ${gap.resolution === 'pending' ? styles.valPanelGapCardPending : styles.valPanelGapCardResolved}`}>
                    <div className={styles.valPanelGapCardHeader}>
                      <span className={`${styles.valPanelGapDot} ${gapResolutionDot(gap.resolution)}`} />
                      <span className={styles.valPanelGapDesc}>{gap.description}</span>
                    </div>
                    <div className={styles.valPanelGapMeta}>
                      {featureTitle} · {gap.section} · {gap.score}/3
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {reportMarkdown && (
            <div className={styles.valPanelSection}>
              <button
                className={styles.valPanelReportToggle}
                onClick={() => setReportExpanded((v) => !v)}
                type="button"
                aria-expanded={reportExpanded}
              >
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                  style={{ transform: reportExpanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 0.2s ease' }}
                >
                  <path d="M6 4l4 4-4 4" />
                </svg>
                Full Report
              </button>
              {reportExpanded && (
                <div className={styles.valPanelReportBody}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                    {reportMarkdown}
                  </ReactMarkdown>
                </div>
              )}
            </div>
          )}

          {!scorecard && !reportMarkdown && !isValidating && (
            <div className={styles.valPanelEmpty}>No validation data yet.</div>
          )}
      </div>
    </div>
  );
};


export const DesignDocReviewView: React.FC = () => {
  const location = useLocation();
  const id = location.pathname.split('/').pop() ?? null;
  const navigate = useNavigate();
  const { can, userId, isAdmin, isSuperAdmin } = useAppShell();
  const qc = useQueryClient();

  const { data: doc, isLoading, isError } = useDesignDoc(id);
  const { data: sourcePrd } = usePrd(doc?.prdId ?? null);
  const updateContent = useUpdateDesignDocContent();
  const submitDoc = useSubmitDesignDoc();
  const withdrawDoc = useWithdrawDesignDoc();
  const reviewDoc = useReviewDesignDoc();
  const deleteDoc = useDeleteDesignDoc();
  const markValidationReady = useMarkValidationReady();
  const refreshValidation = useRefreshValidation();
  const cancelValidation = useCancelValidation();
  const createValidationThread = useCreateValidationThread();
  const { data: validationReport } = useValidationReport(id, doc?.validationThreadId, doc?.status);
  const fixValidation = useFixValidation();
  const acceptFixValidation = useAcceptFixValidation();
  const dismissFixSession = useDismissDesignDocFixSession();
  const revertSection = useRevertDesignDocSection();
  const overrideDesignDocValidation = useOverrideDesignDocValidation();
  const fixDesignDocWithAi = useFixDesignDocWithAi(id ?? '');
  const fixDesignDocCommentWithAi = useFixDesignDocCommentWithAi(id ?? '');

  const [fixFlow, fixFlowDispatch] = useReducer(fixFlowReducer, { phase: 'idle' });
  /** Sync lock so double-clicks can't start two Fix-with-Apex runs before isPending re-renders. */
  const [apexFixStartLocked, setApexFixStartLocked] = useState(false);
  const [fixIdleNotice, setFixIdleNotice] = useState<string | null>(null);
  const [fixingCommentId, setFixingCommentId] = useState<string | null>(null);
  const [bulkCommentFixRunning, setBulkCommentFixRunning] = useState(false);

  const { data: reviewComments = [] } = useReviewComments(id, 'design_doc');
  const { data: unresolvedData } = useUnresolvedCommentCount(id, 'design_doc');
  const unresolvedCount = unresolvedData?.count ?? 0;
  const createComment = useCreateComment('design_doc', id);
  const resolveComment = useResolveComment(userId ?? '');
  const reopenReviewComment = useReopenReviewComment();
  const deleteComment = useDeleteComment();

  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [pendingSelector, setPendingSelector] = useState<{ sectionKey: ReviewSectionKey; selector: TextSelector } | null>(null);
  const [newCommentBody, setNewCommentBody] = useState('');

  const clearLocalFixSession = useCallback((docId: string) => {
    clearApexFixInProgress('design-doc-validation', docId);
    setApexFixStartLocked(false);
  }, []);

  // TanStack rebuilds the mutation object on every render, so effects that
  // dismiss a fix session must depend on a stable callback instead — otherwise
  // they re-fire each render and hammer the thread-status endpoint.
  const dismissFixSessionRef = useRef(dismissFixSession);
  useEffect(() => {
    dismissFixSessionRef.current = dismissFixSession;
  });
  const dismissFixSessionAsync = useCallback(
    (docId: string) => dismissFixSessionRef.current.mutateAsync(docId),
    [],
  );

  // Restore validation fix flow from server fixBaseline after navigation.
  // Skip while re-validation is in progress — otherwise a leftover baseline
  // immediately reopens the "No changes" panel over the validating UI.
  useEffect(() => {
    if (!doc || fixFlow.phase !== 'idle') return;
    if (!doc.fixBaseline) return;
    if (doc.status === 'validating') return;

    const baseline = doc.fixBaseline as ContentSnapshot;
    const threadId = baseline.fixThreadId ?? doc.docAssistantThreadId;
    if (!threadId) return;

    let cancelled = false;

    (async () => {
      if (!readApexFixInProgress('design-doc-validation', doc.id)) {
        markApexFixInProgress('design-doc-validation', doc.id, { threadId });
      }
      const thread = await fetchChatThreadStatus(threadId);
      if (cancelled) return;
      if (thread && !isTerminalChatThreadStatus(thread.status)) {
        fixFlowDispatch({ type: 'START_FIX', baseline, threadId });
        return;
      }
      if (thread && isTerminalChatThreadStatus(thread.status)) {
        await qc.refetchQueries({ queryKey: ['design-doc', doc.id] });
        if (cancelled) return;
        const fresh = qc.getQueryData<{
          designContent: string;
          techSpecContent: string;
          assumptionsContent: string;
        }>(['design-doc', doc.id]);
        const unchanged = !!fresh
          && fresh.designContent === baseline.design
          && fresh.techSpecContent === baseline.techSpec
          && fresh.assumptionsContent === baseline.assumptions;
        clearLocalFixSession(doc.id);
        if (unchanged) {
          try {
            await dismissFixSessionAsync(doc.id);
          } catch { /* fall through to review panel if dismiss fails */ }
          if (cancelled) return;
          setFixIdleNotice(
            agentErrorFromChatThreadStatus(thread.status, thread.lastError)
              ?? 'No changes applied. You can try Fix with Apex again.',
          );
          fixFlowDispatch({ type: 'RESET' });
          return;
        }
        const res = await fetch(`/api/chat/threads/${threadId}`, { credentials: 'include' });
        const fullThread = res.ok ? await res.json() : null;
        const gapChanges = parseGapChangesFromMessages(fullThread?.messages ?? []);
        fixFlowDispatch({ type: 'START_FIX', baseline, threadId });
        fixFlowDispatch({
          type: 'FIX_COMPLETE',
          gapChanges,
          agentError: agentErrorFromChatThreadStatus(thread.status, thread.lastError),
        });
        return;
      }
      // Thread not found — treat as completed with error so the UI doesn't get stuck
      clearLocalFixSession(doc.id);
      fixFlowDispatch({ type: 'START_FIX', baseline, threadId });
      fixFlowDispatch({
        type: 'FIX_COMPLETE',
        gapChanges: [],
        agentError: 'The fix session is no longer available. You can try again.',
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [doc?.id, doc?.fixBaseline, doc?.docAssistantThreadId, doc?.status, fixFlow.phase, qc, clearLocalFixSession, dismissFixSessionAsync]);

  const [activeTab, setActiveTab] = useState<TabId>('design');

  const markdownComponents: Components = useMemo(() => ({
    h1({ children, ...props }) {
      return <h1 id={slugify(nodeToText(children))} {...props}>{children}</h1>;
    },
    h2({ children, ...props }) {
      return <h2 id={slugify(nodeToText(children))} {...props}>{children}</h2>;
    },
    h3({ children, ...props }) {
      return <h3 id={slugify(nodeToText(children))} {...props}>{children}</h3>;
    },
    code({ className, children, ...props }) {
      const language = /language-(\w+)/.exec(className ?? '')?.[1];
      const code = String(children).replace(/\n$/, '');

      if (language === 'mermaid') {
        return <MermaidDiagram chart={code} />;
      }

      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    },
    a({ href, children, ...props }) {
      if (href) {
        if (href.endsWith('-assumptions.md') || href === 'assumptions.md') {
          return (
            <button
              type="button"
              onClick={() => setActiveTab('assumptions')}
              style={{ color: 'var(--accent-color)', background: 'none', border: 'none', padding: 0, cursor: 'pointer', textDecoration: 'underline' }}
              {...{ 'data-testid': 'dd-markdown-assumptions-link' }}
            >
              {children}
            </button>
          );
        }
        if (href.endsWith('-tech-spec.md') || href === 'tech-spec.md') {
          return (
            <button
              type="button"
              onClick={() => setActiveTab('tech-spec')}
              style={{ color: 'var(--accent-color)', background: 'none', border: 'none', padding: 0, cursor: 'pointer', textDecoration: 'underline' }}
              {...{ 'data-testid': 'dd-markdown-tech-spec-link' }}
            >
              {children}
            </button>
          );
        }
        if (href.endsWith('-design.md') || href === 'design.md') {
          return (
            <button
              type="button"
              onClick={() => setActiveTab('design')}
              style={{ color: 'var(--accent-color)', background: 'none', border: 'none', padding: 0, cursor: 'pointer', textDecoration: 'underline' }}
              {...{ 'data-testid': 'dd-markdown-design-link' }}
            >
              {children}
            </button>
          );
        }
      }
      return (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          {...props}
          {...{ 'data-testid': 'dd-markdown-external-link' }}
        >
          {children}
        </a>
      );
    },
  }), []);

  // Per-tab edit state
  const [editingTab, setEditingTab] = useState<TabId | null>(null);
  const [designEdit, setDesignEdit] = useState('');
  const [techSpecEdit, setTechSpecEdit] = useState('');
  const [assumptionsEdit, setAssumptionsEdit] = useState('');
  const [dirtyTabs, setDirtyTabs] = useState<Set<TabId>>(new Set());

  const reassignApprovers = useReassignApprovers();

  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showApproverModal, setShowApproverModal] = useState(false);
  const [showReassignModal, setShowReassignModal] = useState(false);
  const [showOverrideModal, setShowOverrideModal] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [discussContext, setDiscussContext] = useState<DiscussContext | null>(null);
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const actionMenuRef = useRef<HTMLDivElement>(null);

  // ── 3-zone workspace layout state (outline rail + center + pinned pane) ──────
  const [pinnedTab, setPinnedTab] = useState<TabId | null>(null);
  const [pinnedWidth, setPinnedWidth] = useState(DEFAULT_PINNED_WIDTH);
  const [isDraggingPinned, setIsDraggingPinned] = useState(false);
  const [outlineCollapsed, setOutlineCollapsed] = useState(false);
  const [activeHeadingId, setActiveHeadingId] = useState<string | null>(null);
  const centerScrollRef = useRef<HTMLDivElement | null>(null);
  const pinnedDragStartXRef = useRef(0);
  const pinnedDragStartWidthRef = useRef(DEFAULT_PINNED_WIDTH);

  // Right rails: Comments + Validation — collapsed by default so the doc is readable
  const [commentsPanelCollapsed, setCommentsPanelCollapsed] = useState(true);
  const [validationPanelCollapsed, setValidationPanelCollapsed] = useState(true);

  // Center split pane (Design + Tech Spec side by side)
  const [splitTab, setSplitTab] = useState<Exclude<TabId, 'validation'> | null>(null);
  const [splitPercent, setSplitPercent] = useState(DEFAULT_SPLIT_PERCENT);
  const [isDraggingSplit, setIsDraggingSplit] = useState(false);
  const splitDragStartXRef = useRef(0);
  const splitDragStartPercentRef = useRef(DEFAULT_SPLIT_PERCENT);
  const tabContentSplitRef = useRef<HTMLDivElement>(null);
  // Restore React-owned text before this render's commit (tab/split remounts).
  unwrapCommentMarks(tabContentSplitRef.current);

  const {
    data: assignments = [],
    isLoading: assignmentsLoading,
    isError: assignmentsError,
  } = useDocumentAssignments(id, 'design_doc');
  useDesignDocOwnerApproval(id);
  const ownerApproveMutation = useDesignDocOwnerApprove(id);

  const retryGenerate = useRetryGenerateDesignDoc();

  const isGenerating = !!doc && doc.status === 'generating' && (
    doc.designContent === '' || doc.techSpecContent === '' || doc.assumptionsContent === ''
  );
  const isGenerationFailed = !!doc && doc.status === 'generation_failed';

  const handleDownload = useCallback(() => {
    if (!doc) return;
    const exportName = sanitizeArtifactName(doc.title, 'design-doc');
    downloadArtifactZip(`${exportName}-design-doc.zip`, [
      { name: 'design.md', content: doc.designContent ?? '' },
      { name: 'tech-spec.md', content: doc.techSpecContent ?? '' },
      { name: 'assumptions.md', content: doc.assumptionsContent ?? '' },
    ]);
  }, [doc]);

  const handleEditToggle = useCallback((tab: TabId) => {
    if (!doc) return;
    if (editingTab === tab) {
      // Toggle off — discard
      if (tab === 'design') setDesignEdit(doc.designContent);
      if (tab === 'tech-spec') setTechSpecEdit(doc.techSpecContent);
      if (tab === 'assumptions') setAssumptionsEdit(doc.assumptionsContent);
      setDirtyTabs((prev) => { const s = new Set(prev); s.delete(tab); return s; });
      setEditingTab(null);
    } else {
      // Toggle on
      if (tab === 'design') setDesignEdit(doc.designContent);
      if (tab === 'tech-spec') setTechSpecEdit(doc.techSpecContent);
      if (tab === 'assumptions') setAssumptionsEdit(doc.assumptionsContent);
      setEditingTab(tab);
    }
  }, [doc, editingTab]);

  const handleEditChange = useCallback((tab: TabId, value: string) => {
    if (tab === 'design') setDesignEdit(value);
    if (tab === 'tech-spec') setTechSpecEdit(value);
    if (tab === 'assumptions') setAssumptionsEdit(value);
    setDirtyTabs((prev) => new Set(prev).add(tab));
  }, []);

  const handleSave = useCallback(async (tab: TabId) => {
    if (!id || !doc) return;
    const body: { designContent?: string; techSpecContent?: string; assumptionsContent?: string } = {};
    if (tab === 'design') body.designContent = designEdit;
    if (tab === 'tech-spec') body.techSpecContent = techSpecEdit;
    if (tab === 'assumptions') body.assumptionsContent = assumptionsEdit;
    await updateContent.mutateAsync({ designDocId: id, ...body });
    setDirtyTabs((prev) => { const s = new Set(prev); s.delete(tab); return s; });
    setEditingTab(null);
  }, [id, doc, designEdit, techSpecEdit, assumptionsEdit, updateContent]);

  const handleDiscard = useCallback((tab: TabId) => {
    if (!doc) return;
    if (tab === 'design') setDesignEdit(doc.designContent);
    if (tab === 'tech-spec') setTechSpecEdit(doc.techSpecContent);
    if (tab === 'assumptions') setAssumptionsEdit(doc.assumptionsContent);
    setDirtyTabs((prev) => { const s = new Set(prev); s.delete(tab); return s; });
    setEditingTab(null);
  }, [doc]);

  const handleSubmit = useCallback(async () => {
    if (!id) return;
    await submitDoc.mutateAsync({
      designDocId: id,
      approverIds: assignments.length > 0
        ? assignments.map((a) => a.approverUserId)
        : [],
    });
  }, [id, assignments, submitDoc]);

  const handleApproverConfirm = useCallback(async (selections: { approverIds?: string[] }) => {
    if (!id) return;
    await submitDoc.mutateAsync({
      designDocId: id,
      approverIds: selections.approverIds ?? [],
    });
    setShowApproverModal(false);
  }, [id, submitDoc]);

  const handleReassignConfirm = useCallback(async (selections: { approverIds?: string[] }) => {
    if (!id) return;
    await reassignApprovers.mutateAsync({
      documentId: id,
      documentType: 'design_doc',
      approverUserIds: selections.approverIds ?? [],
    });
    setShowReassignModal(false);
  }, [id, reassignApprovers]);

  const handleWithdraw = useCallback(async () => {
    if (!id) return;
    await withdrawDoc.mutateAsync(id);
  }, [id, withdrawDoc]);

  const handleApprove = useCallback(async () => {
    if (!id) return;
    await reviewDoc.mutateAsync({ designDocId: id, action: 'approve' });
  }, [id, reviewDoc]);

  const handleOwnerApprove = useCallback(async () => {
    if (!id) return;
    await ownerApproveMutation.mutateAsync({ status: 'approved' });
  }, [id, ownerApproveMutation]);

  const handleMarkValidationReady = useCallback(async () => {
    if (!id) return;
    await markValidationReady.mutateAsync(id);
  }, [id, markValidationReady]);

  const handleOverrideValidation = useCallback(async (reason: string) => {
    if (!id) return;
    await overrideDesignDocValidation.mutateAsync({ designDocId: id, reason });
    setShowOverrideModal(false);
  }, [id, overrideDesignDocValidation]);

  // ── Fix Validation Flow handlers ─────────────────────────────────────────

  const handleStartFixWithAI = useCallback(async () => {
    if (!id || !doc) return;
    if (apexFixStartLocked || fixValidation.isPending) return;
    // Block only while a run is actively in flight — allow Retry from reviewing.
    if (fixFlow.phase === 'fixing') return;
    // Only defer to a same-tab marker when the server still has an open fix
    // session; a stale marker alone must not swallow the click.
    if (
      fixFlow.phase === 'idle'
      && doc.fixBaseline
      && readApexFixInProgress('design-doc-validation', id)
    ) return;

    setFixIdleNotice(null);

    // Leaving a prior review/discuss session: clear server baseline so restore
    // cannot yank the UI back into the stale "No changes" panel.
    if (fixFlow.phase === 'reviewing' || fixFlow.phase === 'discussing' || doc.fixBaseline) {
      clearLocalFixSession(id);
      fixFlowDispatch({ type: 'RESET' });
      try {
        if (doc.fixBaseline) {
          await dismissFixSessionAsync(id);
        }
      } catch { /* start a new fix even if dismiss races */ }
    }

    const baseline: ContentSnapshot = {
      design: doc.designContent,
      techSpec: doc.techSpecContent,
      assumptions: doc.assumptionsContent,
      capturedAt: new Date().toISOString(),
    };
    setApexFixStartLocked(true);
    markApexFixInProgress('design-doc-validation', id);
    try {
      const result = await fixValidation.mutateAsync(id);
      markApexFixInProgress('design-doc-validation', id, { threadId: result.threadId });
      fixFlowDispatch({ type: 'START_FIX', baseline, threadId: result.threadId });
    } catch {
      clearLocalFixSession(id);
      fixFlowDispatch({ type: 'RESET' });
    }
  }, [
    id,
    doc,
    fixValidation,
    fixFlow.phase,
    apexFixStartLocked,
    clearLocalFixSession,
    dismissFixSessionAsync,
  ]);

  // Poll the assistant thread status during the fixing phase.
  // Only transition to reviewing once the agent is terminal (done with all MCP calls).
  useEffect(() => {
    if (fixFlow.phase !== 'fixing' || !id) return;
    const { threadId, baseline } = fixFlow;
    let cancelled = false;

    let notFoundCount = 0;
    const poll = async () => {
      try {
        const thread = await fetchChatThreadStatus(threadId);
        if (cancelled) return;
        if (!thread) {
          notFoundCount++;
          if (notFoundCount >= 3) {
            clearLocalFixSession(id);
            fixFlowDispatch({
              type: 'FIX_COMPLETE',
              gapChanges: [],
              agentError: 'The fix session is no longer available. You can try again.',
            });
          }
          return;
        }
        notFoundCount = 0;
        if (isTerminalChatThreadStatus(thread.status)) {
          await qc.refetchQueries({ queryKey: ['design-doc', id] });
          const fresh = qc.getQueryData<{
            designContent: string;
            techSpecContent: string;
            assumptionsContent: string;
          }>(['design-doc', id]);
          const unchanged = !!fresh
            && fresh.designContent === baseline.design
            && fresh.techSpecContent === baseline.techSpec
            && fresh.assumptionsContent === baseline.assumptions;
          const agentError = agentErrorFromChatThreadStatus(thread.status, thread.lastError);
          if (cancelled) return;

          clearLocalFixSession(id);
          if (unchanged) {
            try {
              await dismissFixSessionAsync(id);
            } catch { /* show review panel fallback */ }
            if (cancelled) return;
            setFixIdleNotice(
              agentError
                ? `${agentError} No changes were applied.`
                : 'No changes applied. You can try Fix with Apex again.',
            );
            fixFlowDispatch({ type: 'RESET' });
            return;
          }

          const res = await fetch(`/api/chat/threads/${threadId}`, { credentials: 'include' });
          const fullThread = res.ok ? await res.json() : null;
          const gapChanges = parseGapChangesFromMessages(fullThread?.messages ?? []);
          if (!cancelled) {
            fixFlowDispatch({ type: 'FIX_COMPLETE', gapChanges, agentError });
          }
        }
      } catch { /* keep polling */ }
    };

    void poll();
    const interval = window.setInterval(() => {
      if (!cancelled) void poll();
    }, 5_000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [fixFlow, id, qc, clearLocalFixSession, dismissFixSessionAsync]);

  // Hard wall-clock timeout so the fixing overlay can never spin indefinitely.
  useEffect(() => {
    if (fixFlow.phase !== 'fixing' || !id) return;
    const timeoutId = window.setTimeout(() => {
      clearLocalFixSession(id);
      void cancelChatThread(fixFlow.threadId);
      fixFlowDispatch({
        type: 'FIX_COMPLETE',
        gapChanges: [],
        agentError: 'The fix took too long and was stopped. You can try again.',
      });
    }, APEX_FIX_TIMEOUT_MS);
    return () => window.clearTimeout(timeoutId);
  }, [fixFlow, id, clearLocalFixSession]);

  const handleFixAcceptSection = useCallback((_section: 'design' | 'tech-spec' | 'assumptions') => {
    // Accept = keep current AI changes (already persisted) — no-op on server
  }, []);

  const handleFixRevertSection = useCallback(async (section: 'design' | 'tech-spec' | 'assumptions') => {
    if (!id || fixFlow.phase === 'idle') return;
    const bl = (fixFlow as any).baseline as ContentSnapshot;
    const body: { designDocId: string; designContent?: string; techSpecContent?: string; assumptionsContent?: string } = { designDocId: id };
    if (section === 'design') body.designContent = bl.design;
    if (section === 'tech-spec') body.techSpecContent = bl.techSpec;
    if (section === 'assumptions') body.assumptionsContent = bl.assumptions;
    await revertSection.mutateAsync(body);
  }, [id, fixFlow, revertSection]);

  const handleFixDiscuss = useCallback((section: 'design' | 'tech-spec' | 'assumptions') => {
    fixFlowDispatch({ type: 'START_DISCUSS', activeSection: section });

    const sectionLabels = { 'design': 'Design', 'tech-spec': 'Tech Spec', 'assumptions': 'Assumptions' } as const;
    const mapGapSection = (gap: ValidationScorecardGap): 'design' | 'tech-spec' | 'assumptions' => {
      const file = (gap.file ?? '').toLowerCase();
      if (file.includes('tech') || file === 'tech-spec' || file === 'tech_spec') return 'tech-spec';
      if (file.includes('assumption')) return 'assumptions';
      if (file.includes('design')) return 'design';
      const s = gap.section.toLowerCase();
      if (s.includes('tech') || s.includes('spec')) return 'tech-spec';
      if (s.includes('assumption')) return 'assumptions';
      return 'design';
    };

    const allGaps = collectValidationGaps(doc?.validationScorecard);
    const sectionGaps = allGaps.filter((g) => mapGapSection(g) === section);
    const sectionGapIds = new Set(sectionGaps.map((g) => g.id));
    const allGapChanges = (fixFlow.phase === 'reviewing' || fixFlow.phase === 'discussing')
      ? fixFlow.gapChanges
      : [];
    const sectionGapChanges = allGapChanges.filter((c) => sectionGapIds.has(c.gap_id));

    setDiscussContext({
      section,
      sectionLabel: sectionLabels[section],
      gaps: sectionGaps,
      gapChanges: sectionGapChanges,
    });
    setAssistantOpen(true);
  }, [doc?.validationScorecard, fixFlow]);

  const handleFixApplyAndRevalidate = useCallback(async () => {
    if (!id) return;
    setFixIdleNotice(null);
    try {
      await acceptFixValidation.mutateAsync(id);
    } finally {
      clearLocalFixSession(id);
      fixFlowDispatch({ type: 'RESET' });
    }
  }, [id, acceptFixValidation, clearLocalFixSession]);

  const handleFixRevertAll = useCallback(async () => {
    if (!id || fixFlow.phase === 'idle') return;
    const bl = (fixFlow as any).baseline as ContentSnapshot;
    await revertSection.mutateAsync({
      designDocId: id,
      designContent: bl.design,
      techSpecContent: bl.techSpec,
      assumptionsContent: bl.assumptions,
    });
    try {
      await dismissFixSessionAsync(id);
    } catch { /* content already reverted */ }
    clearLocalFixSession(id);
    setFixIdleNotice(null);
    fixFlowDispatch({ type: 'RESET' });
  }, [id, fixFlow, revertSection, dismissFixSessionAsync, clearLocalFixSession]);

  const handleFixCancel = useCallback(() => {
    const threadId =
      fixFlow.phase === 'fixing'
        ? fixFlow.threadId
        : (doc?.docAssistantThreadId ?? undefined);
    if (threadId) void cancelChatThread(threadId);
    if (id) {
      clearLocalFixSession(id);
      if (doc?.fixBaseline) {
        void dismissFixSessionAsync(id).catch(() => {});
      }
    }
    setFixIdleNotice(null);
    fixFlowDispatch({ type: 'RESET' });
  }, [id, fixFlow, doc?.docAssistantThreadId, doc?.fixBaseline, dismissFixSessionAsync, clearLocalFixSession]);

  // Once Accept kicks off re-validation, drop leftover Fix-with-Apex UI so the
  // "fixing validation gaps" spinner cannot sit on top of VALIDATING.
  useEffect(() => {
    if (!id || !doc) return;
    if (doc.status !== 'validating') return;
    if (doc.fixBaseline) return;
    clearLocalFixSession(id);
    setFixIdleNotice(null);
    if (fixFlow.phase === 'fixing' || fixFlow.phase === 'reviewing' || fixFlow.phase === 'discussing') {
      fixFlowDispatch({ type: 'RESET' });
    }
  }, [id, doc, fixFlow.phase, clearLocalFixSession]);

  // When the assistant panel closes during discuss phase, return to reviewing
  const handleAssistantClose = useCallback(() => {
    setAssistantOpen(false);
    setDiscussContext(null);
    if (fixFlow.phase === 'discussing') {
      fixFlowDispatch({ type: 'END_DISCUSS' });
    }
  }, [fixFlow.phase]);

  // ── Workspace layout handlers ────────────────────────────────────────────
  // Selecting a tab brings it to the center pane; if it was pinned, unpin it so
  // the same section never shows in both places at once.
  const selectTab = useCallback((tab: TabId) => {
    unwrapCommentMarks(tabContentSplitRef.current);
    setActiveTab(tab);
    setPinnedTab((prev) => (prev === tab ? null : prev));
  }, []);

  // Pinning a tab sends it to the right-hand reference pane. If the pinned tab
  // is currently active in the center, move the center to another available tab.
  const handlePinTab = useCallback((tab: TabId) => {
    unwrapCommentMarks(tabContentSplitRef.current);
    setPinnedTab((prev) => (prev === tab ? null : tab));
    setActiveTab((cur) => {
      if (cur !== tab) return cur;
      const order: TabId[] = ['design', 'tech-spec', 'assumptions', 'validation'];
      const next = order.find((o) => o !== tab && (o !== 'validation' || !!doc?.validationThreadId));
      return next ?? cur;
    });
  }, [doc?.validationThreadId]);

  const handleOutlineClick = useCallback((id: string) => {
    const container = centerScrollRef.current;
    if (!container) return;
    const el = container.querySelector(`#${CSS.escape(id)}`) as HTMLElement | null;
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setActiveHeadingId(id);
    }
  }, []);

  const handlePinnedResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    pinnedDragStartXRef.current = e.clientX;
    pinnedDragStartWidthRef.current = pinnedWidth;
    setIsDraggingPinned(true);
  }, [pinnedWidth]);

  useEffect(() => {
    if (!isDraggingPinned) return;
    const onMove = (e: MouseEvent) => {
      const delta = pinnedDragStartXRef.current - e.clientX;
      const next = Math.min(MAX_PINNED_WIDTH, Math.max(MIN_PINNED_WIDTH, pinnedDragStartWidthRef.current + delta));
      setPinnedWidth(next);
    };
    const onUp = () => setIsDraggingPinned(false);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [isDraggingPinned]);

  const handleSplitTab = useCallback((tab: Exclude<TabId, 'validation'>) => {
    unwrapCommentMarks(tabContentSplitRef.current);
    setSplitTab((prev) => (prev === tab ? null : tab));
    // If the chosen tab is currently active in center, swap center to the other content tab
    setActiveTab((cur) => {
      if (cur !== tab) return cur;
      const order: Array<Exclude<TabId, 'validation'>> = ['design', 'tech-spec', 'assumptions'];
      return order.find((o) => o !== tab) ?? cur;
    });
  }, []);

  const handleSplitResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    splitDragStartXRef.current = e.clientX;
    splitDragStartPercentRef.current = splitPercent;
    setIsDraggingSplit(true);
  }, [splitPercent]);

  useEffect(() => {
    if (!isDraggingSplit) return;
    const onMove = (e: MouseEvent) => {
      const container = tabContentSplitRef.current;
      if (!container) return;
      const containerWidth = container.getBoundingClientRect().width;
      if (containerWidth === 0) return;
      // Right pane starts where the mouse divides the container.
      // Mouse position relative to container right edge = new right pane width.
      const containerRight = container.getBoundingClientRect().right;
      const rightWidth = containerRight - e.clientX;
      const newPercent = Math.min(MAX_SPLIT_PERCENT, Math.max(MIN_SPLIT_PERCENT, rightWidth / containerWidth));
      setSplitPercent(newPercent);
    };
    const onUp = () => setIsDraggingSplit(false);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [isDraggingSplit]);

  // Scrollspy: highlight the outline entry for the topmost visible heading.
  useEffect(() => {
    const container = centerScrollRef.current;
    if (!container) return;
    const headings = Array.from(container.querySelectorAll('h1[id], h2[id], h3[id]')) as HTMLElement[];
    if (headings.length === 0) {
      setActiveHeadingId(null);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) setActiveHeadingId((visible[0].target as HTMLElement).id);
      },
      { root: container, rootMargin: '0px 0px -70% 0px', threshold: 0 },
    );
    headings.forEach((h) => observer.observe(h));
    return () => observer.disconnect();
  }, [
    activeTab,
    pinnedTab,
    editingTab,
    designEdit,
    techSpecEdit,
    assumptionsEdit,
    doc?.designContent,
    doc?.techSpecContent,
    doc?.assumptionsContent,
    validationReport?.markdown,
    doc?.validationReportMd,
  ]);

  // When the validation report first appears while the doc is still validating,
  // auto-trigger a score refresh so the DB/status update happens without user action.
  const didAutoRefreshRef = useRef(false);
  const prevThreadIdRef = useRef(doc?.validationThreadId);
  useEffect(() => {
    if (doc?.validationThreadId !== prevThreadIdRef.current) {
      prevThreadIdRef.current = doc?.validationThreadId;
      didAutoRefreshRef.current = false;
    }
  }, [doc?.validationThreadId]);
  useEffect(() => {
    if (
      validationReport?.markdown &&
      doc?.status === 'validating' &&
      id &&
      !didAutoRefreshRef.current &&
      !refreshValidation.isPending
    ) {
      didAutoRefreshRef.current = true;
      refreshValidation.mutate(id);
    }
  }, [validationReport, doc?.status, id, refreshValidation]);

  const sectionKeyToTab: Record<string, TabId> = {
    'design': 'design',
    'tech_spec': 'tech-spec',
    'assumptions': 'assumptions',
  };

  const expandCommentsPanel = useCallback(() => {
    setCommentsPanelCollapsed(false);
    setValidationPanelCollapsed(true);
  }, []);

  const expandValidationPanel = useCallback(() => {
    setValidationPanelCollapsed(false);
    setCommentsPanelCollapsed(true);
  }, []);

  const toggleCommentsPanel = useCallback(() => {
    setCommentsPanelCollapsed((collapsed) => {
      if (collapsed) setValidationPanelCollapsed(true);
      return !collapsed;
    });
  }, []);

  const toggleValidationPanel = useCallback(() => {
    setValidationPanelCollapsed((collapsed) => {
      if (collapsed) setCommentsPanelCollapsed(true);
      return !collapsed;
    });
  }, []);

  const handleCommentClick = useCallback((commentId: string) => {
    const comment = reviewComments.find((c) => c.id === commentId);
    if (comment) {
      const targetTab = sectionKeyToTab[comment.sectionKey];
      if (targetTab) setActiveTab(targetTab);
    }
    setActiveCommentId(commentId);
    expandCommentsPanel();
  }, [reviewComments, expandCommentsPanel]);

  const handleAddComment = useCallback((sectionKey: ReviewSectionKey, selector: TextSelector) => {
    setPendingSelector({ sectionKey, selector });
    setNewCommentBody('');
    expandCommentsPanel();
  }, [expandCommentsPanel]);

  const handleSubmitComment = useCallback(async () => {
    if (!pendingSelector || !newCommentBody.trim()) return;
    await createComment.mutateAsync({
      sectionKey: pendingSelector.sectionKey,
      body: newCommentBody.trim(),
      selector: pendingSelector.selector,
    });
    setPendingSelector(null);
    setNewCommentBody('');
  }, [pendingSelector, newCommentBody, createComment]);

  const handleCommentReply = useCallback(async (commentId: string, body: string) => {
    await fetch(`/api/review-comments/${commentId}/replies`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ body }),
    });
  }, []);

  const handleFixCommentWithAi = useCallback(async (commentId: string) => {
    if (!id) return;
    setFixingCommentId(commentId);
    try {
      await fixDesignDocCommentWithAi.mutateAsync({ commentId });
    } finally {
      setFixingCommentId(null);
    }
  }, [id, fixDesignDocCommentWithAi]);

  const handleFixAllCommentsWithAi = useCallback(async () => {
    if (!id) return;
    markApexFixInProgress('design-doc-comments-bulk', id);
    setBulkCommentFixRunning(true);
    try {
      await fixDesignDocWithAi.mutateAsync();
    } catch {
      clearApexFixInProgress('design-doc-comments-bulk', id);
      setBulkCommentFixRunning(false);
    }
  }, [id, fixDesignDocWithAi]);

  // Recover in-progress comment fixes after navigation.
  useEffect(() => {
    if (!doc || !id) return;
    if (isDesignDocSingleCommentFixPending(doc)) {
      setFixingCommentId(doc.fixCommentId ?? null);
    }
    const bulkSession = readApexFixInProgress('design-doc-comments-bulk', id);
    if (bulkSession && !designDocHasProposedChanges(doc)) {
      setBulkCommentFixRunning(true);
    } else if (bulkSession && designDocHasProposedChanges(doc)) {
      clearApexFixInProgress('design-doc-comments-bulk', id);
      setBulkCommentFixRunning(false);
    }
  }, [doc, id]);

  useEffect(() => {
    if (!doc || !id || !bulkCommentFixRunning) return;
    if (designDocHasProposedChanges(doc)) {
      clearApexFixInProgress('design-doc-comments-bulk', id);
      setBulkCommentFixRunning(false);
    }
  }, [doc, id, bulkCommentFixRunning]);

  useEffect(() => {
    if (!id || !bulkCommentFixRunning) return;
    const interval = window.setInterval(() => {
      void qc.refetchQueries({ queryKey: ['design-doc', id] });
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [id, bulkCommentFixRunning, qc]);

  useEffect(() => {
    if (!id || fixFlow.phase !== 'idle') return;
    const session = readApexFixInProgress('design-doc-validation', id);
    if (!session || doc?.fixBaseline) return;
    const interval = window.setInterval(() => {
      void qc.refetchQueries({ queryKey: ['design-doc', id] });
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [id, doc?.fixBaseline, fixFlow.phase, qc]);

  useEffect(() => {
    if (!actionMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (actionMenuRef.current?.contains(event.target as Node)) return;
      setActionMenuOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setActionMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [actionMenuOpen]);

  if (isLoading) {
    return (
      <div className={styles.loadingState} role="status" aria-busy="true" aria-label="Loading Design Doc">
        <ApexLoader size={72} />
        <div className={styles.loadingLabel}>Loading Design Doc…</div>
      </div>
    );
  }
  if (isError || !doc) return <div className={styles.errorState}>Design doc not found.</div>;

  const isAuthor = doc.authorId === userId;
  const isOwner = doc.ownerId === userId;
  const ownerOnly = !assignmentsLoading && !assignmentsError && assignments.length === 0;
  const isOwnerActor = (doc.ownerId ? isOwner : isAuthor) || isSuperAdmin;
  const validationThreshold = doc.validationScoreThreshold ?? 90;
  const scoreBelowThreshold =
    doc.validationScore !== undefined &&
    doc.validationScore !== null &&
    doc.validationScore < validationThreshold;
  const hasValidationOverride = !!doc.validationOverride;
  const validationBlocking = scoreBelowThreshold && !hasValidationOverride;
  const canManage = can('interviews:manage');
  const canReview = can('design-docs:review');
  const isAssignedApprover = assignments.some((a) => a.approverUserId === userId);
  const isReviewer = canReview && (!isAuthor || isAdmin) && (!isOwner || isAdmin);
  const canPerformReview = !ownerOnly && isReviewer && (isAssignedApprover || isAdmin);
  const showOwnerApproveButton =
    (doc.status === 'reviewer_approved' || (ownerOnly && doc.status === 'pending_review'))
    && (isOwnerActor || ownerOnly);
  const canEdit = canManage && (isAuthor || isOwner || isAdmin) && doc.status !== 'approved' && doc.status !== 'reviewer_approved';
  const canUseAssistant = (isReviewer || isOwner || isAuthor || isAdmin) &&
    (doc.status === 'draft' || doc.status === 'pending_review' || doc.status === 'reviewer_approved' || doc.status === 'revision_requested');

  // The server's fixBaseline is the source of truth for an open fix session; the
  // sessionStorage marker is only a same-tab hint. Honouring a marker with no
  // baseline behind it would keep Fix-with-Apex disabled until the 30-minute TTL.
  const validationFixSession = id && doc.fixBaseline
    ? readApexFixInProgress('design-doc-validation', id)
    : null;
  const isFixWithApexBusy =
    apexFixStartLocked
    || fixFlow.phase !== 'idle'
    || fixValidation.isPending
    || !!validationFixSession
    || doc.status === 'validating';
  const apexFixRunningBanner = (() => {
    // Re-validation owns the page — never leave the Fix spinner sitting on top
    // of VALIDATING, even if a fix session is still recorded on the doc.
    if (doc.status === 'validating') {
      return null;
    }
    // Only while actively starting/running — not during reviewing (locks must not keep this up).
    if (fixFlow.phase === 'fixing' || (apexFixStartLocked && fixFlow.phase === 'idle')) {
      return {
        title: 'Apex is fixing validation gaps…',
        subtitle: 'You can leave this page — progress will resume when you return.',
        hint: 'Typically 1–3 min',
        showCancel: fixFlow.phase === 'fixing',
      };
    }
    // Sticky resume only while a real fix session is still open on the server.
    if (validationFixSession && fixFlow.phase === 'idle' && doc.fixBaseline) {
      return {
        title: 'Apex is fixing validation gaps…',
        subtitle: 'You can leave this page — progress will resume when you return.',
        hint: 'Typically 1–3 min',
        showCancel: false,
      };
    }
    if (bulkCommentFixRunning || fixDesignDocWithAi.isPending) {
      return {
        title: 'Apex is applying review comment fixes…',
        subtitle: 'Proposed changes will appear here when complete.',
        hint: undefined as string | undefined,
        showCancel: false,
      };
    }
    if (fixingCommentId || isDesignDocSingleCommentFixPending(doc)) {
      return {
        title: 'Apex is fixing a review comment…',
        subtitle: 'The proposed edit will appear when complete.',
        hint: undefined as string | undefined,
        showCancel: false,
      };
    }
    return null;
  })();
  const isBulkCommentFixing = bulkCommentFixRunning || fixDesignDocWithAi.isPending;
  const canWriteAssistant = canEdit || canPerformReview || isOwner || isAuthor;

  const hasAnyContent = !!(doc.designContent || doc.techSpecContent || doc.assumptionsContent);
  const hasValidationTab = !!doc.validationThreadId;
  const canManageAuthorActions = canManage && (isAuthor || isOwner || isAdmin);
  const canRunValidationAction =
    canManageAuthorActions &&
    hasAnyContent &&
    (doc.status === 'draft' || doc.status === 'pending_review' || doc.status === 'revision_requested');
  const canWithdrawAction = canManageAuthorActions && doc.status === 'pending_review';
  const canShowApproversAction = !ownerOnly && doc.status === 'pending_review';
  const canDeleteDocAction = canManageAuthorActions;
  const canShowHeaderActionMenu =
    canRunValidationAction ||
    canWithdrawAction ||
    canShowApproversAction ||
    canDeleteDocAction;
  const approverDisplayNames = assignments.map(
    (a) => a.approverDisplayName ?? a.approverUserId,
  );

  const showCommentLayer =
    (doc.status === 'pending_review' || doc.status === 'reviewer_approved' || doc.status === 'revision_requested') &&
    (ownerOnly || canPerformReview || isOwner || isAuthor || isAdmin);

  const tabToSectionKey: Record<string, ReviewSectionKey> = {
    'design': 'design',
    'tech-spec': 'tech_spec',
    'assumptions': 'assumptions',
  };
  const activeSectionKey = tabToSectionKey[activeTab] ?? 'design';
  const activeSectionComments = reviewComments.filter((c) => c.sectionKey === activeSectionKey);

  const showFixBanner =
    scoreBelowThreshold &&
    (doc.status === 'draft' || doc.status === 'pending_review' || doc.status === 'revision_requested') &&
    fixFlow.phase === 'idle' &&
    !isFixWithApexBusy;

  const pendingGapCount = collectValidationGaps(doc.validationScorecard)
    .filter((g) => g.resolution === 'pending').length;

  const bannerSeverity: 'amber' | 'red' =
    doc.validationScore !== null && doc.validationScore !== undefined && doc.validationScore < 70 ? 'red' : 'amber';

  /** Review/discuss panels replace document content; fixing keeps content visible under the banner. */
  const showFixReviewPanel = fixFlow.phase === 'reviewing' || fixFlow.phase === 'discussing';

  const tabLabel: Record<TabId, string> = {
    design: 'Design',
    'tech-spec': 'Tech Spec',
    assumptions: 'Assumptions',
    validation: 'Validation Report',
  };

  const tabContent: Record<TabId, string> = {
    design: editingTab === 'design' ? designEdit : doc.designContent,
    'tech-spec': editingTab === 'tech-spec' ? techSpecEdit : doc.techSpecContent,
    assumptions: editingTab === 'assumptions' ? assumptionsEdit : doc.assumptionsContent,
    validation: validationReport?.markdown ?? doc.validationReportMd ?? '',
  };

  const tabPlaceholder: Record<TabId, string> = {
    design: 'Write the main design doc in Markdown…',
    'tech-spec': 'Write the technical spec in Markdown…',
    assumptions: 'Write the shared assumptions in Markdown…',
    validation: '',
  };

  const outline = buildOutline(tabContent[activeTab] ?? '');

  const renderValidationReport = () => {
    const reportMarkdown = validationReport?.markdown ?? doc.validationReportMd ?? null;
    if (doc.status === 'validating' && !reportMarkdown) {
      return (
        <div className={styles.validationReportEmpty}>
          <svg className={styles.bannerSpinner} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 12a9 9 0 1 1-6.219-8.56" />
          </svg>
          <div className={styles.validatingBannerTitle}>Validation in progress…</div>
          <div className={styles.validationReportEmptySub}>
            The validation agent is reviewing your design doc. The score will appear automatically when the agent finishes.
          </div>
        </div>
      );
    }
    if (reportMarkdown) {
      return (
        <div className={styles.preview}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {reportMarkdown}
          </ReactMarkdown>
        </div>
      );
    }
    return (
      <div className={styles.validationReportEmpty}>
        <div className={styles.validatingBannerTitle}>No validation report yet</div>
        <div className={styles.validationReportEmptySub}>
          The validation agent hasn't produced a report for this doc yet. Results will appear here automatically when available.
        </div>
      </div>
    );
  };

  const renderTabPreview = (tab: TabId) => {
    if (tab === 'validation') return renderValidationReport();
    const content =
      tab === 'design' ? doc.designContent :
      tab === 'tech-spec' ? doc.techSpecContent :
      doc.assumptionsContent;
    if (!content) {
      return <div className={styles.emptyPreview}>No content yet.</div>;
    }
    const preview = (
      <div className={styles.preview}>
        <MarkdownWithMermaid content={content} components={markdownComponents} />
      </div>
    );
    // Split/pinned panes must support the same select-to-comment flow as the
    // active tab; without AnnotationLayer, selection in those panes is ignored.
    const sectionKey = tabToSectionKey[tab];
    if (showCommentLayer && sectionKey) {
      const sectionComments = reviewComments.filter((c) => c.sectionKey === sectionKey);
      return (
        <AnnotationLayer
          sectionKey={sectionKey}
          comments={sectionComments}
          activeCommentId={activeCommentId}
          onAddComment={handleAddComment}
          onCommentClick={handleCommentClick}
        >
          {preview}
        </AnnotationLayer>
      );
    }
    return preview;
  };

  return (
    <div className={styles.container} {...{ 'data-testid': 'design-doc-review' }}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <button
            className={styles.backBtn}
            onClick={() => navigate('/backlog?tab=design-docs')}
            type="button"
            {...{ 'data-testid': 'dd-review-back-btn' }}
          >
            ←
          </button>
          <div className={styles.headerInfo}>
            <div className={styles.titleRow}>
              <h1 className={styles.title}>{doc.title}</h1>
              <span
                className={`${styles.statusBadge} ${statusBadgeClass(doc.status)}`}
                {...{ 'data-testid': 'dd-status-badge' }}
              >
                {statusLabel(doc.status)}
              </span>
              {doc.validationScore !== null && doc.validationScore !== undefined && (
                <span
                  className={`${styles.validationBadge} ${doc.validationScore >= validationThreshold ? styles.validationBadgeGood : doc.validationScore >= 70 ? styles.validationBadgeMid : styles.validationBadgeBad}`}
                  {...{ 'data-testid': 'dd-validation-badge' }}
                >
                  {doc.validationScore}% validated
                </span>
              )}
              {doc.reviewerId && doc.reviewedAt && (
                <span className={styles.reviewBadge}>
                  <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M10 3L4.5 8.5 2 6" />
                  </svg>
                  {doc.reviewerName ?? doc.reviewerId} &middot; {formatDate(doc.reviewedAt)}
                </span>
              )}
            </div>
            <div className={styles.metaRow}>
              <span className={styles.metaItem}>
                <span className={styles.metaLabel}>Owner:</span>
                <span className={styles.metaValue}>{doc.ownerName ?? doc.ownerId ?? doc.authorName ?? doc.authorId}</span>
              </span>
              {assignments.length > 0 && (
                <span className={styles.metaItem}>
                  <span className={styles.metaLabel}>Reviewer(s):</span>
                  <span className={styles.metaValue}>
                    {assignments.map((a) => a.approverDisplayName ?? a.approverUserId).join(', ')}
                  </span>
                </span>
              )}
              {doc.model && (
                <span className={styles.metaItem}>
                  <span className={styles.metaLabel}>Model:</span>
                  <span className={styles.metaValue}>{doc.model}</span>
                </span>
              )}
              {doc.skillSettingsName && (
                <span className={styles.repoBadge}>{doc.skillSettingsName}</span>
              )}
            </div>
            <ArtifactUsageStrip
              endpoint={`/api/interviews/design-docs/${doc.id}/usage`}
              visible={doc.status !== 'generating'}
            />
            {sourcePrd && (
              <div className={styles.parentLinks}>
                <button
                  className={styles.parentLinkChip}
                  onClick={() => navigate(`/backlog/prd/${sourcePrd.id}`)}
                  type="button"
                  title={`View PRD: ${sourcePrd.title}`}
                  {...{ 'data-testid': 'dd-parent-prd-link' }}
                >
                  <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="1" width="10" height="12" rx="1.5" />
                    <path d="M4.5 4.5h5M4.5 7h5M4.5 9.5h3" />
                  </svg>
                  {sourcePrd.title}
                  <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: 8, height: 8, opacity: 0.6 }}>
                    <path d="M2 8L8 2M5 2h3v3" />
                  </svg>
                </button>
              </div>
            )}
          </div>
        </div>

        <div className={styles.headerRight}>
          {doc.status === 'approved' && (
            <span className={styles.reviewOnlyBadge}>Read-only</span>
          )}

          <button
            className={styles.actionBtn}
            onClick={handleDownload}
            disabled={!hasAnyContent}
            type="button"
            title="Download design doc, tech spec, and assumptions"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M8 2v8M5 7l3 3 3-3" />
              <path d="M3 13h10" />
            </svg>
            Download
          </button>

          {canUseAssistant && (
            <button
              className={`${styles.actionBtn} ${assistantOpen ? styles.actionBtnActive : ''}`}
              onClick={() => setAssistantOpen((v) => !v)}
              type="button"
              title="Apex Assistant"
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M14 10.667A2.667 2.667 0 0 1 11.333 13.333H4.667L2 16V4.667A2.667 2.667 0 0 1 4.667 2h6.666A2.667 2.667 0 0 1 14 4.667z" />
              </svg>
              Ask Apex
            </button>
          )}

          {canManageAuthorActions && doc.status === 'validating' && (
            <button
              className={styles.actionBtn}
              onClick={() => void cancelValidation.mutateAsync(doc.id)}
              disabled={cancelValidation.isPending}
              type="button"
              title="Stop validation and return to draft"
            >
              {cancelValidation.isPending ? 'Cancelling…' : 'Cancel Validation'}
            </button>
          )}

          {canManageAuthorActions && (doc.status === 'draft' || doc.status === 'revision_requested') && (
            <button
              className={styles.actionBtnPrimary}
              onClick={handleSubmit}
              disabled={submitDoc.isPending || !hasAnyContent}
              type="button"
              {...{ 'data-testid': 'dd-submit-btn' }}
            >
              Submit for Review
            </button>
          )}

          {canManageAuthorActions &&
            doc.status === 'validating' &&
            doc.validationScore !== null &&
            doc.validationScore !== undefined &&
            doc.validationScore >= validationThreshold && (
              <button
                className={styles.actionBtnPrimary}
                onClick={() => void handleMarkValidationReady()}
                disabled={markValidationReady.isPending}
                type="button"
                {...{ 'data-testid': 'dd-submit-btn' }}
              >
                {markValidationReady.isPending
                  ? 'Submitting…'
                  : `Submit for Review (Score ≥ ${validationThreshold}%)`}
              </button>
            )}

          {!ownerOnly && isReviewer && doc.status === 'pending_review' && (
            <>
              <span className={styles.actionDivider} />
              <div className={styles.reviewControls}>
                <button
                  className={styles.btnApprove}
                  onClick={() => void handleApprove()}
                  disabled={reviewDoc.isPending || validationBlocking || !canPerformReview || unresolvedCount > 0}
                  title={
                    !canPerformReview
                      ? 'You are not an assigned approver for this document'
                      : unresolvedCount > 0
                        ? 'Resolve all comments before approving'
                        : validationBlocking
                          ? `Validation score must be ≥ ${validationThreshold}% (current: ${doc.validationScore}%)`
                          : undefined
                  }
                  type="button"
                  {...{ 'data-testid': 'dd-approve-btn' }}
                >
                  Approve
                </button>
              </div>
            </>
          )}

          {showOwnerApproveButton && (
            <>
              <span className={styles.actionDivider} />
              <div className={styles.reviewControls}>
                <button
                  className={styles.btnApprove}
                  onClick={() => void handleOwnerApprove()}
                  disabled={ownerApproveMutation.isPending || !isOwnerActor || unresolvedCount > 0 || validationBlocking}
                  aria-disabled={ownerApproveMutation.isPending || !isOwnerActor || unresolvedCount > 0 || validationBlocking}
                  aria-describedby={ownerOnly && !isOwnerActor ? 'owner-approve-disabled-reason' : undefined}
                  title={
                    !isOwnerActor
                      ? undefined
                      : unresolvedCount > 0
                        ? 'Resolve all comments before approving'
                        : validationBlocking
                          ? `Validation score must be ≥ ${validationThreshold}% (current: ${doc.validationScore}%)`
                          : undefined
                  }
                  type="button"
                  {...{ 'data-testid': 'dd-approve-owner-btn' }}
                >
                  Approve as Owner
                </button>
                {ownerOnly && !isOwnerActor && (
                  <span
                    id="owner-approve-disabled-reason"
                    role="status"
                    {...{ 'data-testid': 'owner-approve-disabled-reason' }}
                  >
                    Only the document owner or a Platform Admin can approve
                  </span>
                )}
              </div>
            </>
          )}

          {canShowHeaderActionMenu && (
            <div className={styles.actionMenu} ref={actionMenuRef}>
              <button
                className={`${styles.actionBtn} ${actionMenuOpen ? styles.actionBtnActive : ''}`}
                onClick={() => setActionMenuOpen((open) => !open)}
                type="button"
                aria-haspopup="menu"
                aria-expanded={actionMenuOpen}
                aria-label="More actions"
              >
                More
                <svg
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M4 6l4 4 4-4" />
                </svg>
              </button>

              {actionMenuOpen && (
                <div
                  className={styles.actionMenuPanel}
                  role="menu"
                  aria-label="More design doc actions"
                >
                  {canRunValidationAction && (
                    <button
                      className={styles.actionMenuItem}
                      onClick={() => {
                        setActionMenuOpen(false);
                        void (async () => {
                          if (!id) return;
                          setFixIdleNotice(null);
                          clearLocalFixSession(id);
                          fixFlowDispatch({ type: 'RESET' });
                          if (doc.fixBaseline) {
                            try {
                              await dismissFixSession.mutateAsync(id);
                            } catch { /* still attempt re-run */ }
                          }
                          await createValidationThread.mutateAsync(doc.id);
                        })();
                      }}
                      disabled={createValidationThread.isPending || dismissFixSession.isPending}
                      type="button"
                      role="menuitem"
                      title={
                        doc.validationThreadId
                          ? 'Re-run the validation agent with the latest content'
                          : 'Run the validation agent against this design doc'
                      }
                    >
                      <span className={styles.actionMenuIcon}>
                        <svg viewBox="0 0 16 16" aria-hidden="true">
                          <circle cx="8" cy="8" r="6" />
                          <path d="M5 8l2 2 4-4" />
                        </svg>
                      </span>
                      <span className={styles.actionMenuLabel}>
                        {createValidationThread.isPending
                          ? 'Starting…'
                          : doc.validationThreadId
                            ? 'Re-run Validation'
                            : 'Run Validation'}
                      </span>
                    </button>
                  )}

                  {canWithdrawAction && (
                    <button
                      className={styles.actionMenuItem}
                      onClick={() => {
                        setActionMenuOpen(false);
                        void handleWithdraw();
                      }}
                      disabled={withdrawDoc.isPending}
                      type="button"
                      role="menuitem"
                    >
                      <span className={styles.actionMenuIcon}>
                        <svg viewBox="0 0 16 16" aria-hidden="true">
                          <path d="M4 8h8" />
                          <path d="M7 5L4 8l3 3" />
                        </svg>
                      </span>
                      <span className={styles.actionMenuLabel}>Withdraw</span>
                    </button>
                  )}

                  {canShowApproversAction && (
                    <button
                      className={styles.actionMenuItem}
                      onClick={() => {
                        setActionMenuOpen(false);
                        setShowReassignModal(true);
                      }}
                      type="button"
                      role="menuitem"
                      title={
                        approverDisplayNames.length > 0
                          ? `Approvers: ${approverDisplayNames.join(', ')}`
                          : 'Assign approvers'
                      }
                    >
                      <span className={styles.actionMenuIcon}>
                        <svg viewBox="0 0 16 16" aria-hidden="true">
                          <circle cx="6" cy="5" r="2.5" />
                          <path d="M1 13c0-2.5 2.24-4.5 5-4.5s5 2 5 4.5" />
                          <path d="M12 5.5l2 2 2-2" />
                        </svg>
                      </span>
                      <span className={styles.actionMenuLabel}>
                        {approverDisplayNames.length > 0
                          ? `${approverDisplayNames.length} Approver${approverDisplayNames.length > 1 ? 's' : ''}`
                          : 'Approvers'}
                      </span>
                    </button>
                  )}

                  {canDeleteDocAction && (
                    <button
                      className={`${styles.actionMenuItem} ${styles.actionMenuItemDanger}`}
                      onClick={() => {
                        setActionMenuOpen(false);
                        setShowDeleteModal(true);
                      }}
                      disabled={deleteDoc.isPending}
                      type="button"
                      role="menuitem"
                    >
                      <span className={styles.actionMenuIcon}>
                        <svg viewBox="0 0 16 16" aria-hidden="true">
                          <polyline points="2 4 4 4 14 4" />
                          <path d="M13 4l-.7 9.3A1 1 0 0 1 12.3 14H3.7a1 1 0 0 1-1-.7L2 4" />
                          <path d="M6.5 7v4M9.5 7v4" />
                          <path d="M5.5 4V2.7A.7.7 0 0 1 6.2 2h3.6a.7.7 0 0 1 .7.7V4" />
                        </svg>
                      </span>
                      <span className={styles.actionMenuLabel}>Delete Design Doc</span>
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {apexFixRunningBanner && (
        <ApexFixRunningBanner
          title={apexFixRunningBanner.title}
          subtitle={apexFixRunningBanner.subtitle}
          hint={apexFixRunningBanner.hint}
          onCancel={apexFixRunningBanner.showCancel ? handleFixCancel : undefined}
        />
      )}

      {isGenerationFailed && (
        /* ── Generation failed banner ────────────────────────────────── */
        <div
          className={styles.generationFailedBanner}
          role="alert"
          {...{ 'data-testid': 'dd-generation-failed-banner' }}
        >
          <svg
            className={`${styles.failureBannerIcon} ${styles.failureBannerIconRed}`}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="15" y1="9" x2="9" y2="15" />
            <line x1="9" y1="9" x2="15" y2="15" />
          </svg>
          <div className={styles.failureBannerBody}>
            <div className={styles.failureBannerTitle}>Generation failed</div>
            <div className={styles.failureBannerSummary}>
              {doc?.generationError ?? 'The AI agent did not produce the required output files.'}
            </div>
            <div className={styles.failureBannerActions}>
              <button
                className={styles.failureBannerBtnPrimaryAccent}
                onClick={() => id && retryGenerate.mutate(id)}
                disabled={retryGenerate.isPending}
                type="button"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M2.5 8a5.5 5.5 0 0 1 9.6-3.7" />
                  <polyline points="12.5 2.5 12.5 4.8 10.2 4.8" />
                  <path d="M13.5 8a5.5 5.5 0 0 1-9.6 3.7" />
                  <polyline points="3.5 13.5 3.5 11.2 5.8 11.2" />
                </svg>
                {retryGenerate.isPending ? 'Retrying…' : 'Retry Generation'}
              </button>
            </div>
          </div>
        </div>
      )}

      {isGenerating ? (
        /* ── Generating (same Apex mark as prototypes) ───────────────── */
        <>
          <div className={styles.tabs}>
            {(['design', 'tech-spec', 'assumptions'] as TabId[]).map((t) => (
              <button key={t} className={`${styles.tab} ${t === 'design' ? styles.active : ''}`} disabled type="button">
                {tabLabel[t]}
              </button>
            ))}
          </div>
          <div className={styles.tabContent}>
            <div
              className={styles.loadingState}
              role="status"
              aria-busy="true"
              aria-label="Generating design doc"
              {...{ 'data-testid': 'dd-generating-loader' }}
            >
              <ApexLoader size={72} />
              <div className={styles.loadingLabel}>Generating your Design Doc…</div>
              <div className={styles.bannerSub}>
                This may take a few minutes. You can navigate away and return.
              </div>
            </div>
          </div>
        </>
      ) : (
        /* ── Normal tabs (always shown — validation is a tab, not a takeover) ── */
        <>
          {/* ── Validation failure banner ─────────────────────────────── */}
          {showFixBanner && (
            <div
              className={bannerSeverity === 'red' ? styles.validationFailureBannerRed : styles.validationFailureBannerAmber}
              {...{ 'data-testid': 'dd-fix-banner' }}
            >
              <svg
                className={`${styles.failureBannerIcon} ${bannerSeverity === 'red' ? styles.failureBannerIconRed : styles.failureBannerIconAmber}`}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
              </svg>
              <div className={styles.failureBannerBody}>
                <div className={styles.failureBannerTitle}>
                  Validation needs attention
                  <span className={bannerSeverity === 'red' ? styles.failureBannerScoreBadgeRed : styles.failureBannerScoreBadgeAmber}>
                    {doc.validationScore}%
                  </span>
                </div>
                <div className={styles.failureBannerSummary}>
                  {hasValidationOverride
                    ? `Validation score is below the ${validationThreshold}% threshold, but an authorized override allows review to proceed.`
                    : pendingGapCount > 0
                      ? `${pendingGapCount} gap${pendingGapCount === 1 ? '' : 's'} need${pendingGapCount === 1 ? 's' : ''} attention across the design doc sections.`
                      : `The validation score is below the ${validationThreshold}% threshold required for submission.`}
                  {fixIdleNotice ? ` ${fixIdleNotice}` : ''}
                </div>
                {doc.validationOverride && (
                  <ValidationOverrideAudit
                    override={doc.validationOverride}
                    legacySummary={
                      doc.validationOverride.validationScore === null
                        ? `Overrode missing validation score (threshold ${doc.validationOverride.validationThreshold}%)`
                        : `Overrode validation score ${doc.validationOverride.validationScore}% (threshold ${doc.validationOverride.validationThreshold}%)`
                    }
                  />
                )}
                <div className={styles.failureBannerActions}>
                  <button
                    className={bannerSeverity === 'red' ? styles.failureBannerBtnPrimaryRed : styles.failureBannerBtnPrimaryAmber}
                    onClick={() => void handleStartFixWithAI()}
                    disabled={isFixWithApexBusy}
                    type="button"
                  >
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M8 2l1.09 3.26L12.36 6l-3.27 1.09L8 10.36 6.91 7.09 3.64 6l3.27-1.09z" />
                      <path d="M13 1l.54 1.63L15.18 3.18 13.54 3.72 13 5.35l-.54-1.63L10.82 3.18l1.64-.55z" />
                    </svg>
                    {apexFixStartLocked || fixValidation.isPending ? 'Starting…' : 'Fix with Apex'}
                  </button>
                  <button
                    className={styles.failureBannerBtnSecondary}
                    onClick={expandValidationPanel}
                    type="button"
                  >
                    Review Report
                  </button>
                  {canManage && !hasValidationOverride && (
                    <button
                      className={styles.failureBannerBtnSecondary}
                      onClick={() => setShowOverrideModal(true)}
                      type="button"
                    >
                      Proceed anyway
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ── Fix flow: reviewing/discussing diff panel ────────────── */}
          {showFixReviewPanel && (
            <FixValidationPanel
              baseline={(fixFlow as any).baseline as ContentSnapshot}
              currentDesign={doc.designContent}
              currentTechSpec={doc.techSpecContent}
              currentAssumptions={doc.assumptionsContent}
              scorecard={doc.validationScorecard}
              gapChanges={(fixFlow as any).gapChanges ?? []}
              agentError={(fixFlow as any).agentError}
              isApplying={acceptFixValidation.isPending}
              isReverting={revertSection.isPending}
              onAcceptSection={handleFixAcceptSection}
              onRevertSection={(s) => void handleFixRevertSection(s)}
              onDiscuss={handleFixDiscuss}
              onApplyAndRevalidate={() => void handleFixApplyAndRevalidate()}
              onRevertAll={() => void handleFixRevertAll()}
              onCancel={handleFixCancel}
              onRetry={() => void handleStartFixWithAI()}
            />
          )}

          {/* ── Normal content (visible while fixing; hidden during review panel) ── */}
          {!showFixReviewPanel && (
            <>
              {(doc.proposedDesignContent != null || doc.proposedTechSpecContent != null || doc.proposedAssumptionsContent != null) && (
                <ProposedDesignDocChangesReview
                  designDocId={doc.id}
                  currentDesign={doc.designContent}
                  currentTechSpec={doc.techSpecContent}
                  currentAssumptions={doc.assumptionsContent}
                  proposedDesignContent={doc.proposedDesignContent}
                  proposedTechSpecContent={doc.proposedTechSpecContent}
                  proposedAssumptionsContent={doc.proposedAssumptionsContent}
                  fixCommentId={doc.fixCommentId}
                />
              )}
              <div className={styles.workspace}>
                <div className={`${styles.outlineRail} ${outlineCollapsed ? styles.outlineRailCollapsed : ''}`}>
                  <div className={styles.outlineHeader}>
                    {!outlineCollapsed && <span className={styles.outlineTitle}>Outline</span>}
                    <button
                      className={styles.outlineToggle}
                      onClick={() => setOutlineCollapsed((v) => !v)}
                      title={outlineCollapsed ? 'Expand outline' : 'Collapse outline'}
                      aria-label={outlineCollapsed ? 'Expand outline' : 'Collapse outline'}
                      type="button"
                    >
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        {outlineCollapsed ? <path d="M6 4l4 4-4 4" /> : <path d="M10 4L6 8l4 4" />}
                      </svg>
                    </button>
                  </div>
                  {!outlineCollapsed && (
                    <nav className={styles.outlineList}>
                      {outline.length === 0 ? (
                        <div className={styles.outlineEmpty}>No sections</div>
                      ) : (
                        outline.map((item, idx) => (
                          <button
                            key={`${item.id}-${idx}`}
                            className={`${styles.outlineItem} ${styles[`outlineLevel${item.level}` as keyof typeof styles]} ${activeHeadingId === item.id ? styles.outlineItemActive : ''}`}
                            onClick={() => handleOutlineClick(item.id)}
                            title={item.text}
                            type="button"
                          >
                            {item.text}
                          </button>
                        ))
                      )}
                    </nav>
                  )}
                </div>

                <div className={styles.workspaceCenter}>
                  <div className={styles.tabs}>
                    {(['design', 'tech-spec', 'assumptions'] as TabId[]).map((t) => (
                      <div key={t} className={styles.tabWrap}>
                        <button
                          className={`${styles.tab} ${activeTab === t ? styles.active : ''} ${dirtyTabs.has(t) ? styles.tabDirty : ''}`}
                          onClick={() => selectTab(t)}
                          type="button"
                        >
                          {tabLabel[t]}
                          {editingTab === t && <span className={styles.editingIndicator}> ✎</span>}
                        </button>
                        {activeTab !== t && (
                          <button
                            className={`${styles.tabSplitBtn} ${splitTab === t ? styles.tabSplitBtnActive : ''}`}
                            onClick={() => handleSplitTab(t as Exclude<TabId, 'validation'>)}
                            title={splitTab === t ? 'Close split view' : 'Open side by side'}
                            aria-label={splitTab === t ? 'Close split view' : 'Open side by side'}
                            type="button"
                          >
                            <SplitIcon />
                          </button>
                        )}
                        <button
                          className={`${styles.tabPinBtn} ${pinnedTab === t ? styles.tabPinBtnActive : ''}`}
                          onClick={() => handlePinTab(t)}
                          title={pinnedTab === t ? 'Unpin from side panel' : 'Pin to side panel'}
                          aria-label={pinnedTab === t ? 'Unpin from side panel' : 'Pin to side panel'}
                          type="button"
                        >
                          <PinIcon />
                        </button>
                      </div>
                    ))}
                    {canEdit && activeTab !== 'validation' && (
                      <button
                        className={styles.tabEditBtn}
                        onClick={() => handleEditToggle(activeTab as Exclude<TabId, 'validation'>)}
                        type="button"
                      >
                        {editingTab === activeTab ? 'Cancel Edit' : 'Edit'}
                      </button>
                    )}
                  </div>

                  <div ref={tabContentSplitRef} className={`${styles.tabContent} ${splitTab ? styles.tabContentSplit : ''}`}>
                    {/* Primary / left content */}
                    <div
                      ref={centerScrollRef}
                      className={splitTab ? styles.centerSplitLeft : styles.centerSingleContent}
                    >
                      <div className={styles.contentMain}>
                        {doc.status === 'validating' && (
                          <div className={styles.validatingBanner}>
                            <svg className={styles.bannerSpinner} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ width: 18, height: 18, flexShrink: 0, marginTop: 2 }}>
                              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                            </svg>
                            <div className={styles.validatingBannerText}>
                              <div className={styles.validatingBannerTitle}>Validation in progress</div>
                              <div className={styles.validatingBannerSub}>
                                The agent is scoring your design doc. Results will appear in the <strong>Validation Report</strong> tab automatically when ready.
                              </div>
                            </div>
                          </div>
                        )}
                        {showCommentLayer && editingTab !== activeTab ? (
                          <AnnotationLayer
                            sectionKey={activeSectionKey}
                            comments={activeSectionComments}
                            activeCommentId={activeCommentId}
                            onAddComment={handleAddComment}
                            onCommentClick={handleCommentClick}
                          >
                            <ContentPane
                              content={tabContent[activeTab]}
                              isEditing={false}
                              editValue=""
                              isDirty={false}
                              isSaving={false}
                              canEdit={canEdit}
                              placeholder={tabPlaceholder[activeTab]}
                              markdownComponents={markdownComponents}
                              onEditChange={() => {}}
                              onSave={() => {}}
                              onDiscard={() => {}}
                            />
                          </AnnotationLayer>
                        ) : (
                          <ContentPane
                            content={tabContent[activeTab]}
                            isEditing={editingTab === activeTab}
                            editValue={
                              activeTab === 'design' ? designEdit :
                              activeTab === 'tech-spec' ? techSpecEdit :
                              assumptionsEdit
                            }
                            isDirty={dirtyTabs.has(activeTab)}
                            isSaving={updateContent.isPending}
                            canEdit={canEdit}
                            placeholder={tabPlaceholder[activeTab]}
                            markdownComponents={markdownComponents}
                            onEditChange={(v) => handleEditChange(activeTab as Exclude<TabId, 'validation'>, v)}
                            onSave={() => void handleSave(activeTab as Exclude<TabId, 'validation'>)}
                            onDiscard={() => handleDiscard(activeTab as Exclude<TabId, 'validation'>)}
                          />
                        )}
                      </div>
                    </div>

                    {/* Center split: secondary pane (e.g. Design + Tech Spec side by side) */}
                    {splitTab && (
                      <>
                        <div
                          className={`${styles.centerSplitDivider} ${isDraggingSplit ? styles.centerSplitDividerDragging : ''}`}
                          onMouseDown={handleSplitResizeMouseDown}
                          role="separator"
                          aria-orientation="vertical"
                          aria-label="Resize split"
                        />
                        <div className={styles.centerSplitRight} style={{ width: `calc(${splitPercent * 100}% - 2px)` }}>
                          <div className={styles.centerSplitRightHeader}>
                            <span className={styles.centerSplitRightTitle}>{tabLabel[splitTab]}</span>
                            <button
                              className={styles.centerSplitRightClose}
                              onClick={() => {
                                unwrapCommentMarks(tabContentSplitRef.current);
                                setSplitTab(null);
                              }}
                              type="button"
                              title="Close split view"
                              aria-label="Close split view"
                            >
                              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                                <path d="M1 1l12 12M13 1L1 13" />
                              </svg>
                            </button>
                          </div>
                          <div className={styles.centerSplitRightBody}>
                            {renderTabPreview(splitTab)}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                </div>

                {(showCommentLayer || hasValidationTab) && (
                  <ReviewSideDock
                    showComments={showCommentLayer}
                    showValidation={hasValidationTab}
                    commentsCollapsed={commentsPanelCollapsed}
                    validationCollapsed={validationPanelCollapsed}
                    onToggleComments={toggleCommentsPanel}
                    onToggleValidation={toggleValidationPanel}
                    openCommentCount={reviewComments.filter((c) => c.status === 'open').length}
                    validationScore={doc.validationScore}
                    isValidating={doc.status === 'validating'}
                    commentsPanel={
                      <CommentsSidePanel
                        openCount={reviewComments.filter((c) => c.status === 'open').length}
                        onCollapse={() => setCommentsPanelCollapsed(true)}
                      >
                        <ReviewCommentSidebar
                          embedded
                          comments={reviewComments}
                          activeCommentId={activeCommentId}
                          currentUserId={userId ?? ''}
                          documentAuthorUserId={doc.authorId}
                          documentOwnerUserId={doc.ownerId}
                          isAssignedApprover={isAssignedApprover}
                          onCommentClick={handleCommentClick}
                          onReply={(commentId, body) => void handleCommentReply(commentId, body)}
                          onResolve={(commentId) => resolveComment.mutate(commentId)}
                          onReopen={(commentId) => reopenReviewComment.mutate(commentId)}
                          onDelete={(commentId) => deleteComment.mutate(commentId)}
                          onFixWithAi={canEdit ? () => void handleFixAllCommentsWithAi() : undefined}
                          isFixingWithAi={isBulkCommentFixing}
                          fixAiError={fixDesignDocWithAi.error?.message}
                          onFixCommentWithAi={canEdit ? handleFixCommentWithAi : undefined}
                          fixingCommentId={fixingCommentId}
                        />
                      </CommentsSidePanel>
                    }
                    validationPanel={
                      <ValidationSidePanel
                        score={doc.validationScore}
                        scorecard={doc.validationScorecard}
                        reportMarkdown={validationReport?.markdown ?? doc.validationReportMd}
                        isValidating={doc.status === 'validating'}
                        onCollapse={() => setValidationPanelCollapsed(true)}
                        markdownComponents={markdownComponents}
                      />
                    }
                  />
                )}

                {pinnedTab && (
                  <div className={styles.pinnedPane} style={{ width: pinnedWidth }}>
                    <div
                      className={`${styles.pinnedResizeHandle} ${isDraggingPinned ? styles.pinnedResizeHandleDragging : ''}`}
                      onMouseDown={handlePinnedResizeMouseDown}
                      role="separator"
                      aria-orientation="vertical"
                      aria-label="Resize pinned panel"
                    />
                    <div className={styles.pinnedHeader}>
                      <span className={styles.pinnedTitle}>{tabLabel[pinnedTab]}</span>
                      <button
                        className={styles.pinnedClose}
                        onClick={() => setPinnedTab(null)}
                        title="Unpin"
                        aria-label="Unpin"
                        type="button"
                      >
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                          <path d="M1 1l12 12M13 1L1 13" />
                        </svg>
                      </button>
                    </div>
                    <div className={styles.pinnedBody}>
                      {renderTabPreview(pinnedTab)}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </>
      )}

      {assistantOpen && (canUseAssistant || fixFlow.phase === 'discussing') && (
        <DesignDocAssistantPanel
          designDocId={doc.id}
          onClose={handleAssistantClose}
          discussContext={discussContext ?? undefined}
          docAssistantThreadId={doc.docAssistantThreadId}
          canCreateThread={canWriteAssistant}
          readOnly={!canWriteAssistant}
        />
      )}

      {showDeleteModal && doc && (
        <ConfirmDeleteModal
          title="Delete Design Doc"
          itemName={doc.title}
          description="Are you sure you want to permanently delete the design doc"
          isPending={deleteDoc.isPending}
          onConfirm={() => {
            deleteDoc.mutate(doc.id, {
              onSuccess: () => navigate('/backlog?tab=design-docs'),
            });
          }}
          onCancel={() => setShowDeleteModal(false)}
        />
      )}

      {showOverrideModal && (
        <ReviewReasonModal
          title="Proceed with low validation score?"
          placeholder="Why are you proceeding without meeting the validation threshold?"
          confirmLabel="Proceed anyway"
          isPending={overrideDesignDocValidation.isPending}
          onConfirm={(reason) => void handleOverrideValidation(reason)}
          onCancel={() => setShowOverrideModal(false)}
        />
      )}

      {pendingSelector && (
        <div className={styles.commentModal} onClick={(e) => { if (e.target === e.currentTarget) setPendingSelector(null); }} role="dialog" aria-modal="true">
          <div className={styles.commentModalCard}>
            <h3 className={styles.commentModalTitle}>Add Comment</h3>
            <blockquote className={styles.commentModalQuote}>{pendingSelector.selector.exact}</blockquote>
            <textarea
              className={styles.commentModalInput}
              value={newCommentBody}
              onChange={(e) => setNewCommentBody(e.target.value)}
              placeholder="Write your comment…"
              rows={3}
              autoFocus
            />
            <div className={styles.commentModalActions}>
              <button
                className={styles.btnSecondary}
                onClick={() => setPendingSelector(null)}
                type="button"
              >
                Cancel
              </button>
              <button
                className={styles.btnPrimary}
                onClick={() => void handleSubmitComment()}
                disabled={!newCommentBody.trim() || createComment.isPending}
                type="button"
              >
                {createComment.isPending ? 'Posting…' : 'Post Comment'}
              </button>
            </div>
          </div>
        </div>
      )}

      {showApproverModal && doc && (
        <ApproverSelectModal
          documentType="design_doc"
          project={doc.project}
          excludeSelf={!isAdmin}
          onConfirm={(selections) => void handleApproverConfirm(selections)}
          onCancel={() => setShowApproverModal(false)}
          isSubmitting={submitDoc.isPending}
        />
      )}

      {showReassignModal && doc && (
        <ApproverSelectModal
          documentType="design_doc"
          project={doc.project}
          initialApproverIds={assignments.filter((a) => a.status === 'pending').map((a) => a.approverUserId)}
          confirmLabel="Update Approvers"
          excludeSelf={false}
          allowEmpty
          onConfirm={(selections) => void handleReassignConfirm(selections)}
          onCancel={() => setShowReassignModal(false)}
          isSubmitting={reassignApprovers.isPending}
        />
      )}

    </div>
  );
};

export default DesignDocReviewView;
