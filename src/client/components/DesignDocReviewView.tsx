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
  useGenerateDesignDoc,
  useMarkValidationReady,
  useRefreshValidation,
  useCancelValidation,
  useCreateValidationThread,
  useValidationReport,
  useFixValidation,
  useAcceptFixValidation,
  useRevertDesignDocSection,
} from '../hooks/useInterviews';
import { useChatStream } from '../hooks/useChatStream';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import { ReviewReasonModal } from './ReviewReasonModal';
import { FixValidationPanel, FixingProgressView } from './FixValidationPanel';
import type { ContentSnapshot, GapChangeEntry } from './FixValidationPanel';
import type { DesignDocStatus, ValidationScorecardGap } from '../../shared/types/interview';
import { parseAgentMessage } from '../utils/parseAgentMessage';
import type { ChoiceBlock } from '../utils/parseAgentMessage';
import { normalizeMermaidBlocks, normalizeMermaidChart } from '../utils/mermaidMarkdown';
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
    case 'interviewing': return styles.badgeInterviewing;
    case 'generating': return styles.badgeGenerating;
    case 'validating': return styles.badgeValidating;
    case 'draft': return styles.badgeDraft;
    case 'pending_review': return styles.badgePendingReview;
    case 'approved': return styles.badgeApproved;
    case 'revision_requested': return styles.badgeRevisionRequested;
  }
}

function statusLabel(status: DesignDocStatus): string {
  switch (status) {
    case 'interviewing': return 'Interviewing';
    case 'generating': return 'Generating';
    case 'validating': return 'Validating';
    case 'draft': return 'Draft';
    case 'pending_review': return 'Pending Review';
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
  onEditToggle: () => void;
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
  onEditToggle,
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
      {canEdit && (
        <div className={styles.previewToolbar}>
          <button className={styles.btnEditInline} onClick={onEditToggle} type="button">
            Edit
          </button>
        </div>
      )}
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

// ── Q&A embedded chat components ──────────────────────────────────────────────

interface QaChoiceBlockUIProps {
  block: ChoiceBlock;
  questionNumber: number;
  selection: string | null;
  freeform: string;
  locked: boolean;
  onSelect: (letter: string) => void;
  onFreeform: (text: string) => void;
}

const QaChoiceBlockUI: React.FC<QaChoiceBlockUIProps> = ({
  block, questionNumber, selection, freeform, locked, onSelect, onFreeform,
}) => (
  <div className={`${styles.qaChoiceBlock} ${locked ? styles.qaChoiceBlockLocked : ''}`}>
    {block.question && (
      <div className={styles.qaChoiceQuestion}>
        <span className={styles.qaChoiceQNum}>Q{questionNumber}</span>
        <div className={styles.qaMarkdownBody} style={{ flex: 1 }}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{block.question}</ReactMarkdown>
        </div>
      </div>
    )}
    <div className={styles.qaChoiceOptions}>
      {block.options.map((opt) => {
        const isSelected = selection === opt.letter;
        return (
          <button
            key={opt.letter}
            className={`${styles.qaChoiceOption} ${isSelected ? styles.qaChoiceOptionSelected : ''}`}
            onClick={() => !locked && onSelect(opt.letter)}
            disabled={locked}
            type="button"
          >
            <span className={styles.qaChoiceOptionLetter}>{opt.letter.toUpperCase()}</span>
            <span className={styles.qaChoiceOptionText}>{opt.text}</span>
          </button>
        );
      })}
      <button
        className={`${styles.qaChoiceOption} ${selection === 'other' ? styles.qaChoiceOptionSelected : ''}`}
        onClick={() => !locked && onSelect('other')}
        disabled={locked}
        type="button"
      >
        <span className={styles.qaChoiceOptionLetter}>✎</span>
        <span className={styles.qaChoiceOptionText}>Other / free-form</span>
      </button>
    </div>
    {selection === 'other' && !locked && (
      <textarea
        className={styles.qaChoiceFreeform}
        placeholder="Type your answer here…"
        value={freeform}
        onChange={(e) => onFreeform(e.target.value)}
        rows={2}
      />
    )}
    {locked && freeform && (
      <div className={styles.qaChoiceFreeformLocked}>{freeform}</div>
    )}
  </div>
);

interface QaQuestionState { selected: string | null; freeform: string; }

interface QaAgentMessageProps {
  text: string;
  threadId: string;
  model: string;
  isRunning: boolean;
  questionOffset: number;
}

const QaAgentMessage: React.FC<QaAgentMessageProps> = ({ text, threadId, model, isRunning, questionOffset }) => {
  const parts = parseAgentMessage(text);
  const choiceBlocks = parts.filter((p): p is ChoiceBlock => p.type === 'choices');

  const [selections, setSelections] = useState<Record<string, QaQuestionState>>(() => {
    const init: Record<string, QaQuestionState> = {};
    for (const b of choiceBlocks) init[b.id] = { selected: null, freeform: '' };
    return init;
  });
  const [sent, setSent] = useState(false);

  const allAnswered = choiceBlocks.every((b) => {
    const s = selections[b.id];
    if (!s) return false;
    if (s.selected === 'other') return s.freeform.trim().length > 0;
    return s.selected !== null;
  });

  const handleSelect = useCallback((blockId: string, letter: string) => {
    setSelections((prev) => ({ ...prev, [blockId]: { ...prev[blockId], selected: letter } }));
  }, []);

  const handleFreeform = useCallback((blockId: string, t: string) => {
    setSelections((prev) => ({ ...prev, [blockId]: { ...prev[blockId], freeform: t } }));
  }, []);

  const handleSubmit = useCallback(() => {
    if (!allAnswered || sent) return;
    const lines: string[] = [];
    let qNum = questionOffset + 1;
    for (const block of choiceBlocks) {
      const s = selections[block.id];
      if (!s) continue;
      if (s.selected === 'other') {
        lines.push(`Q${qNum}: ${s.freeform.trim()}`);
      } else if (s.selected) {
        const opt = block.options.find((o) => o.letter === s.selected);
        lines.push(`Q${qNum}: ${s.selected.toUpperCase()} — ${opt?.text ?? s.selected}`);
      }
      qNum++;
    }
    const messageText = lines.join('\n');
    void fetch(`/api/chat/threads/${threadId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ text: messageText, model }),
    });
    setSent(true);
  }, [allAnswered, sent, choiceBlocks, selections, questionOffset, threadId, model]);

  if (choiceBlocks.length === 0) {
    return (
      <div className={`${styles.qaMessageBubble} ${styles.qaMessageBubbleAssistant}`}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </div>
    );
  }

  let questionCounter = questionOffset;
  return (
    <div className={styles.qaAssistantBubble}>
      {parts.map((part) => {
        if (part.type === 'markdown') {
          return (
            <div key={part.id} className={styles.qaMarkdownBody}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{part.content}</ReactMarkdown>
            </div>
          );
        }
        questionCounter++;
        const qNum = questionCounter;
        const s = selections[part.id] ?? { selected: null, freeform: '' };
        return (
          <QaChoiceBlockUI
            key={part.id}
            block={part}
            questionNumber={qNum}
            selection={s.selected}
            freeform={s.freeform}
            locked={sent}
            onSelect={(letter) => handleSelect(part.id, letter)}
            onFreeform={(t) => handleFreeform(part.id, t)}
          />
        );
      })}
      {!sent && (
        <button
          className={styles.qaChoiceSendBtn}
          onClick={handleSubmit}
          disabled={!allAnswered || isRunning}
          type="button"
        >
          {isRunning ? 'Agent is thinking…' : 'Submit answers ↑'}
        </button>
      )}
      {sent && <div className={styles.qaChoiceSentLabel}>✓ Answers sent</div>}
    </div>
  );
};

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
}

const MIN_PANEL_WIDTH = 280;
const MAX_PANEL_WIDTH = 800;
const DEFAULT_PANEL_WIDTH = 380;

const DesignDocAssistantPanel: React.FC<DesignDocAssistantPanelProps> = ({ designDocId, onClose, discussContext }) => {
  const [threadId, setThreadId] = useState<string | null>(() =>
    discussContext ? null : localStorage.getItem(ASSISTANT_THREAD_LS_KEY(designDocId)),
  );
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
  }, [designDocId, threadId, discussContext]);

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
    if (!text || isRunning || isSending || !threadId) return;
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
  }, [input, isRunning, isSending, threadId]);

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
    </div>
    </>
  );
};

// ── Q&A Transcript (collapsible read-only, post-generation) ───────────────────

interface DesignDocQaTranscriptProps {
  qaChatThreadId: string;
}

const DesignDocQaTranscript: React.FC<DesignDocQaTranscriptProps> = ({ qaChatThreadId }) => {
  const [isOpen, setIsOpen] = useState(false);
  const { messages } = useChatStream(qaChatThreadId);
  const visibleMessages = messages.filter(
    (m) => !(m.role === 'user' && m.text === 'Begin.') && m.role !== 'tool' && m.role !== 'system',
  );

  return (
    <div className={styles.qaTranscript}>
      <button
        className={styles.qaTranscriptToggle}
        onClick={() => setIsOpen((v) => !v)}
        type="button"
        aria-expanded={isOpen}
      >
        <svg
          className={`${styles.qaTranscriptChevron} ${isOpen ? styles.qaTranscriptChevronOpen : ''}`}
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M4 6l4 4 4-4" />
        </svg>
        <span className={styles.qaTranscriptLabel}>Q&amp;A Context</span>
        <span className={styles.qaTranscriptCount}>({visibleMessages.length} messages)</span>
      </button>
      {isOpen && (
        <div className={styles.qaTranscriptBody}>
          <div className={styles.qaTranscriptMessages}>
            {visibleMessages.length === 0 ? (
              <div className={styles.qaTranscriptEmpty}>No Q&amp;A messages recorded.</div>
            ) : (
              visibleMessages.map((msg) => {
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
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
};


interface DesignDocQaChatProps {
  designDocId: string;
  qaChatThreadId: string;
  canTriggerGenerate: boolean;
}

const DesignDocQaChat: React.FC<DesignDocQaChatProps> = ({ designDocId, qaChatThreadId, canTriggerGenerate }) => {
  const { messages, streamingText, status: threadStatus } = useChatStream(qaChatThreadId);
  const generateDoc = useGenerateDesignDoc();
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isRunning = threadStatus === 'running';
  const visibleMessages = messages.filter((m) => !(m.role === 'user' && m.text === 'Begin.'));

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
    if (!text || isRunning || isSending) return;
    setInput('');
    setIsSending(true);
    try {
      await fetch(`/api/chat/threads/${qaChatThreadId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ text }),
      });
    } finally {
      setIsSending(false);
    }
  }, [input, isRunning, isSending, qaChatThreadId]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }, [handleSend]);

  const handleGenerate = useCallback(async () => {
    await generateDoc.mutateAsync(designDocId);
  }, [designDocId, generateDoc]);

  // Compute running question offset per agent message
  let runningQCount = 0;
  const messageQOffsets = new Map<string, number>();
  for (const msg of visibleMessages) {
    if (msg.role === 'agent') {
      messageQOffsets.set(msg.id, runningQCount);
      const parts = parseAgentMessage(msg.text);
      runningQCount += parts.filter((p): p is ChoiceBlock => p.type === 'choices').length;
    }
  }

  return (
    <div className={styles.qaContainer}>
      <div className={styles.qaHeader}>
        <div className={styles.qaHeaderLeft}>
          <span className={styles.qaHeaderTitle}>Design Doc Q&A</span>
          <span className={styles.qaHeaderSub}>Answer the agent's questions, then generate your design doc.</span>
        </div>
        {canTriggerGenerate && (
          <button
            className={styles.qaGenerateBtn}
            onClick={() => void handleGenerate()}
            disabled={generateDoc.isPending || isRunning}
            type="button"
          >
            {generateDoc.isPending ? (
              <>
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={styles.spinIcon}>
                  <path d="M13 3v4H9" /><path d="M13 7A6 6 0 1 1 9.5 2.5" />
                </svg>
                Creating…
              </>
            ) : (
              <>
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="1" width="10" height="14" rx="1.5" />
                  <path d="M6 5h4M6 8h4M6 11h2" />
                </svg>
                Generate Design Doc
              </>
            )}
          </button>
        )}
      </div>

      <div className={styles.qaMessages}>
        <div className={styles.qaMessageList}>
          {visibleMessages.map((msg) => {
            if (msg.role === 'tool') {
              return <div key={msg.id} className={styles.qaMessageBubbleTool}>→ {msg.text}</div>;
            }
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
              <QaAgentMessage
                key={msg.id}
                text={msg.text}
                threadId={qaChatThreadId}
                model="composer-2"
                isRunning={isRunning}
                questionOffset={messageQOffsets.get(msg.id) ?? 0}
              />
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

      <div className={styles.qaInputArea}>
        <div className={styles.qaInputBox}>
          <textarea
            ref={textareaRef}
            className={styles.qaInputField}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isRunning ? 'Agent is thinking…' : 'Continue the conversation… (Enter to send)'}
            rows={1}
            disabled={isRunning || isSending}
          />
          <button
            className={styles.qaSendBtn}
            onClick={() => void handleSend()}
            disabled={!input.trim() || isRunning || isSending}
            type="button"
            aria-label="Send"
          >
            <svg viewBox="0 0 20 20" fill="currentColor">
              <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
};

export const DesignDocReviewView: React.FC = () => {
  const location = useLocation();
  const id = location.pathname.split('/').pop() ?? null;
  const navigate = useNavigate();
  const { can, userId, isAdmin } = useAppShell();

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

  const [fixFlow, fixFlowDispatch] = useReducer(fixFlowReducer, { phase: 'idle' });

  // Restore fix review state from server's fixBaseline on page load.
  // If the doc has a fixBaseline stored (fix was done but not yet accepted/reverted),
  // fetch the assistant thread to recover gap changes and enter reviewing phase.
  // Prefer fixBaseline.fixThreadId (stable) over docAssistantThreadId (can be overwritten by discuss).
  const fixRecoveryAttemptedRef = useRef(false);
  useEffect(() => {
    if (fixRecoveryAttemptedRef.current) return;
    if (!doc || fixFlow.phase !== 'idle') return;
    if (!doc.fixBaseline) return;

    const baseline = doc.fixBaseline as ContentSnapshot;
    const threadId = baseline.fixThreadId ?? doc.docAssistantThreadId;
    if (!threadId) return;

    fixRecoveryAttemptedRef.current = true;

    (async () => {
      try {
        const res = await fetch(`/api/chat/threads/${threadId}`, { credentials: 'include' });
        if (!res.ok) {
          fixFlowDispatch({ type: 'START_FIX', baseline, threadId });
          return;
        }
        const thread = await res.json();
        if (thread.status === 'idle' || thread.status === 'error') {
          const gapChanges = parseGapChangesFromMessages(thread.messages ?? []);
          fixFlowDispatch({ type: 'START_FIX', baseline, threadId });
          fixFlowDispatch({ type: 'FIX_COMPLETE', gapChanges });
        } else {
          fixFlowDispatch({ type: 'START_FIX', baseline, threadId });
        }
      } catch {
        fixFlowDispatch({ type: 'START_FIX', baseline, threadId });
      }
    })();
  }, [doc, fixFlow.phase]);

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

  const [showRevisionModal, setShowRevisionModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [discussContext, setDiscussContext] = useState<DiscussContext | null>(null);

  const isInterviewing = doc?.status === 'interviewing';
  const isGenerating = !isInterviewing && !!doc && (
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
    await submitDoc.mutateAsync(id);
  }, [id, submitDoc]);

  const handleWithdraw = useCallback(async () => {
    if (!id) return;
    await withdrawDoc.mutateAsync(id);
  }, [id, withdrawDoc]);

  const handleApprove = useCallback(async () => {
    if (!id) return;
    await reviewDoc.mutateAsync({ designDocId: id, action: 'approve' });
  }, [id, reviewDoc]);

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
    try {
      const result = await fixValidation.mutateAsync(id);
      fixFlowDispatch({ type: 'START_FIX', baseline, threadId: result.threadId });
    } catch {
      fixFlowDispatch({ type: 'RESET' });
    }
  }, [id, doc, fixValidation]);

  // Poll the assistant thread status during the fixing phase.
  // Only transition to reviewing once the agent is idle (done with all MCP calls).
  const qc = useQueryClient();
  useEffect(() => {
    if (fixFlow.phase !== 'fixing' || !id) return;
    const { threadId } = fixFlow;
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch(`/api/chat/threads/${threadId}`, { credentials: 'include' });
        if (!res.ok) return;
        const thread = await res.json();
        if (cancelled) return;
        if (thread.status === 'idle' || thread.status === 'error') {
          await qc.refetchQueries({ queryKey: ['design-doc', id] });
          const gapChanges = parseGapChangesFromMessages(thread.messages ?? []);
          const agentError = thread.status === 'error'
            ? (thread.lastError ?? 'The AI agent encountered an error and could not complete the fix.')
            : undefined;
          if (!cancelled) {
            fixFlowDispatch({ type: 'FIX_COMPLETE', gapChanges, agentError });
          }
        }
      } catch { /* keep polling */ }
    };

    // Initial delay to let the agent start, then poll every 5s
    const timeout = window.setTimeout(() => {
      if (cancelled) return;
      void poll();
    }, 5_000);
    const interval = window.setInterval(() => {
      if (!cancelled) void poll();
    }, 5_000);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
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
    fixFlowDispatch({ type: 'RESET' });
  }, [id, fixFlow, revertSection]);

  const handleFixCancel = useCallback(() => {
    fixFlowDispatch({ type: 'RESET' });
  }, []);

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

  const handleRequestRevision = useCallback(async (reason: string) => {
    if (!id) return;
    await reviewDoc.mutateAsync({
      designDocId: id,
      action: 'request_revision',
      comment: reason,
    });
    setShowRevisionModal(false);
  }, [id, reviewDoc]);

  if (isLoading) return <div className={styles.loadingState}>Loading Design Doc…</div>;
  if (isError || !doc) return <div className={styles.errorState}>Design doc not found.</div>;

  const isAuthor = doc.authorId === userId;
  const validationBlocking = doc.validationScore !== undefined && doc.validationScore !== null && doc.validationScore < 90;
  const canManage = can('interviews:manage');
  const canReview = can('design-docs:review');
  const isReviewer = canReview && (!isAuthor || isAdmin);
  const canEdit = canManage && (isAuthor || isAdmin) && doc.status !== 'approved';
  const canUseAssistant = (isReviewer || isAdmin) &&
    (doc.status === 'draft' || doc.status === 'pending_review' || doc.status === 'revision_requested');

  const hasAnyContent = !!(doc.designContent || doc.techSpecContent || doc.assumptionsContent);
  const hasValidationTab = !!doc.validationThreadId;

  const showFixBanner =
    validationBlocking &&
    (doc.status === 'draft' || doc.status === 'revision_requested') &&
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
            ← Back
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
            {doc.reviewerId && doc.reviewedAt && (
              <div className={styles.reviewInfo}>
                <span className={styles.reviewInfoRow}>
                  Reviewed by {doc.reviewerName ?? doc.reviewerId} on {formatDate(doc.reviewedAt)}
                </span>
                {doc.reviewComment && (
                  <span className={styles.reviewInfoRow}>"{doc.reviewComment}"</span>
                )}
              </div>
            )}
          </div>
        </div>

        <div className={styles.headerRight}>
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

          {doc.status === 'approved' && (
            <span className={styles.reviewOnlyBadge}>Read-only — approved</span>
          )}

          {canManage && (isAuthor || isAdmin) && (
            <>
              {hasAnyContent &&
                (doc.status === 'draft' || doc.status === 'revision_requested') && (
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
                  onClick={() => void handleSubmit()}
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
                Delete
              </button>
            </>
          )}

          {isReviewer && doc.status === 'pending_review' && (
            <div className={styles.reviewControls}>
              <button
                className={styles.btnApprove}
                onClick={() => void handleApprove()}
                disabled={reviewDoc.isPending || validationBlocking}
                title={validationBlocking ? `Validation score must be ≥ 90% (current: ${doc.validationScore}%)` : undefined}
                type="button"
              >
                Approve
              </button>
              <button
                className={styles.btnRevision}
                onClick={() => setShowRevisionModal(true)}
                type="button"
              >
                Request Revision
              </button>
            </div>
          )}
        </div>
      </div>

      {isInterviewing ? (
        /* ── Q&A interviewing phase ───────────────────────────────── */
        <DesignDocQaChat
          designDocId={doc.id}
          qaChatThreadId={doc.qaChatThreadId ?? ''}
          canTriggerGenerate={canManage && (isAuthor || isAdmin)}
        />
      ) : isGenerating ? (
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
              {doc.qaChatThreadId && (
                <DesignDocQaTranscript qaChatThreadId={doc.qaChatThreadId} />
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
                  <>
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
                      onEditToggle={() => handleEditToggle(activeTab as Exclude<TabId, 'validation'>)}
                      onEditChange={(v) => handleEditChange(activeTab as Exclude<TabId, 'validation'>, v)}
                      onSave={() => void handleSave(activeTab as Exclude<TabId, 'validation'>)}
                      onDiscard={() => handleDiscard(activeTab as Exclude<TabId, 'validation'>)}
                    />
                  </>
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

      {showRevisionModal && (
        <ReviewReasonModal
          itemName={doc.title}
          docTypeName="Design Doc"
          isPending={reviewDoc.isPending}
          onConfirm={(reason) => void handleRequestRevision(reason)}
          onCancel={() => setShowRevisionModal(false)}
        />
      )}
    </div>
  );
};

export default DesignDocReviewView;
