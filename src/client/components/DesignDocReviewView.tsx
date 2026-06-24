import React, { useState, useCallback, useEffect, useRef, useReducer } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import mermaid from 'mermaid';
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
  useRevertDesignDocSection,
  useDocumentAssignments,
  useReassignApprovers,
  useFixDesignDocWithAi,
  useFixDesignDocCommentWithAi,
  useDesignDocOwnerApproval,
  useDesignDocOwnerApprove,
} from '../hooks/useInterviews';
import { ProposedDesignDocChangesReview } from './ProposedDesignDocChangesReview';
import { useChatStream } from '../hooks/useChatStream';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import { ApproverSelectModal } from './ApproverSelectModal';
import { AnnotationLayer } from './AnnotationLayer';
import { ReviewCommentSidebar } from './ReviewCommentSidebar';
import { FixValidationPanel, FixingProgressView } from './FixValidationPanel';
import { ApexFixRunningBanner } from './ApexFixRunningBanner';
import type { ContentSnapshot, GapChangeEntry } from './FixValidationPanel';
import type { DesignDocStatus, ValidationScorecardGap } from '../../shared/types/interview';
import {
  designDocHasProposedChanges,
  isDesignDocSingleCommentFixPending,
} from '../utils/apexFixHelpers';
import {
  clearApexFixInProgress,
  fetchChatThreadStatus,
  markApexFixInProgress,
  readApexFixInProgress,
} from '../utils/apexFixSession';
import {
  useReviewComments,
  useUnresolvedCommentCount,
  useCreateComment,
  useResolveComment,
  useReopenComment as useReopenReviewComment,
  useDeleteComment,
} from '../hooks/useReviewComments';
import { normalizeMermaidBlocks, normalizeMermaidChart } from '../utils/mermaidMarkdown';
import type { ReviewSectionKey, TextSelector } from '../../shared/types/reviewComments';
import styles from './DesignDocReviewView.module.css';

type TabId = 'design' | 'tech-spec' | 'assumptions' | 'validation';

mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'strict',
  theme: 'base',
});

let mermaidDiagramCounter = 0;

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

function buildMermaidThemeVariables(source: HTMLElement | null): Record<string, string> {
  const styles = window.getComputedStyle(source ?? document.body);
  const token = (name: string, fallback: string): string => styles.getPropertyValue(name).trim() || fallback;

  const bgPrimary = token('--bg-primary', '#ffffff');
  const bgSecondary = token('--bg-secondary', '#f5f5f5');
  const bgTertiary = token('--bg-tertiary', '#e8e8e8');
  const textPrimary = token('--text-primary', '#1a1a1a');
  const textSecondary = token('--text-secondary', '#555555');
  const borderColor = token('--border-color', '#e0e0e0');
  const accentColor = token('--accent-color', '#142A67');

  return {
    background: bgSecondary,
    mainBkg: bgSecondary,
    primaryColor: bgTertiary,
    primaryBorderColor: accentColor,
    primaryTextColor: textPrimary,
    secondaryColor: bgPrimary,
    secondaryBorderColor: borderColor,
    secondaryTextColor: textPrimary,
    tertiaryColor: bgTertiary,
    tertiaryBorderColor: borderColor,
    tertiaryTextColor: textPrimary,
    lineColor: accentColor,
    textColor: textPrimary,
    titleColor: textPrimary,
    nodeTextColor: textPrimary,
    edgeLabelBackground: bgPrimary,
    clusterBkg: bgSecondary,
    clusterBorder: borderColor,
    actorBkg: bgTertiary,
    actorBorder: accentColor,
    actorTextColor: textPrimary,
    actorLineColor: accentColor,
    signalColor: accentColor,
    signalTextColor: textPrimary,
    labelBoxBkgColor: bgPrimary,
    labelBoxBorderColor: borderColor,
    labelTextColor: textPrimary,
    loopTextColor: textPrimary,
    noteBkgColor: bgTertiary,
    noteTextColor: textPrimary,
    noteBorderColor: borderColor,
    activationBkgColor: bgTertiary,
    activationBorderColor: accentColor,
    sequenceNumberColor: textSecondary,
  };
}

interface MermaidDiagramProps {
  chart: string;
}

const MermaidDiagram: React.FC<MermaidDiagramProps> = ({ chart }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const renderIdRef = useRef(`design-doc-mermaid-${mermaidDiagramCounter++}`);
  const renderChart = normalizeMermaidChart(chart);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [themeRevision, setThemeRevision] = useState(0);

  useEffect(() => {
    const observer = new MutationObserver(() => setThemeRevision((revision) => revision + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
    observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let isCancelled = false;

    setSvg(null);
    setError(null);
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      themeVariables: buildMermaidThemeVariables(containerRef.current),
    });

    mermaid.render(renderIdRef.current, renderChart)
      .then(({ svg: renderedSvg }) => {
        if (!isCancelled) setSvg(renderedSvg);
      })
      .catch((err: unknown) => {
        if (!isCancelled) setError(err instanceof Error ? err.message : 'Unable to render Mermaid diagram.');
      });

    return () => {
      isCancelled = true;
    };
  }, [renderChart, themeRevision]);

  if (error) {
    return (
      <div ref={containerRef} className={styles.mermaidError}>
        <div className={styles.mermaidErrorTitle}>Unable to render Mermaid diagram.</div>
        {error && <div className={styles.mermaidErrorMessage}>{error}</div>}
        <pre>{chart}</pre>
      </div>
    );
  }

  if (!svg) return <div ref={containerRef} className={styles.mermaidLoading}>Rendering diagram…</div>;

  return <div ref={containerRef} className={styles.mermaidDiagram} dangerouslySetInnerHTML={{ __html: svg }} />;
};

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

  const previewContent = normalizeMermaidBlocks(content);

  return (
    <div className={styles.previewWrapper}>
      <div className={styles.preview}>
        {content ? (
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{previewContent}</ReactMarkdown>
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

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [input]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isRunning || isSending || !threadId || readOnly) return;
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
  }, [input, isRunning, isSending, threadId, readOnly]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }, [handleSend]);

  const visibleMessages = messages.filter((m) => m.role !== 'tool');

  return (
    <>
    {showNewConvConfirm && (
      <div
        className={styles.confirmOverlay}
        onClick={(e) => { if (e.target === e.currentTarget) setShowNewConvConfirm(false); }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-conv-confirm-title"
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
            <button className={styles.confirmBtnCancel} onClick={() => setShowNewConvConfirm(false)} type="button">Cancel</button>
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
            >
              Start new
            </button>
          </div>
        </div>
      </div>
    )}
    <div className={styles.assistantPanel} style={{ width: panelWidth }}>
      <div
        className={`${styles.assistantResizeHandle} ${isDragging ? styles.assistantResizeHandleDragging : ''}`}
        onMouseDown={handleResizeMouseDown}
        role="separator"
        aria-label="Resize panel"
        aria-orientation="vertical"
      />
      <div className={styles.assistantPanelHeader}>
        <div className={styles.assistantPanelHeaderLeft}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          <span className={styles.assistantPanelTitle}>Apex Assistant</span>
        </div>
        <div className={styles.assistantPanelHeaderActions}>
          {!readOnly && canCreateThread && (
          <button
            className={styles.assistantPanelIconBtn}
            onClick={() => setShowNewConvConfirm(true)}
            type="button"
            title="New conversation"
            aria-label="New conversation"
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M13 3v4H9" /><path d="M13 7A6 6 0 1 1 9.5 2.5" />
            </svg>
          </button>
          )}
          <button className={styles.assistantPanelClose} onClick={onClose} type="button" aria-label="Close assistant">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M1 1l12 12M13 1L1 13" />
            </svg>
          </button>
        </div>
      </div>

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
          {isRunning && !streamingText && (
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

      {!readOnly ? (
        <div className={styles.qaInputArea}>
          <div className={styles.qaInputBox}>
            <textarea
              ref={textareaRef}
              className={styles.qaInputField}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                isCreating ? 'Starting assistant…' :
                isRunning ? 'Agent is thinking…' :
                'Ask about this design doc… (Enter to send)'
              }
              rows={1}
              disabled={isRunning || isSending || isCreating || !threadId}
            />
            <button
              className={styles.qaSendBtn}
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
      ) : (
        <div className={styles.qaMessageBubbleSystem} style={{ margin: '0 12px 12px' }}>
          Assistant is read-only — you can view the conversation but cannot send messages.
        </div>
      )}
    </div>
    </>
  );
};




export const DesignDocReviewView: React.FC = () => {
  const location = useLocation();
  const id = location.pathname.split('/').pop() ?? null;
  const navigate = useNavigate();
  const { can, userId, isAdmin } = useAppShell();
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
  const revertSection = useRevertDesignDocSection();
  const fixDesignDocWithAi = useFixDesignDocWithAi(id ?? '');
  const fixDesignDocCommentWithAi = useFixDesignDocCommentWithAi(id ?? '');

  const [fixFlow, fixFlowDispatch] = useReducer(fixFlowReducer, { phase: 'idle' });
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

  // Restore validation fix flow from server fixBaseline after navigation.
  useEffect(() => {
    if (!doc || fixFlow.phase !== 'idle') return;
    if (!doc.fixBaseline) return;

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
      if (thread && thread.status !== 'idle' && thread.status !== 'error') {
        fixFlowDispatch({ type: 'START_FIX', baseline, threadId });
        return;
      }
      if (thread && (thread.status === 'idle' || thread.status === 'error')) {
        await qc.refetchQueries({ queryKey: ['design-doc', doc.id] });
        if (cancelled) return;
        const res = await fetch(`/api/chat/threads/${threadId}`, { credentials: 'include' });
        const fullThread = res.ok ? await res.json() : null;
        const gapChanges = parseGapChangesFromMessages(fullThread?.messages ?? []);
        fixFlowDispatch({ type: 'START_FIX', baseline, threadId });
        fixFlowDispatch({
          type: 'FIX_COMPLETE',
          gapChanges,
          agentError: thread.status === 'error'
            ? (thread.lastError ?? 'The AI agent encountered an error and could not complete the fix.')
            : undefined,
        });
        return;
      }
      // Thread not found — treat as completed with error so the UI doesn't get stuck
      clearApexFixInProgress('design-doc-validation', doc.id);
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
  }, [doc?.id, doc?.fixBaseline, doc?.docAssistantThreadId, fixFlow.phase, qc]);

  const [activeTab, setActiveTab] = useState<TabId>('design');

  const markdownComponents: Components = {
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
            >
              {children}
            </button>
          );
        }
      }
      return <a href={href} target="_blank" rel="noopener noreferrer" {...props}>{children}</a>;
    },
  };

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
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [discussContext, setDiscussContext] = useState<DiscussContext | null>(null);

  const { data: assignments = [] } = useDocumentAssignments(id, 'design_doc');
  useDesignDocOwnerApproval(id);
  const ownerApproveMutation = useDesignDocOwnerApprove(id);

  const isGenerating = !!doc && doc.status === 'generating' && (
    doc.designContent === '' || doc.techSpecContent === '' || doc.assumptionsContent === ''
  );

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

  // ── Fix Validation Flow handlers ─────────────────────────────────────────

  const handleStartFixWithAI = useCallback(async () => {
    if (!id || !doc) return;
    const baseline: ContentSnapshot = {
      design: doc.designContent,
      techSpec: doc.techSpecContent,
      assumptions: doc.assumptionsContent,
      capturedAt: new Date().toISOString(),
    };
    markApexFixInProgress('design-doc-validation', id);
    try {
      const result = await fixValidation.mutateAsync(id);
      markApexFixInProgress('design-doc-validation', id, { threadId: result.threadId });
      fixFlowDispatch({ type: 'START_FIX', baseline, threadId: result.threadId });
    } catch {
      if (id) clearApexFixInProgress('design-doc-validation', id);
      fixFlowDispatch({ type: 'RESET' });
    }
  }, [id, doc, fixValidation]);

  // Poll the assistant thread status during the fixing phase.
  // Only transition to reviewing once the agent is idle (done with all MCP calls).
  useEffect(() => {
    if (fixFlow.phase !== 'fixing' || !id) return;
    const { threadId } = fixFlow;
    let cancelled = false;

    let notFoundCount = 0;
    const poll = async () => {
      try {
        const thread = await fetchChatThreadStatus(threadId);
        if (cancelled) return;
        if (!thread) {
          notFoundCount++;
          if (notFoundCount >= 3) {
            clearApexFixInProgress('design-doc-validation', id);
            fixFlowDispatch({
              type: 'FIX_COMPLETE',
              gapChanges: [],
              agentError: 'The fix session is no longer available. You can try again.',
            });
          }
          return;
        }
        notFoundCount = 0;
        if (thread.status === 'idle' || thread.status === 'error') {
          await qc.refetchQueries({ queryKey: ['design-doc', id] });
          const res = await fetch(`/api/chat/threads/${threadId}`, { credentials: 'include' });
          const fullThread = res.ok ? await res.json() : null;
          const gapChanges = parseGapChangesFromMessages(fullThread?.messages ?? []);
          const agentError = thread.status === 'error'
            ? (thread.lastError ?? 'The AI agent encountered an error and could not complete the fix.')
            : undefined;
          if (!cancelled) {
            clearApexFixInProgress('design-doc-validation', id);
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
  }, [fixFlow, id, qc]);

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
      const s = gap.section.toLowerCase();
      if (s.includes('tech') || s.includes('spec')) return 'tech-spec';
      if (s.includes('assumption')) return 'assumptions';
      return 'design';
    };

    const allGaps = doc?.validationScorecard?.features?.flatMap((f) => f.gaps) ?? [];
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
    try {
      await acceptFixValidation.mutateAsync(id);
    } finally {
      if (id) clearApexFixInProgress('design-doc-validation', id);
      fixFlowDispatch({ type: 'RESET' });
    }
  }, [id, acceptFixValidation]);

  const handleFixRevertAll = useCallback(async () => {
    if (!id || fixFlow.phase === 'idle') return;
    const bl = (fixFlow as any).baseline as ContentSnapshot;
    await revertSection.mutateAsync({
      designDocId: id,
      designContent: bl.design,
      techSpecContent: bl.techSpec,
      assumptionsContent: bl.assumptions,
    });
    clearApexFixInProgress('design-doc-validation', id);
    fixFlowDispatch({ type: 'RESET' });
  }, [id, fixFlow, revertSection]);

  const handleFixCancel = useCallback(() => {
    if (id) clearApexFixInProgress('design-doc-validation', id);
    fixFlowDispatch({ type: 'RESET' });
  }, [id]);

  // When the assistant panel closes during discuss phase, return to reviewing
  const handleAssistantClose = useCallback(() => {
    setAssistantOpen(false);
    setDiscussContext(null);
    if (fixFlow.phase === 'discussing') {
      fixFlowDispatch({ type: 'END_DISCUSS' });
    }
  }, [fixFlow.phase]);

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

  const handleCommentClick = useCallback((commentId: string) => {
    const comment = reviewComments.find((c) => c.id === commentId);
    if (comment) {
      const targetTab = sectionKeyToTab[comment.sectionKey];
      if (targetTab) setActiveTab(targetTab);
    }
    setActiveCommentId(commentId);
  }, [reviewComments]);

  const handleAddComment = useCallback((sectionKey: ReviewSectionKey, selector: TextSelector) => {
    setPendingSelector({ sectionKey, selector });
    setNewCommentBody('');
  }, []);

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

  if (isLoading) return <div className={styles.loadingState}>Loading Design Doc…</div>;
  if (isError || !doc) return <div className={styles.errorState}>Design doc not found.</div>;

  const isAuthor = doc.authorId === userId;
  const isOwner = doc.ownerId === userId;
  const validationBlocking = doc.validationScore !== undefined && doc.validationScore !== null && doc.validationScore < 90;
  const canManage = can('interviews:manage');
  const canReview = can('design-docs:review');
  const isAssignedApprover = assignments.some((a) => a.approverUserId === userId);
  const isReviewer = canReview && (!isAuthor || isAdmin) && !isOwner;
  const canPerformReview = isReviewer && (isAssignedApprover || isAdmin);
  const showOwnerApproveButton = doc.status === 'reviewer_approved' && (isOwner || isAdmin);
  const canEdit = canManage && (isAuthor || isAdmin) && doc.status !== 'approved' && doc.status !== 'reviewer_approved';
  const canUseAssistant = (isReviewer || isOwner || isAdmin) &&
    (doc.status === 'draft' || doc.status === 'pending_review' || doc.status === 'reviewer_approved' || doc.status === 'revision_requested');

  const validationFixSession = id ? readApexFixInProgress('design-doc-validation', id) : null;
  const apexFixRunningBanner = (() => {
    if (fixFlow.phase === 'fixing' || (validationFixSession && fixFlow.phase === 'idle')) {
      return {
        title: 'Apex is fixing validation gaps…',
        subtitle: 'You can leave this page — progress will resume when you return.',
      };
    }
    if (bulkCommentFixRunning || fixDesignDocWithAi.isPending) {
      return {
        title: 'Apex is applying review comment fixes…',
        subtitle: 'Proposed changes will appear here when complete.',
      };
    }
    if (fixingCommentId || isDesignDocSingleCommentFixPending(doc)) {
      return {
        title: 'Apex is fixing a review comment…',
        subtitle: 'The proposed edit will appear when complete.',
      };
    }
    return null;
  })();
  const isBulkCommentFixing = bulkCommentFixRunning || fixDesignDocWithAi.isPending;
  const canWriteAssistant = canEdit || canPerformReview || isOwner;

  const hasAnyContent = !!(doc.designContent || doc.techSpecContent || doc.assumptionsContent);
  const hasValidationTab = !!doc.validationThreadId;

  const showCommentLayer =
    (doc.status === 'pending_review' || doc.status === 'reviewer_approved' || doc.status === 'revision_requested') &&
    (canPerformReview || isOwner || isAuthor || isAdmin);

  const tabToSectionKey: Record<string, ReviewSectionKey> = {
    'design': 'design',
    'tech-spec': 'tech_spec',
    'assumptions': 'assumptions',
  };
  const activeSectionKey = tabToSectionKey[activeTab] ?? 'design';
  const activeSectionComments = reviewComments.filter((c) => c.sectionKey === activeSectionKey);

  const showFixBanner =
    validationBlocking &&
    (doc.status === 'draft' || doc.status === 'pending_review' || doc.status === 'revision_requested') &&
    fixFlow.phase === 'idle';

  const pendingGapCount = (() => {
    if (!doc.validationScorecard?.features) return 0;
    let count = 0;
    for (const f of doc.validationScorecard.features) {
      for (const g of f.gaps) {
        if (g.resolution === 'pending') count++;
      }
    }
    return count;
  })();

  const bannerSeverity: 'amber' | 'red' =
    doc.validationScore !== null && doc.validationScore !== undefined && doc.validationScore < 70 ? 'red' : 'amber';

  const showFixFlow = fixFlow.phase !== 'idle';

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

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <button className={styles.backBtn} onClick={() => navigate('/backlog?tab=design-docs')} type="button">
            ←
          </button>
          <div className={styles.headerInfo}>
            <div className={styles.titleRow}>
              <h1 className={styles.title}>{doc.title}</h1>
              <span className={`${styles.statusBadge} ${statusBadgeClass(doc.status)}`}>
                {statusLabel(doc.status)}
              </span>
              {doc.validationScore !== null && doc.validationScore !== undefined && (
                <span className={`${styles.validationBadge} ${doc.validationScore >= 90 ? styles.validationBadgeGood : doc.validationScore >= 70 ? styles.validationBadgeMid : styles.validationBadgeBad}`}>
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
            </div>
            {sourcePrd && (
              <div className={styles.parentLinks}>
                <button
                  className={styles.parentLinkChip}
                  onClick={() => navigate(`/backlog/prd/${sourcePrd.id}`)}
                  type="button"
                  title={`View PRD: ${sourcePrd.title}`}
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

          {canManage && (isAuthor || isAdmin) && (
            <>
              {canUseAssistant && <span className={styles.actionDivider} />}
              {hasAnyContent &&
                (doc.status === 'draft' || doc.status === 'pending_review' || doc.status === 'revision_requested') && (
                <button
                  className={styles.actionBtn}
                  onClick={() => void createValidationThread.mutateAsync(doc.id)}
                  disabled={createValidationThread.isPending}
                  type="button"
                  title={doc.validationThreadId ? 'Re-run the validation agent with the latest content' : 'Run the validation agent against this design doc'}
                >
                  {createValidationThread.isPending ? 'Starting…' : doc.validationThreadId ? 'Re-run Validation' : 'Run Validation'}
                </button>
              )}
              {doc.status === 'validating' && (
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
              {(doc.status === 'draft' || doc.status === 'revision_requested') && (
                <button
                  className={styles.actionBtnPrimary}
                  onClick={handleSubmit}
                  disabled={submitDoc.isPending || !hasAnyContent}
                  type="button"
                >
                  Submit for Review
                </button>
              )}
              {doc.status === 'validating' && doc.validationScore !== null && doc.validationScore !== undefined && doc.validationScore >= 90 && (
                <button
                  className={styles.actionBtnPrimary}
                  onClick={() => void handleMarkValidationReady()}
                  disabled={markValidationReady.isPending}
                  type="button"
                >
                  {markValidationReady.isPending ? 'Submitting…' : 'Submit for Review (Score ≥ 90%)'}
                </button>
              )}
              {doc.status === 'pending_review' && (
                <button
                  className={styles.actionBtn}
                  onClick={() => void handleWithdraw()}
                  disabled={withdrawDoc.isPending}
                  type="button"
                >
                  Withdraw
                </button>
              )}
              <button
                className={styles.btnDeleteDoc}
                onClick={() => setShowDeleteModal(true)}
                disabled={deleteDoc.isPending}
                title="Delete Design Doc"
                type="button"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="2 4 4 4 14 4" />
                  <path d="M13 4l-.7 9.3A1 1 0 0 1 12.3 14H3.7a1 1 0 0 1-1-.7L2 4" />
                  <path d="M6.5 7v4M9.5 7v4" />
                  <path d="M5.5 4V2.7A.7.7 0 0 1 6.2 2h3.6a.7.7 0 0 1 .7.7V4" />
                </svg>
              </button>
            </>
          )}

          {isReviewer && doc.status === 'pending_review' && (
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
                          ? `Validation score must be ≥ 90% (current: ${doc.validationScore}%)`
                          : undefined
                  }
                  type="button"
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
                  disabled={ownerApproveMutation.isPending}
                  type="button"
                >
                  Approve as Owner
                </button>
              </div>
            </>
          )}

          {doc.status === 'pending_review' && (
            <>
              <span className={styles.actionDivider} />
              <button
                className={styles.actionBtn}
                onClick={() => setShowReassignModal(true)}
                type="button"
                title={assignments.length > 0
                  ? `Approvers: ${assignments.map(a => a.approverDisplayName ?? a.approverUserId).join(', ')}`
                  : 'Assign approvers'}
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="6" cy="5" r="2.5" />
                  <path d="M1 13c0-2.5 2.24-4.5 5-4.5s5 2 5 4.5" />
                  <path d="M12 5.5l2 2 2-2" />
                </svg>
                {assignments.length > 0 ? `${assignments.length} Approver${assignments.length > 1 ? 's' : ''}` : 'Approvers'}
              </button>
            </>
          )}
        </div>
      </div>

      {apexFixRunningBanner && (
        <ApexFixRunningBanner
          title={apexFixRunningBanner.title}
          subtitle={apexFixRunningBanner.subtitle}
        />
      )}

      {isGenerating ? (
        /* ── Generating skeleton ─────────────────────────────────────── */
        <>
          <div className={styles.tabs}>
            {(['design', 'tech-spec', 'assumptions'] as TabId[]).map((t) => (
              <button key={t} className={`${styles.tab} ${t === 'design' ? styles.active : ''}`} disabled type="button">
                {tabLabel[t]}
              </button>
            ))}
          </div>
          <div className={styles.tabContent}>
            <div className={styles.skeletonArea}>
              <div className={styles.generatingBanner}>
                <svg
                  className={styles.bannerSpinner}
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
                <div>
                  <div className={styles.bannerTitle}>Generating your Design Doc…</div>
                  <div className={styles.bannerSub}>This may take a few minutes. You can navigate away and return.</div>
                </div>
              </div>

              <div className={styles.skeletonSection}>
                <div className={styles.skeletonHeader} style={{ width: '75%' }} />
                <div className={styles.skeletonLine} style={{ width: '100%' }} />
                <div className={styles.skeletonLine} style={{ width: '65%' }} />
                <div className={styles.skeletonLine} style={{ width: '100%' }} />
              </div>

              <div className={styles.skeletonSection}>
                <div className={styles.skeletonHeader} style={{ width: '45%' }} />
                <div className={styles.skeletonLine} style={{ width: '100%' }} />
                <div className={styles.skeletonLine} style={{ width: '70%' }} />
              </div>

              <div className={styles.skeletonSection}>
                <div className={styles.skeletonHeader} style={{ width: '60%' }} />
                <div className={styles.skeletonLine} style={{ width: '100%' }} />
                <div className={styles.skeletonLine} style={{ width: '100%' }} />
                <div className={styles.skeletonLine} style={{ width: '40%' }} />
              </div>
            </div>
          </div>
        </>
      ) : (
        /* ── Normal tabs (always shown — validation is a tab, not a takeover) ── */
        <>
          {/* ── Validation failure banner ─────────────────────────────── */}
          {showFixBanner && (
            <div className={bannerSeverity === 'red' ? styles.validationFailureBannerRed : styles.validationFailureBannerAmber}>
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
                  {pendingGapCount > 0
                    ? `${pendingGapCount} gap${pendingGapCount === 1 ? '' : 's'} need${pendingGapCount === 1 ? 's' : ''} attention across the design doc sections.`
                    : 'The validation score is below the 90% threshold required for submission.'}
                </div>
                <div className={styles.failureBannerActions}>
                  <button
                    className={bannerSeverity === 'red' ? styles.failureBannerBtnPrimaryRed : styles.failureBannerBtnPrimaryAmber}
                    onClick={() => void handleStartFixWithAI()}
                    disabled={fixValidation.isPending}
                    type="button"
                  >
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M8 2l1.09 3.26L12.36 6l-3.27 1.09L8 10.36 6.91 7.09 3.64 6l3.27-1.09z" />
                      <path d="M13 1l.54 1.63L15.18 3.18 13.54 3.72 13 5.35l-.54-1.63L10.82 3.18l1.64-.55z" />
                    </svg>
                    {fixValidation.isPending ? 'Starting…' : 'Fix with Apex'}
                  </button>
                  <button
                    className={styles.failureBannerBtnSecondary}
                    onClick={() => setActiveTab('validation')}
                    type="button"
                  >
                    Review Report
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* ── Fix flow: fixing progress ────────────────────────────── */}
          {fixFlow.phase === 'fixing' && (
            <FixingProgressView onCancel={handleFixCancel} />
          )}

          {/* ── Fix flow: reviewing/discussing diff panel ────────────── */}
          {(fixFlow.phase === 'reviewing' || fixFlow.phase === 'discussing') && (
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

          {/* ── Normal content (hidden during fix flow) ──────────────── */}
          {!showFixFlow && (
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
                />
              )}
              <div className={styles.tabs}>
                {(['design', 'tech-spec', 'assumptions'] as TabId[]).map((t) => (
                  <button
                    key={t}
                    className={`${styles.tab} ${activeTab === t ? styles.active : ''} ${dirtyTabs.has(t) ? styles.tabDirty : ''}`}
                    onClick={() => setActiveTab(t)}
                    type="button"
                  >
                    {tabLabel[t]}
                    {editingTab === t && <span className={styles.editingIndicator}> ✎</span>}
                  </button>
                ))}
                {hasValidationTab && (
                  <button
                    className={`${styles.tab} ${activeTab === 'validation' ? styles.active : ''}`}
                    onClick={() => setActiveTab('validation')}
                    type="button"
                  >
                    {tabLabel['validation']}
                    {doc.status === 'validating' && !validationReport?.markdown && !doc.validationReportMd && (
                      <svg
                        className={styles.spinIcon}
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        style={{ width: 10, height: 10, marginLeft: 5 }}
                        aria-label="Validation in progress"
                      >
                        <path d="M13 3v4H9" /><path d="M13 7A6 6 0 1 1 9.5 2.5" />
                      </svg>
                    )}
                  </button>
                )}
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

              <div className={styles.tabContent}>
                {activeTab === 'validation' ? (
                  (() => {
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
                  })()
                ) : (
                  <div className={styles.contentWithSidebar}>
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
                    {showCommentLayer && (
                      <ReviewCommentSidebar
                        comments={reviewComments}
                        activeCommentId={activeCommentId}
                        currentUserId={userId ?? ''}
                        documentAuthorUserId={doc.authorId}
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
                    )}
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
