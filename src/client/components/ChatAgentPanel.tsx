import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAgentChatSession } from '../hooks/useAgentChatSession';
import {
  useChatThreadList,
  useSkillList,
} from '../hooks/useChatThreads';
import { DEFAULT_MODEL_ID, modelBadge } from '../config/models';
import { useAvailableModels, useGlobalDefaultModel, useProjectSkillConfig } from '../hooks/useProjectSkillConfig';
import { useChatAttachments } from '../hooks/useChatAttachments';
import type {
  ChatAttachment,
  ChatThread,
  ChatMessage,
  SelectChatThreadHandler,
  SelectChatThreadOptions,
} from '../../shared/types/chat';
import type { QuickMcpPill, QuickSkillPill } from '../../shared/types/projectSettings';
import { PRDPreviewDrawer } from './PRDPreviewDrawer';
import { ThreadHistorySidebar } from './ThreadHistorySidebar';
import { AgentComposer, AgentPanelShell } from './agentChat';
import { parseAgentMessage } from '../utils/parseAgentMessage';
import type { ChoiceBlock } from '../utils/parseAgentMessage';
import { useFocusChatMessage } from '../hooks/useFocusChatMessage';
import styles from './ChatAgentPanel.module.css';

const MIN_WIDTH = 340;
const MAX_WIDTH_RATIO = 0.92;
const DEFAULT_WIDTH = 580;
const LS_WIDTH_KEY = 'chatPanelWidth';

function testIdSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function loadStoredWidth(): number {
  try {
    const v = localStorage.getItem(LS_WIDTH_KEY);
    if (v) {
      const n = parseInt(v, 10);
      if (n >= MIN_WIDTH) return n;
    }
  } catch { /* ignore */ }
  return DEFAULT_WIDTH;
}

// ── Interactive choice block ───────────────────────────────────────────────────

interface ChoiceBlockProps {
  block: ChoiceBlock;
  questionNumber: number;
  selection: string | null;
  freeform: string;
  locked: boolean;
  onSelect: (letter: string) => void;
  onFreeform: (text: string) => void;
}

const ChoiceBlockUI: React.FC<ChoiceBlockProps> = ({
  block,
  questionNumber,
  selection,
  freeform,
  locked,
  onSelect,
  onFreeform,
}) => {
  const showFreeform = selection === 'other' || (!selection && block.options.every((o) => o.letter !== 'other'));

  return (
    <div className={`${styles.choiceBlock} ${locked ? styles.choiceBlockLocked : ''}`}>
      {block.question && (
        <div className={styles.choiceQuestion}>
          <span className={styles.choiceQNum}>Q{questionNumber}</span>
          <div className={styles.markdownBody} style={{ flex: 1 }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{block.question}</ReactMarkdown>
          </div>
        </div>
      )}
      <div className={styles.choiceOptions}>
        {block.options.map((opt) => {
          const isSelected = selection === opt.letter;
          return (
            <button
              key={opt.letter}
              className={`${styles.choiceOption} ${isSelected ? styles.choiceOptionSelected : ''}`}
              onClick={() => !locked && onSelect(opt.letter)}
              disabled={locked}
              type="button"
              {...{ 'data-testid': `chat-agent-choice-option-${opt.letter}` }}
            >
              <span className={styles.choiceOptionLetter}>{opt.letter.toUpperCase()}</span>
              <span className={styles.choiceOptionText}>{opt.text}</span>
            </button>
          );
        })}
        {/* Other / free-form option */}
        <button
          className={`${styles.choiceOption} ${selection === 'other' ? styles.choiceOptionSelected : ''}`}
          onClick={() => !locked && onSelect('other')}
          disabled={locked}
          type="button"
          {...{ 'data-testid': 'chat-agent-choice-option-other' }}
        >
          <span className={styles.choiceOptionLetter}>✎</span>
          <span className={styles.choiceOptionText}>Other / free-form</span>
        </button>
      </div>
      {(showFreeform || selection === 'other') && !locked && (
        <textarea
          className={styles.choiceFreeform}
          placeholder="Type your answer here…"
          value={freeform}
          onChange={(e) => onFreeform(e.target.value)}
          rows={2}
          {...{ 'data-testid': 'chat-agent-choice-freeform' }}
        />
      )}
      {locked && freeform && (
        <div className={styles.choiceFreeformLocked}>{freeform}</div>
      )}
    </div>
  );
};

// ── Agent message with interactive questions ──────────────────────────────────

interface AgentMessageProps {
  msg: ChatMessage;
  onSend: (text: string) => void;
  isRunning: boolean;
  highlighted?: boolean;
}

interface QuestionState {
  selected: string | null;
  freeform: string;
}

const AgentMessage: React.FC<AgentMessageProps> = ({ msg, onSend, isRunning, highlighted }) => {
  const parts = parseAgentMessage(msg.text);
  const choiceBlocks = parts.filter((p): p is ChoiceBlock => p.type === 'choices');

  const [selections, setSelections] = useState<Record<string, QuestionState>>(() => {
    const init: Record<string, QuestionState> = {};
    for (const b of choiceBlocks) {
      init[b.id] = { selected: null, freeform: '' };
    }
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
    setSelections((prev) => ({
      ...prev,
      [blockId]: { ...prev[blockId], selected: letter },
    }));
  }, []);

  const handleFreeform = useCallback((blockId: string, text: string) => {
    setSelections((prev) => ({
      ...prev,
      [blockId]: { ...prev[blockId], freeform: text },
    }));
  }, []);

  const handleSend = () => {
    if (!allAnswered || sent) return;
    const lines: string[] = [];
    let qNum = 1;
    for (const block of choiceBlocks) {
      const s = selections[block.id];
      if (!s) continue;
      if (s.selected === 'other') {
        lines.push(`Q${qNum}: ${s.freeform.trim()}`);
      } else if (s.selected) {
        const opt = block.options.find((o) => o.letter === s.selected);
        lines.push(`Q${qNum}: ${s.selected.toUpperCase()} — ${opt?.text ?? s.selected}`);
        if (s.freeform.trim()) lines.push(`  Additional notes: ${s.freeform.trim()}`);
      }
      qNum++;
    }
    onSend(lines.join('\n'));
    setSent(true);
  };

  let questionCounter = 0;

  return (
    <div
      data-message-id={msg.id}
      {...(highlighted ? { 'data-testid': 'chat-message-highlighted' } : {})}
      className={`${styles.message} ${styles.roleAgent} ${highlighted ? styles.messageHighlighted : ''}`.trim()}
    >
      <div className={styles.agentHeader}>
        <span className={styles.agentAvatar}>AI</span>
        <span className={styles.agentLabel}>Agent</span>
        <span className={styles.messageMeta}>{new Date(msg.ts).toLocaleTimeString()}</span>
      </div>
      <div className={styles.agentBubble}>
        {parts.map((part) => {
          if (part.type === 'markdown') {
            return (
              <div key={part.id} className={styles.markdownBody}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{part.content}</ReactMarkdown>
              </div>
            );
          }
          questionCounter++;
          const qNum = questionCounter;
          const s = selections[part.id] ?? { selected: null, freeform: '' };
          return (
            <ChoiceBlockUI
              key={part.id}
              block={part}
              questionNumber={qNum}
              selection={s.selected}
              freeform={s.freeform}
              locked={sent}
              onSelect={(letter) => handleSelect(part.id, letter)}
              onFreeform={(text) => handleFreeform(part.id, text)}
            />
          );
        })}

        {choiceBlocks.length > 0 && !sent && (
          <button
            className={styles.choiceSendBtn}
            onClick={handleSend}
            disabled={!allAnswered || isRunning}
            type="button"
            {...{ 'data-testid': 'chat-agent-choice-send-btn' }}
          >
            {isRunning ? 'Agent is thinking…' : 'Submit answers ↑'}
          </button>
        )}

        {sent && choiceBlocks.length > 0 && (
          <div className={styles.choiceSentLabel}>✓ Answers sent</div>
        )}
      </div>
    </div>
  );
};

// ── Tool call chip ────────────────────────────────────────────────────────────

function ToolCallBubble({ msg, highlighted }: { msg: ChatMessage; highlighted?: boolean }) {
  return (
    <div
      data-message-id={msg.id}
      {...(highlighted ? { 'data-testid': 'chat-message-highlighted' } : {})}
      className={`${styles.message} ${styles.roleTool} ${highlighted ? styles.messageHighlighted : ''}`.trim()}
    >
      <div className={styles.toolCallChip}>{msg.text}</div>
    </div>
  );
}

// ── User bubble ───────────────────────────────────────────────────────────────

function UserBubble({ msg, highlighted }: { msg: ChatMessage; highlighted?: boolean }) {
  return (
    <div
      data-message-id={msg.id}
      {...(highlighted ? { 'data-testid': 'chat-message-highlighted' } : {})}
      className={`${styles.message} ${styles.roleUser} ${highlighted ? styles.messageHighlighted : ''}`.trim()}
    >
      <div className={styles.userBubble}>
        <span className={styles.userBubbleText}>{msg.text}</span>
        {msg.attachments && msg.attachments.length > 0 && (
          <div className={styles.messageAttachments}>
            {msg.attachments.map((attachment) => (
              <span key={attachment.id} className={styles.messageAttachment}>
                {attachment.name}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className={styles.messageMeta}>{new Date(msg.ts).toLocaleTimeString()}</div>
    </div>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────────────

interface ChatAgentPanelProps {
  thread: ChatThread | null;
  isOpen: boolean;
  onClose: () => void;
  onNewChat: (options?: StartPanelChatOptions) => void | Promise<void>;
  onSelectThread?: SelectChatThreadHandler;
  canStartNewChat?: boolean;
  isStartingNewChat?: boolean;
  newChatError?: string;
  selectedProject?: string;
  selectedSkillSettingsId?: string | null;
  launchedFromHome?: boolean;
}

export interface StartPanelChatOptions {
  model?: string;
  quickSkill?: QuickSkillPill;
  mcpPill?: QuickMcpPill;
  initialMessage?: string;
}

export const ChatAgentPanel: React.FC<ChatAgentPanelProps> = ({
  thread,
  isOpen,
  onClose,
  onNewChat,
  onSelectThread,
  canStartNewChat = true,
  isStartingNewChat = false,
  newChatError,
  selectedProject,
  selectedSkillSettingsId,
  launchedFromHome = false,
}) => {
  const [input, setInput] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [focusMessageId, setFocusMessageId] = useState<string | undefined>();
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const [skillPickerIdx, setSkillPickerIdx] = useState(0);
  const [showPrdPreview, setShowPrdPreview] = useState(false);
  const [panelWidth, setPanelWidth] = useState<number>(loadStoredWidth);
  const [selectedModel, setSelectedModel] = useState<string>(
    thread?.kickoff.model ?? DEFAULT_MODEL_ID,
  );
  const [selectedQuickSkill, setSelectedQuickSkill] = useState<QuickSkillPill | null>(null);
  const [selectedMcpPill, setSelectedMcpPill] = useState<QuickMcpPill | null>(null);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const skillPickerRef = useRef<HTMLDivElement | null>(null);
  const isDragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartWidth = useRef(0);
  const prdAutoOpenedRef = useRef(false);

  const {
    attachments,
    attachmentError,
    addFiles,
    removeAttachment,
    clearAttachments,
  } = useChatAttachments();

  const session = useAgentChatSession(thread?.id ?? null, {
    initialMessages: thread?.messages,
    initialStatus: thread?.status,
    initialActiveRunId: thread?.activeRunId,
    initialPrdReady: thread?.prdReady,
    visibleMessageFilter: (m) =>
      !(m.role === 'user' && m.text === 'Begin.')
      && m.toolName !== '_reasoning'
      && m.toolName !== '_thinking',
  });
  const { messages, streamingText, isConnected, prdReady, isRunning, status, progressLabel, showTypingIndicator } = session;

  const { data: availableModels, isLoading: modelsLoading } = useAvailableModels();
  const { data: globalDefaultModel } = useGlobalDefaultModel();
  const { data: skillConfig } = useProjectSkillConfig(
    launchedFromHome ? selectedProject ?? null : null,
    selectedSkillSettingsId,
  );
  const { data: recentThreads = [] } = useChatThreadList(
    3,
    launchedFromHome ? selectedProject : null,
  );

  // Skills for the current thread (used by the / picker)
  const { data: threadSkills = [] } = useSkillList(
    thread?.kickoff.project ?? null,
    thread?.kickoff.repo ?? null,
    thread?.kickoff.branch,
  );

  // Slash-command: extract query after leading "/"
  const slashQuery = useMemo(() => {
    const m = input.match(/^\/(.*)$/s);
    return m ? m[1].toLowerCase() : null;
  }, [input]);

  const filteredSkills = useMemo(() => {
    if (slashQuery === null) return [];
    if (!slashQuery) return threadSkills;
    return threadSkills.filter(
      (s) =>
        s.name.toLowerCase().includes(slashQuery) ||
        s.path.toLowerCase().includes(slashQuery),
    );
  }, [slashQuery, threadSkills]);

  const hasPrd = prdReady;

  const highlightedMessageId = useFocusChatMessage(
    focusMessageId,
    messages
      .filter(
        (m) =>
          !(m.role === 'user' && m.text === 'Begin.') &&
          m.toolName !== '_reasoning' &&
          m.toolName !== '_thinking',
      )
      .map((m) => m.id),
  );

  const handleSelectThreadFromHistory = useCallback(
    (id: string, options?: SelectChatThreadOptions) => {
      setFocusMessageId(options?.focusMessageId);
      onSelectThread?.(id, options);
      setShowHistory(false);
    },
    [onSelectThread],
  );

  const skipScrollToEndRef = useRef(false);
  skipScrollToEndRef.current = Boolean(focusMessageId || highlightedMessageId);
  useEffect(() => {
    if (skipScrollToEndRef.current) return;
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingText]);

  useEffect(() => {
    if (thread) {
      // Sync the model dropdown to whatever the thread was started with
      // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional sync when thread id changes
      setSelectedModel(thread.kickoff.model ?? globalDefaultModel?.value ?? DEFAULT_MODEL_ID);
      // Reset auto-open guard for the new thread
      prdAutoOpenedRef.current = false;
    }
  }, [thread?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-open PRD preview the first time the server signals prdReady
  useEffect(() => {
    if (prdReady && !prdAutoOpenedRef.current) {
      prdAutoOpenedRef.current = true;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot open when PRD becomes ready
      setShowPrdPreview(true);
    }
  }, [prdReady]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  // Scroll the highlighted skill picker item into view on keyboard navigation
  useEffect(() => {
    if (!skillPickerOpen || !skillPickerRef.current) return;
    const active = skillPickerRef.current.querySelector<HTMLElement>('[data-picker-active="true"]');
    active?.scrollIntoView({ block: 'nearest' });
  }, [skillPickerIdx, skillPickerOpen]);

  // ── Resize handle ────────────────────────────────────────────────────────────

  const onResizeMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    dragStartX.current = e.clientX;
    dragStartWidth.current = panelWidth;
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
  }, [panelWidth]);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      const dx = dragStartX.current - e.clientX;
      const maxWidth = Math.floor(window.innerWidth * MAX_WIDTH_RATIO);
      const newWidth = Math.min(Math.max(dragStartWidth.current + dx, MIN_WIDTH), maxWidth);
      setPanelWidth(newWidth);
    };
    const onMouseUp = () => {
      if (!isDragging.current) return;
      isDragging.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setPanelWidth((w) => {
        try { localStorage.setItem(LS_WIDTH_KEY, String(w)); } catch { /* ignore */ }
        return w;
      });
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  // ── Actions ──────────────────────────────────────────────────────────────────

  const doSend = useCallback(async (text: string, messageAttachments: ChatAttachment[] = []) => {
    const trimmedText = text.trim();
    if ((!trimmedText && messageAttachments.length === 0) || isRunning || !thread) return;
    setInput('');
    setSkillPickerOpen(false);
    await session.send(
      trimmedText || 'Please use the attached files as additional context.',
      { model: selectedModel, attachments: messageAttachments },
    );
    if (messageAttachments.length > 0) clearAttachments();
  }, [isRunning, thread, session, selectedModel, clearAttachments]);

  const selectSkill = useCallback((skill: { name: string; path: string }) => {
    const msg = `Run skill: ${skill.name} (\`${skill.path}\`)`;
    setInput(msg);
    setSkillPickerOpen(false);
  }, []);

  const handleAttachmentChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    await addFiles(e.currentTarget.files);
    e.currentTarget.value = '';
  };

  const openFilePicker = () => {
    fileInputRef.current?.click();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (skillPickerOpen && filteredSkills.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSkillPickerIdx((i) => (i + 1) % filteredSkills.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSkillPickerIdx((i) => (i - 1 + filteredSkills.length) % filteredSkills.length);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        selectSkill(filteredSkills[skillPickerIdx]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSkillPickerOpen(false);
      }
    }
  };

  const handleClose = () => {
    onClose();
  };

  // ── Derived ──────────────────────────────────────────────────────────────────

  const statusDotClass =
    status === 'running' ? styles.statusDotRunning
    : status === 'error' ? styles.statusDotError
    : status === 'closed' ? styles.statusDotClosed
    : styles.statusDotIdle;

  const visibleMessages = messages.filter((m) =>
    !(m.role === 'user' && m.text === 'Begin.') &&
    m.toolName !== '_reasoning' && m.toolName !== '_thinking'
  );

  // A selected thread can legitimately hold nothing to show: the kickoff prompt
  // is hidden, and a run that never produced a reply persists no agent message.
  const hasEmptyTranscript =
    visibleMessages.length === 0 && !showTypingIndicator && !streamingText;

  const statusLabel =
    status === 'running' ? 'Agent is thinking…'
    : status === 'error' ? 'Error occurred'
    : status === 'closed' ? 'Thread closed'
    : hasEmptyTranscript ? 'No messages'
    : visibleMessages.length === 0 ? 'Starting skill…'
    : 'Ready';

  const quickSkillPills = skillConfig?.quickSkillPills ?? [];
  const quickMcpPills = skillConfig?.quickMcpPills ?? [];

  const startFromEmptyComposer = async () => {
    const message = input.trim();
    if (!message && !selectedQuickSkill && !selectedMcpPill) return;
    await onNewChat({
      model: selectedModel,
      quickSkill: selectedQuickSkill ?? undefined,
      mcpPill: selectedMcpPill ?? undefined,
      initialMessage: message || undefined,
    });
    setInput('');
    setSelectedQuickSkill(null);
    setSelectedMcpPill(null);
  };

  if (!isOpen) return null;

  return (
    <AgentPanelShell
      title="Agent Chat"
      ariaLabel="Agent chat panel"
      onClose={handleClose}
      closeTestId="chat-agent-close-btn"
      width={panelWidth}
      onResizeMouseDown={onResizeMouseDown}
      actions={(
        <>
          {onSelectThread && (
            <button
              className={styles.iconBtn}
              onClick={() => setShowHistory((v) => !v)}
              title="Thread history"
              {...{ 'data-testid': 'chat-agent-history-btn' }}
            >
              {showHistory ? '← Back' : '⏱ History'}
            </button>
          )}
          <button
            className={styles.iconBtn}
            onClick={() => { void onNewChat(); }}
            title="New chat"
            disabled={!canStartNewChat || isStartingNewChat || isRunning}
            {...{ 'data-testid': 'chat-agent-new-chat-btn' }}
          >
            {isStartingNewChat ? 'Starting…' : '+ New'}
          </button>
        </>
      )}
      status={thread ? (
        <div className={styles.statusBar}>
          <span className={`${styles.statusDot} ${statusDotClass}`} />
          <span className={styles.statusText}>{statusLabel}</span>
          <span className={styles.connBadge}>{isConnected ? '● live' : '○ Disconnected'}</span>
        </div>
      ) : undefined}
      before={launchedFromHome ? (
        <>
          <section className={styles.quickPills} aria-label="Home chat shortcuts">
            {quickSkillPills.length > 0 && <h3>Skills</h3>}
            <div className={styles.pillRow}>
              {quickSkillPills.map((pill) => (
                <button
                  key={pill.skillPath}
                  type="button"
                  className={`${styles.quickPill} ${selectedQuickSkill?.skillPath === pill.skillPath ? styles.quickPillSelected : ''}`}
                  onClick={() => {
                    const selected = selectedQuickSkill?.skillPath === pill.skillPath ? null : pill;
                    setSelectedQuickSkill(selected);
                    setSelectedMcpPill(null);
                    setSelectedModel(selected?.model ?? globalDefaultModel?.value ?? DEFAULT_MODEL_ID);
                  }}
                  {...{ 'data-testid': `chat-agent-skill-pill-${testIdSegment(pill.skillPath)}` }}
                >
                  {pill.label}
                </button>
              ))}
            </div>
            {quickMcpPills.length > 0 && <h3>MCP Servers</h3>}
            <div className={styles.pillRow}>
              {quickMcpPills.map((pill) => (
                <button
                  key={pill.mcpServerName}
                  type="button"
                  className={`${styles.quickPill} ${selectedMcpPill?.mcpServerName === pill.mcpServerName ? styles.quickPillSelected : ''}`}
                  onClick={() => {
                    const selected = selectedMcpPill?.mcpServerName === pill.mcpServerName ? null : pill;
                    setSelectedMcpPill(selected);
                    setSelectedQuickSkill(null);
                    setSelectedModel(selected?.model ?? globalDefaultModel?.value ?? DEFAULT_MODEL_ID);
                  }}
                  {...{ 'data-testid': `chat-agent-mcp-pill-${testIdSegment(pill.mcpServerName)}` }}
                >
                  {pill.label}
                </button>
              ))}
            </div>
          </section>
          <section className={styles.recentThreads} aria-label="Recent Threads">
            <div className={styles.recentHeader}>
              <h3>Recent Threads</h3>
              {onSelectThread && (
                <button
                  type="button"
                  className={styles.seeAll}
                  onClick={() => setShowHistory(true)}
                  {...{ 'data-testid': 'chat-agent-recent-see-all' }}
                >
                  See all
                </button>
              )}
            </div>
            {recentThreads.length === 0 ? (
              <p>No threads yet.</p>
            ) : recentThreads.slice(0, 3).map((recent) => (
              <button
                key={recent.id}
                type="button"
                className={styles.recentThread}
                onClick={() => handleSelectThreadFromHistory(recent.id)}
                {...{ 'data-testid': `chat-agent-recent-thread-${recent.id}` }}
              >
                <span>{recent.title}</span>
                <time dateTime={recent.lastActivityAt}>{new Date(recent.lastActivityAt).toLocaleDateString()}</time>
              </button>
            ))}
          </section>
        </>
      ) : undefined}
    >

      {showHistory && onSelectThread ? (
        <ThreadHistorySidebar
          activeThreadId={thread?.id ?? null}
          onSelectThread={handleSelectThreadFromHistory}
          onDeleteThread={(id) => { if (id === thread?.id) onSelectThread(''); }}
          onClose={() => setShowHistory(false)}
          project={selectedProject}
          className={styles.historySidebarInPanel}
        />
      ) : !thread ? (
        <>
          <div className={styles.emptyPane}>
          <span className={styles.emptyIcon}>AI</span>
          <h3 className={styles.emptyTitle}>No conversation yet</h3>
          <p className={styles.emptyHint}>Select a skill above or type your first message to start a new thread with Apex.</p>
          {newChatError && <p className={styles.emptyError}>{newChatError}</p>}
          <div className={styles.quickStarts}>
            {['Write a PRD', 'Review my code', 'Plan a sprint'].map((label) => (
              <button
                key={label}
                type="button"
                className={styles.quickPill}
                onClick={() => setInput(label)}
                {...{ 'data-testid': `chat-agent-quick-start-${label.toLowerCase().replace(/ /g, '-')}` }}
              >
                {label}
              </button>
            ))}
          </div>
          </div>
          <AgentComposer
            className={styles.composerEmbed}
            value={input}
            onChange={setInput}
            onSend={() => { void startFromEmptyComposer(); }}
            disabled={!canStartNewChat || isStartingNewChat}
            isSending={isStartingNewChat}
            canSend={Boolean(input.trim() || selectedQuickSkill || selectedMcpPill)}
            placeholder="Start a new conversation…"
            testIdPrefix="chat-agent"
            model={selectedModel}
            models={availableModels}
            modelsLoading={modelsLoading}
            onModelChange={setSelectedModel}
            {...{ 'data-testid': 'chat-agent-composer' }}
          />
        </>
      ) : (
        <>
          {!isConnected && (
            <div
              className={styles.connectionError}
              role="status"
              {...{ 'data-testid': 'chat-agent-connection-banner' }}
            >
              Live connection interrupted. Your conversation is still here; reconnecting…
            </div>
          )}
          <div className={styles.messages}>
            {hasEmptyTranscript && (
              <div
                className={styles.transcriptEmpty}
                {...{ 'data-testid': 'chat-agent-empty-transcript' }}
              >
                <h3 className={styles.transcriptEmptyTitle}>No messages in this conversation</h3>
                {thread.lastError ? (
                  <p className={styles.transcriptEmptyError} role="status">
                    The last agent run did not finish: {thread.lastError}
                  </p>
                ) : null}
                <p className={styles.transcriptEmptyHint}>
                  {status === 'closed'
                    ? 'This thread is closed, so nothing was saved to it.'
                    : 'Send a message to start it.'}
                </p>
              </div>
            )}
            {visibleMessages.map((msg, idx) => {
              const highlighted = highlightedMessageId === msg.id;
              if (msg.role === 'tool') return <ToolCallBubble key={msg.id} msg={msg} highlighted={highlighted} />;
              if (msg.role === 'user') return <UserBubble key={msg.id} msg={msg} highlighted={highlighted} />;
              if (msg.role === 'system') {
                const isError = msg.text.startsWith('Error:');
                const lastUserText = isError
                  ? visibleMessages.slice(0, idx).reverse().find((m) => m.role === 'user')?.text ?? null
                  : null;
                if (isError && lastUserText) {
                  return (
                    <div
                      key={msg.id}
                      data-message-id={msg.id}
                      {...(highlighted ? { 'data-testid': 'chat-message-highlighted' } : {})}
                      className={`${styles.systemErrorMsg} ${highlighted ? styles.messageHighlighted : ''}`.trim()}
                    >
                      <span
                        className={styles.systemErrorText}
                        role="alert"
                        {...{ 'data-testid': 'chat-run-terminal' }}
                      >
                        {msg.text}
                      </span>
                      <button
                        className={styles.retryBtn}
                        onClick={() => doSend(lastUserText)}
                        disabled={isRunning}
                        type="button"
                        {...{ 'data-testid': 'chat-agent-message-retry-btn' }}
                      >
                        ↺ Try again
                      </button>
                    </div>
                  );
                }
                return (
                  <div
                    key={msg.id}
                    data-message-id={msg.id}
                    {...(highlighted ? { 'data-testid': 'chat-message-highlighted' } : {})}
                    className={`${styles.systemMsg} ${highlighted ? styles.messageHighlighted : ''}`.trim()}
                  >
                    {isError ? (
                      <span role="alert" {...{ 'data-testid': 'chat-run-terminal' }}>
                        {msg.text}
                      </span>
                    ) : msg.text}
                  </div>
                );
              }
              return (
                <AgentMessage
                  key={msg.id}
                  msg={msg}
                  onSend={doSend}
                  isRunning={isRunning}
                  highlighted={highlighted}
                />
              );
            })}

            {/* Loading spinner — shown while waiting for first tokens */}
            {showTypingIndicator && (
              <div
                className={styles.message}
                role="status"
                aria-live="polite"
                aria-label={progressLabel ?? 'Agent is processing'}
                {...{ 'data-testid': 'chat-run-spinner' }}
              >
                <div className={styles.agentHeader}>
                  <span className={styles.agentAvatar}>AI</span>
                  <span className={styles.agentLabel}>Agent</span>
                </div>
                <div className={styles.agentBubble}>
                  <div className={styles.typingIndicator}>
                    <span className={styles.typingDot} />
                    <span className={styles.typingDot} />
                    <span className={styles.typingDot} />
                  </div>
                  {progressLabel && (
                    <p
                      className={styles.progressLabel}
                      {...{ 'data-testid': 'chat-agent-progress-label' }}
                    >
                      {progressLabel}
                    </p>
                  )}
                </div>
              </div>
            )}

            {/* Streaming in-progress text */}
            {streamingText && (
              <div className={styles.message}>
                <div className={styles.agentHeader}>
                  <span className={styles.agentAvatar}>AI</span>
                  <span className={styles.agentLabel}>Agent</span>
                </div>
                <div className={styles.agentBubble}>
                  <div className={styles.streamingBody}>
                    {streamingText}<span className={styles.cursor} />
                  </div>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {hasPrd && (
            <div className={styles.prdBanner}>
              <span className={styles.prdBannerText}>📄 PRD is ready for review</span>
              <div className={styles.prdActions}>
                <button
                  className={styles.btnSecondary}
                  onClick={() => setShowPrdPreview(true)}
                  type="button"
                  {...{ 'data-testid': 'chat-agent-prd-preview-btn' }}
                >
                  Preview
                </button>
              </div>
            </div>
          )}

          <AgentComposer
            className={styles.composerEmbed}
            value={input}
            onChange={(val) => {
              setInput(val);
              const isSlash = /^\//.test(val);
              setSkillPickerOpen(isSlash);
              if (isSlash) setSkillPickerIdx(0);
            }}
            onSend={() => void doSend(input, attachments)}
            onCancel={() => void session.cancel()}
            disabled={status === 'closed'}
            isRunning={isRunning}
            isBusy={isRunning || status === 'closed'}
            placeholder={isRunning ? 'Agent is thinking…' : 'Message agent · type / to invoke a skill…'}
            testIdPrefix="chat-agent"
            {...{ 'data-testid': 'chat-agent-composer' }}
            allowEmptySend
            attachments={attachments}
            attachmentError={attachmentError}
            onRemoveAttachment={removeAttachment}
            onAttachClick={openFilePicker}
            model={selectedModel}
            models={availableModels}
            modelsLoading={modelsLoading}
            onModelChange={setSelectedModel}
            onKeyDown={handleKeyDown}
            textareaRef={textareaRef}
            fileInput={(
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className={styles.fileInput}
                onChange={handleAttachmentChange}
                disabled={isRunning || status === 'closed'}
              />
            )}
            before={skillPickerOpen ? (
              <div className={styles.skillPicker} ref={skillPickerRef}>
                <div className={styles.skillPickerHeader}>
                  {filteredSkills.length === 0
                    ? 'No skills match — keep typing'
                    : `${filteredSkills.length} skill${filteredSkills.length !== 1 ? 's' : ''} · ↑↓ navigate · Enter select · Esc dismiss`}
                </div>
                {filteredSkills.map((skill, idx) => (
                  <button
                    key={skill.id}
                    data-picker-active={idx === skillPickerIdx ? 'true' : undefined}
                    className={`${styles.skillPickerItem} ${idx === skillPickerIdx ? styles.skillPickerItemActive : ''}`}
                    onMouseDown={(e) => { e.preventDefault(); selectSkill(skill); }}
                    onMouseEnter={() => setSkillPickerIdx(idx)}
                    type="button"
                  >
                    <span className={styles.skillPickerName}>{skill.name}</span>
                    {skill.description && (
                      <span className={styles.skillPickerDesc}>{skill.description}</span>
                    )}
                  </button>
                ))}
              </div>
            ) : undefined}
            after={(
              <div className={styles.inputHint}>
                <span className={styles.modelBadge}>{modelBadge(selectedModel)}</span>
                Enter to send · Shift+Enter for newline · <kbd className={styles.kbdHint}>/</kbd> invoke skill
              </div>
            )}
          />

          {showPrdPreview && (
            // data-testid-exempt — PRDPreviewDrawer owns its interactive test ids
            <PRDPreviewDrawer
              threadId={thread.id}
              title={`${thread.kickoff.repo} PRD`}
              onClose={() => setShowPrdPreview(false)}
            />
          )}
        </>
      )}
    </AgentPanelShell>
  );
};
