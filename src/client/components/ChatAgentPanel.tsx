import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useChatStream } from '../hooks/useChatStream';
import {
  useSendMessage,
  useCancelRun,
  useCloseThread,
  useSkillList,
} from '../hooks/useChatThreads';
import { DEFAULT_MODEL_ID, modelBadge } from '../config/models';
import { useAvailableModels, useGlobalDefaultModel } from '../hooks/useProjectSkillConfig';
import { formatAttachmentSize, useChatAttachments } from '../hooks/useChatAttachments';
import type { ChatAttachment, ChatThread, ChatMessage } from '../../shared/types/chat';
import { PRDPreviewDrawer } from './PRDPreviewDrawer';
import { ThreadHistorySidebar } from './ThreadHistorySidebar';
import { parseAgentMessage } from '../utils/parseAgentMessage';
import type { ChoiceBlock } from '../utils/parseAgentMessage';
import styles from './ChatAgentPanel.module.css';

const MIN_WIDTH = 340;
const MAX_WIDTH_RATIO = 0.92;
const DEFAULT_WIDTH = 580;
const LS_WIDTH_KEY = 'chatPanelWidth';

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
}

interface QuestionState {
  selected: string | null;
  freeform: string;
}

const AgentMessage: React.FC<AgentMessageProps> = ({ msg, onSend, isRunning }) => {
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
    <div className={`${styles.message} ${styles.roleAgent}`}>
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

function ToolCallBubble({ msg }: { msg: ChatMessage }) {
  return (
    <div className={`${styles.message} ${styles.roleTool}`}>
      <div className={styles.toolCallChip}>{msg.text}</div>
    </div>
  );
}

// ── User bubble ───────────────────────────────────────────────────────────────

function UserBubble({ msg }: { msg: ChatMessage }) {
  return (
    <div className={`${styles.message} ${styles.roleUser}`}>
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
  onNewChat: () => void | Promise<void>;
  onSelectThread?: (threadId: string) => void;
  canStartNewChat?: boolean;
  isStartingNewChat?: boolean;
  newChatError?: string;
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
}) => {
  const [input, setInput] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const [skillPickerIdx, setSkillPickerIdx] = useState(0);
  const [showPrdPreview, setShowPrdPreview] = useState(false);
  const [panelWidth, setPanelWidth] = useState<number>(loadStoredWidth);
  const [selectedModel, setSelectedModel] = useState<string>(
    thread?.kickoff.model ?? DEFAULT_MODEL_ID,
  );

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

  const { messages, streamingText, status, isConnected, prdReady } = useChatStream(
    thread?.id ?? null,
    { initialMessages: thread?.messages, initialStatus: thread?.status, initialPrdReady: thread?.prdReady },
  );

  const sendMessage = useSendMessage(thread?.id ?? '');
  const cancelRun = useCancelRun(thread?.id ?? '');
  const closeThread = useCloseThread();

  const { data: availableModels, isLoading: modelsLoading } = useAvailableModels();
  const { data: globalDefaultModel } = useGlobalDefaultModel();

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

  const isRunning = status === 'running';
  const hasPrd = prdReady;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingText]);

  useEffect(() => {
    if (thread) {
      // Sync the model dropdown to whatever the thread was started with
      setSelectedModel(thread.kickoff.model ?? globalDefaultModel?.value ?? DEFAULT_MODEL_ID);
      // Reset auto-open guard for the new thread
      prdAutoOpenedRef.current = false;
    }
  }, [thread?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-open PRD preview the first time the server signals prdReady
  useEffect(() => {
    if (prdReady && !prdAutoOpenedRef.current) {
      prdAutoOpenedRef.current = true;
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
    await sendMessage.mutateAsync({
      text: trimmedText || 'Please use the attached files as additional context.',
      model: selectedModel,
      attachments: messageAttachments,
    });
    if (messageAttachments.length > 0) clearAttachments();
  }, [isRunning, thread, sendMessage, selectedModel, clearAttachments]);

  const selectSkill = useCallback((skill: { name: string; path: string }) => {
    const msg = `Run skill: ${skill.name} (\`${skill.path}\`)`;
    setInput(msg);
    setSkillPickerOpen(false);
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInput(val);
    const isSlash = /^\//.test(val);
    setSkillPickerOpen(isSlash);
    if (isSlash) setSkillPickerIdx(0);
  };

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
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSend(input, attachments);
    }
  };

  const handleClose = async () => {
    if (thread) await closeThread.mutateAsync(thread.id).catch(() => {});
    onClose();
  };

  // ── Derived ──────────────────────────────────────────────────────────────────

  const statusDotClass =
    status === 'running' ? styles.statusDotRunning
    : status === 'error' ? styles.statusDotError
    : status === 'closed' ? styles.statusDotClosed
    : styles.statusDotIdle;

  const visibleMessages = messages.filter((m) => !(m.role === 'user' && m.text === 'Begin.'));

  const statusLabel =
    status === 'running' ? 'Agent is thinking…'
    : status === 'error' ? 'Error occurred'
    : status === 'closed' ? 'Thread closed'
    : visibleMessages.length === 0 ? 'Starting skill…'
    : 'Ready';

  if (!isOpen) return null;

  return (
    <div
      className={styles.panel}
      style={{ width: panelWidth }}
      role="complementary"
      aria-label="Agent chat panel"
    >
      {/* Resize handle */}
      <div className={styles.resizeHandle} onMouseDown={onResizeMouseDown} title="Drag to resize" />

      {/* Header */}
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <div className={styles.headerIcon}>AI</div>
          <div>
            <div className={styles.headerTitle}>
              {thread ? `${thread.kickoff.repo} · Agent Chat` : 'Agent Chat'}
            </div>
            {thread && (
              <div className={styles.headerMeta}>
                {thread.kickoff.skillPath
                  ? thread.kickoff.skillPath.split('/').pop()?.replace('SKILL.md', '') ?? 'skill'
                  : 'free chat'}
                {' · '}{thread.kickoff.project}
              </div>
            )}
          </div>
        </div>
        <div className={styles.headerActions}>
          {onSelectThread && (
            <button
              className={styles.iconBtn}
              onClick={() => setShowHistory((v) => !v)}
              title="Thread history"
            >
              {showHistory ? '← Back' : '⏱ History'}
            </button>
          )}
          <button
            className={styles.iconBtn}
            onClick={onNewChat}
            title="New chat"
            disabled={!canStartNewChat || isStartingNewChat || isRunning}
          >
            {isStartingNewChat ? 'Starting…' : '+ New'}
          </button>
          <button className={`${styles.iconBtn} ${styles.iconBtnDanger}`} onClick={handleClose} title="Close panel">✕</button>
        </div>
      </div>

      {/* Status bar */}
      {thread && (
        <div className={styles.statusBar}>
          <span className={`${styles.statusDot} ${statusDotClass}`} />
          <span className={styles.statusText}>{statusLabel}</span>
          <span className={styles.connBadge}>{isConnected ? '● live' : '○ reconnecting'}</span>
        </div>
      )}

      {showHistory && onSelectThread ? (
        <ThreadHistorySidebar
          activeThreadId={thread?.id ?? null}
          onSelectThread={(id) => { onSelectThread(id); setShowHistory(false); }}
          onDeleteThread={(id) => { if (id === thread?.id) onSelectThread(''); }}
          onClose={() => setShowHistory(false)}
          className={styles.historySidebarInPanel}
        />
      ) : !thread ? (
        <div className={styles.emptyPane}>
          <span className={styles.emptyIcon}>AI</span>
          <h3 className={styles.emptyTitle}>No active chat</h3>
          <p className={styles.emptyHint}>Start a free-form session in this project's default repo. Type <kbd className={styles.kbdHint}>/</kbd> in chat to invoke a skill.</p>
          {newChatError && <p className={styles.emptyError}>{newChatError}</p>}
          <button
            className={styles.btnPrimary}
            onClick={onNewChat}
            disabled={!canStartNewChat || isStartingNewChat}
          >
            {isStartingNewChat ? 'Starting…' : 'Start free chat'}
          </button>
        </div>
      ) : (
        <>
          <div className={styles.messages}>
            {visibleMessages.map((msg, idx) => {
              if (msg.role === 'tool') return <ToolCallBubble key={msg.id} msg={msg} />;
              if (msg.role === 'user') return <UserBubble key={msg.id} msg={msg} />;
              if (msg.role === 'system') {
                const isError = msg.text.startsWith('Error:');
                const lastUserText = isError
                  ? visibleMessages.slice(0, idx).reverse().find((m) => m.role === 'user')?.text ?? null
                  : null;
                if (isError && lastUserText) {
                  return (
                    <div key={msg.id} className={styles.systemErrorMsg}>
                      <span className={styles.systemErrorText}>{msg.text}</span>
                      <button
                        className={styles.retryBtn}
                        onClick={() => doSend(lastUserText)}
                        disabled={isRunning}
                        type="button"
                      >
                        ↺ Try again
                      </button>
                    </div>
                  );
                }
                return <div key={msg.id} className={styles.systemMsg}>{msg.text}</div>;
              }
              return <AgentMessage key={msg.id} msg={msg} onSend={doSend} isRunning={isRunning} />;
            })}

            {/* Loading spinner — shown while waiting for first tokens */}
            {isRunning && !streamingText && (
              <div className={styles.message}>
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
                <button className={styles.btnSecondary} onClick={() => setShowPrdPreview(true)}>Preview</button>
              </div>
            </div>
          )}

          <div className={styles.inputArea}>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className={styles.fileInput}
              onChange={handleAttachmentChange}
              disabled={isRunning || status === 'closed'}
            />
            {/* Skill picker popover — anchored above the input grid */}
            {skillPickerOpen && (
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
            )}

            <div className={styles.inputGrid}>
              {/* Model dropdown */}
              <select
                className={styles.modelSelect}
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                disabled={isRunning}
                title="Agent model"
                aria-label="Select model"
              >
                {modelsLoading || !availableModels?.length ? (
                  <option value="">Loading models…</option>
                ) : (
                  availableModels.map((m) => (
                    <option key={m.id} value={m.id}>{m.displayName}</option>
                  ))
                )}
              </select>

              <button
                className={styles.attachBtn}
                onClick={openFilePicker}
                type="button"
                aria-label="Attach files"
                title="Attach files for context"
                disabled={isRunning || status === 'closed'}
              >
                <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M7 10.5l5.2-5.2a3 3 0 114.2 4.2l-6.7 6.7a5 5 0 01-7.1-7.1l6.4-6.4" />
                </svg>
              </button>

              {/* Message textarea */}
              <textarea
                ref={textareaRef}
                className={styles.textarea}
                placeholder={isRunning ? 'Agent is thinking…' : 'Message agent · type / to invoke a skill…'}
                value={input}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                disabled={isRunning || status === 'closed'}
                rows={1}
              />

              {attachments.length > 0 && (
                <div className={styles.attachmentList}>
                  {attachments.map((attachment) => (
                    <span key={attachment.id} className={styles.attachmentChip}>
                      <span className={styles.attachmentName}>{attachment.name}</span>
                      <span className={styles.attachmentSize}>{formatAttachmentSize(attachment.size)}</span>
                      <button
                        type="button"
                        className={styles.attachmentRemove}
                        onClick={() => removeAttachment(attachment.id)}
                        aria-label={`Remove ${attachment.name}`}
                        disabled={isRunning || status === 'closed'}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}

              {attachmentError && (
                <div className={styles.attachmentError}>{attachmentError}</div>
              )}

              {/* Send / stop button */}
              {isRunning ? (
                <button className={styles.cancelBtn} onClick={() => cancelRun.mutate()} title="Stop">■ Stop</button>
              ) : (
                <button className={styles.sendBtn} onClick={() => doSend(input, attachments)} disabled={(!input.trim() && attachments.length === 0) || status === 'closed'}>Send ↑</button>
              )}

              {/* Hint row spans textarea column */}
              <div className={styles.inputHint}>
                <span className={styles.modelBadge}>{modelBadge(selectedModel)}</span>
                Enter to send · Shift+Enter for newline · <kbd className={styles.kbdHint}>/</kbd> invoke skill
              </div>
            </div>
          </div>

          {showPrdPreview && (
            <PRDPreviewDrawer
              threadId={thread.id}
              title={`${thread.kickoff.repo} PRD`}
              onClose={() => setShowPrdPreview(false)}
            />
          )}
        </>
      )}
    </div>
  );
};
