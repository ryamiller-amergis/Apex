import React, { useState, useRef, useEffect, useCallback, useMemo, KeyboardEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  useSkillRepos,
  useStartChat,
  useSkillList,
} from '../hooks/useChatThreads';
import { useProjectSkillConfig, useAvailableModels, useGlobalDefaultModel } from '../hooks/useProjectSkillConfig';
import { useAgentChatSession } from '../hooks/useAgentChatSession';
import { useChatAttachments } from '../hooks/useChatAttachments';
import { useProjectRepositoryReadiness } from '../hooks/useProjectRepositoryReadiness';
import { useGroundingResumeGate } from '../hooks/useGroundingResumeGate';
import { GroundingResumeCard } from './GroundingResumeCard';
import { parseAgentMessage } from '../utils/parseAgentMessage';
import type { ChoiceBlock } from '../utils/parseAgentMessage';
import { PRDPreviewDrawer } from './PRDPreviewDrawer';
import { ThreadHistorySidebar } from './ThreadHistorySidebar';
import { DEFAULT_MODEL_ID } from '../config/models';
import type { ChatMessage, ChatThread, SelectChatThreadOptions } from '../../shared/types/chat';
import type { QuickSkillPill, QuickMcpPill } from '../../shared/types/projectSettings';
import { useContextEstimate } from '../hooks/useContextEstimate';
import { useFocusChatMessage } from '../hooks/useFocusChatMessage';
import { BrandLogo } from './BrandLogo';
import { ReadAloudButton } from './ReadAloudButton';
import { FoundationSkillUpdateBanner } from './FoundationSkillUpdateBanner';
import { AgentComposer } from './agentChat';
import styles from './AgentHome.module.css';

interface AgentHomeProps {
  selectedProject: string;
  selectedSkillSettingsId?: string | null;
  isAdmin?: boolean;
}

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionEventLike {
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionErrorEventLike {
  error?: string;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  start: () => void;
  stop: () => void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

async function copyTextToClipboard(text: string): Promise<void> {
  const value = text.trim();
  if (!value) return;

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {
    // fall through to legacy copy
  }

  if (typeof document === 'undefined') return;
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

// ── ToolIcon ───────────────────────────────────────────────────────────────────

const ToolIcon: React.FC = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M13 2l-1 3H4L3 2" /><rect x="2" y="5" width="12" height="8" rx="1" /><path d="M6 9h4" />
  </svg>
);

interface MessageCopyButtonProps {
  text: string;
  label: string;
  inverted?: boolean;
}

const MessageCopyButton: React.FC<MessageCopyButtonProps> = ({ text, label, inverted = false }) => {
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);

  const handleCopy = useCallback(async () => {
    await copyTextToClipboard(text);
    setCopied(true);
    if (copiedTimerRef.current !== null) {
      window.clearTimeout(copiedTimerRef.current);
    }
    copiedTimerRef.current = window.setTimeout(() => {
      setCopied(false);
      copiedTimerRef.current = null;
    }, 1400);
  }, [text]);

  useEffect(() => () => {
    if (copiedTimerRef.current !== null) {
      window.clearTimeout(copiedTimerRef.current);
    }
  }, []);

  return (
    <button
      className={`${styles.messageCopyIconBtn} ${inverted ? styles.messageCopyIconBtnInverted : ''}`}
      onClick={() => { void handleCopy(); }}
      type="button"
      aria-label={label}
      title={copied ? 'Copied' : label}
      {...{ 'data-testid': 'agent-home-message-copy-btn' }}
    >
      {copied ? (
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4.5 10.5l3.5 3.5 7.5-8" />
        </svg>
      ) : (
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="7" y="7" width="9" height="9" rx="1.8" />
          <rect x="4" y="4" width="9" height="9" rx="1.8" />
        </svg>
      )}
    </button>
  );
};

// ── Interactive choice block ───────────────────────────────────────────────────

interface ChoiceBlockProps {
  block: ChoiceBlock;
  questionNumber: number;
  selection: string | null;
  freeform: string;
  locked: boolean;
  onSelect: (letter: string) => void;
  onFreeform: (text: string) => void;
  onSubmit: () => void;
}

// Matches agent-formatted question headers like "**Question 6:**" or "**Question 6.**"
// Returns [displayNumber, strippedQuestionText] when matched, null otherwise.
function parseQuestionHeader(text: string): [number, string] | null {
  const m = text.match(/^\*\*Question\s+(\d+)\*\*[:.]\s*/i);
  if (!m) return null;
  return [parseInt(m[1], 10), text.slice(m[0].length).trim()];
}

const ChoiceBlockUI: React.FC<ChoiceBlockProps> = ({
  block,
  questionNumber,
  selection,
  freeform,
  locked,
  onSelect,
  onFreeform,
  onSubmit,
}) => {
  // True when the agent already included an "other" option (e.g. "d. Other — I'll describe…")
  const hasBuiltInOther = block.options.some((o) => /^other/i.test(o.text));
  // True when the currently selected option is the agent's built-in "other" entry
  const selectedBuiltInOther = hasBuiltInOther && block.options.some((o) => o.letter === selection && /^other/i.test(o.text));
  const showFreeform = selection === 'other' || selectedBuiltInOther;

  // Use the number the agent embedded in the question text when available so
  // "Q6" matches "Question 6" regardless of which message the block appears in.
  const parsed = block.question ? parseQuestionHeader(block.question) : null;
  const displayNumber = parsed ? parsed[0] : questionNumber;
  const questionText = parsed ? parsed[1] : block.question;

  return (
    <div className={`${styles.choiceBlock} ${locked ? styles.choiceBlockLocked : ''}`}>
      {questionText && (
        <div className={styles.choiceQuestion}>
          <span className={styles.choiceQNum}>Q{displayNumber}</span>
          <div className={styles.markdownBody} style={{ flex: 1, padding: '0' }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{questionText}</ReactMarkdown>
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
              {...{ 'data-testid': `agent-home-choice-option-${opt.letter}` }}
            >
              <span className={styles.choiceOptionLetter}>{opt.letter.toUpperCase()}</span>
              <span className={styles.choiceOptionText}>{opt.text}</span>
            </button>
          );
        })}
        {!hasBuiltInOther && (
          <button
            className={`${styles.choiceOption} ${selection === 'other' ? styles.choiceOptionSelected : ''}`}
            onClick={() => !locked && onSelect('other')}
            disabled={locked}
            type="button"
            {...{ 'data-testid': 'agent-home-choice-option-other' }}
          >
            <span className={styles.choiceOptionLetter}>✎</span>
            <span className={styles.choiceOptionText}>Other / free-form</span>
          </button>
        )}
      </div>
      {showFreeform && !locked && (
        <textarea
          className={styles.choiceFreeform}
          placeholder="Type your answer here… (Enter to submit · Shift+Enter for new line)"
          value={freeform}
          onChange={(e) => onFreeform(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            }
          }}
          rows={2}
          {...{ 'data-testid': 'agent-home-choice-freeform' }}
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
  questionOffset: number;
}

interface QuestionState {
  selected: string | null;
  freeform: string;
}

const AgentMessage: React.FC<AgentMessageProps> = ({ msg, onSend, isRunning, questionOffset }) => {
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

  let questionCounter = questionOffset;

  return (
    <div className={styles.agentMsgRow}>
      <div className={styles.agentMsgHeader}>
        <span className={styles.agentAvatar}>AI</span>
        <span className={styles.agentLabel}>Agent</span>
        <span className={styles.agentMsgMeta}>{new Date(msg.ts).toLocaleTimeString()}</span>
      </div>
      <div className={styles.agentBubblePanel}>
        <div className={`${styles.bubbleActions} ${styles.agentBubbleActions}`}>
          <ReadAloudButton text={msg.text} {...{ 'data-testid': 'agent-home-read-aloud' }} />
          <MessageCopyButton text={msg.text} label="Copy agent response" {...{ 'data-testid': 'agent-home-copy-agent-message' }} />
        </div>
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
              onSubmit={handleSend}
              {...{ 'data-testid': `agent-home-choice-block-${part.id}` }}
            />
          );
        })}

        {choiceBlocks.length > 0 && !sent && (
          <button
            className={styles.choiceSendBtn}
            onClick={handleSend}
            disabled={!allAnswered || isRunning}
            type="button"
            {...{ 'data-testid': 'agent-home-choice-submit-btn' }}
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

// ── Message bubble dispatcher ─────────────────────────────────────────────────

function MessageBubble({
  msg,
  onSend,
  onRetry,
  isRunning,
  questionOffset,
  highlighted,
}: {
  msg: ChatMessage;
  onSend: (text: string) => void;
  onRetry?: () => void;
  isRunning: boolean;
  questionOffset: number;
  highlighted?: boolean;
}) {
  const highlightClass = highlighted ? styles.messageHighlighted : '';
  const highlightTestId = highlighted ? 'chat-message-highlighted' : undefined;

  if (msg.role === 'tool') {
    return (
      <div
        data-message-id={msg.id}
        {...(highlightTestId ? { 'data-testid': highlightTestId } : {})}
        className={`${styles.toolMsg} ${highlightClass}`.trim()}
      >
        <ToolIcon />
        <span>{msg.text}</span>
      </div>
    );
  }
  if (msg.role === 'system') {
    const isError = msg.text.startsWith('Error:');
    if (isError && onRetry) {
      return (
        <div
          data-message-id={msg.id}
          {...(highlightTestId ? { 'data-testid': highlightTestId } : {})}
          className={`${styles.systemErrorMsg} ${highlightClass}`.trim()}
        >
          <span className={styles.systemErrorText}>{msg.text}</span>
          <button className={styles.retryBtn} onClick={onRetry} disabled={isRunning} type="button" {...{ 'data-testid': 'agent-home-retry-btn' }}>
            ↺ Try again
          </button>
        </div>
      );
    }
    return (
      <div
        data-message-id={msg.id}
        {...(highlightTestId ? { 'data-testid': highlightTestId } : {})}
        className={`${styles.systemMsg} ${highlightClass}`.trim()}
      >
        {msg.text}
      </div>
    );
  }
  if (msg.role === 'user') {
    return (
      <div
        data-message-id={msg.id}
        {...(highlightTestId ? { 'data-testid': highlightTestId } : {})}
        className={`${styles.userRow} ${highlightClass}`.trim()}
      >
        <div className={styles.userBubble}>
          <div className={styles.bubbleActions}>
            <MessageCopyButton text={msg.text} label="Copy your message" inverted {...{ 'data-testid': 'agent-home-copy-user-message' }} />
          </div>
          <span>{msg.text}</span>
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
      </div>
    );
  }
  return (
    <div
      data-message-id={msg.id}
      {...(highlightTestId ? { 'data-testid': highlightTestId } : {})}
      className={highlightClass || undefined}
    >
      <AgentMessage msg={msg} onSend={onSend} isRunning={isRunning} questionOffset={questionOffset} />
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export const AgentHome: React.FC<AgentHomeProps> = ({ selectedProject, selectedSkillSettingsId, isAdmin = false }) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClient = useQueryClient();
  const [input, setInput] = useState('');
  // Prefer the URL param (direct links) then sessionStorage (survives SPA
  // navigation where App.tsx resets the URL to /home without query params).
  const sessionStorageKey = `agentHomeThreadId:${selectedProject}`;
  const [threadId, setThreadId] = useState<string | null>(
    () => searchParams.get('thread') ?? sessionStorage.getItem(sessionStorageKey) ?? null,
  );
  const [showHistory, setShowHistory] = useState(false);
  const [seedMessages, setSeedMessages] = useState<ChatMessage[]>([]);
  const [focusMessageId, setFocusMessageId] = useState<string | undefined>();
  const [model, setModel] = useState(DEFAULT_MODEL_ID);
  const { data: globalDefaultModel } = useGlobalDefaultModel();
  const [isSending, setIsSending] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [speechError, setSpeechError] = useState<string | null>(null);
  const [isSpeechSupported, setIsSpeechSupported] = useState(false);
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  const [skillPickerIdx, setSkillPickerIdx] = useState(0);
  const [selectedSkillPath, setSelectedSkillPath] = useState<string | null>(null);
  const [selectedSkillName, setSelectedSkillName] = useState<string | null>(null);
  const [selectedQuickSkill, setSelectedQuickSkill] = useState<QuickSkillPill | null>(null);
  const [selectedMcpPill, setSelectedMcpPill] = useState<QuickMcpPill | null>(null);

  // PRD state
  const [showPrdPreview, setShowPrdPreview] = useState(false);
  const [initialPrdReady, setInitialPrdReady] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const skillPickerRef = useRef<HTMLDivElement>(null);
  const prdAutoOpenedRef = useRef(false);
  const initialThreadIdRef = useRef(threadId); // captures URL param value at first render
  const speechRecognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const speechInputBaseRef = useRef('');

  const {
    attachments,
    attachmentError,
    addFiles,
    removeAttachment,
    clearAttachments,
  } = useChatAttachments();

  const { data: availableModels, isLoading: modelsLoading } = useAvailableModels();

  const { data: skillConfig } = useProjectSkillConfig(selectedProject || null, selectedSkillSettingsId);
  const { data: repos = [] } = useSkillRepos(selectedProject || null, skillConfig?.skillProvider);
  const repoReadiness = useProjectRepositoryReadiness(skillConfig?.id, selectedProject || null);

  // Prefer admin-configured repo/branch; fall back to heuristic (match project name, then first repo)
  const defaultRepo = skillConfig
    ? (repos.find((r) => r.name === skillConfig.skillRepo) ?? { name: skillConfig.skillRepo, defaultBranch: skillConfig.skillBranch, id: skillConfig.skillRepo })
    : (repos.find((r) => r.name.toLowerCase() === selectedProject.toLowerCase()) ?? repos[0]);
  const defaultBranch = skillConfig?.skillBranch ?? defaultRepo?.defaultBranch ?? 'main';
  const resolvedRepoName = skillConfig?.skillRepo ?? defaultRepo?.name ?? null;

  const quickSkillPills = skillConfig?.quickSkillPills ?? [];
  const quickMcpPills = skillConfig?.quickMcpPills ?? [];

  const { data: skills = [] } = useSkillList(
    selectedProject || null,
    resolvedRepoName,
    defaultBranch,
    skillConfig?.skillProvider,
  );

  const startChat = useStartChat();
  const session = useAgentChatSession(threadId, {
    initialMessages: seedMessages,
    initialPrdReady,
    visibleMessageFilter: (m) =>
      !(m.role === 'user' && m.text === 'Begin.')
      && m.toolName !== '_reasoning'
      && m.toolName !== '_thinking',
    beforeSend: () => {
      if (!repoReadiness.isReady) {
        throw new Error(repoReadiness.message ?? 'Repository is not ready');
      }
    },
  });
  const { streamingText, prdReady, isRunning, visibleMessages, progressLabel, showTypingIndicator } = session;
  const resumeGate = useGroundingResumeGate(
    'chat',
    threadId,
    selectedProject || null,
    isRunning,
  );

  const visibleMessageIds = visibleMessages.map((m) => m.id);
  const highlightedMessageId = useFocusChatMessage(focusMessageId, visibleMessageIds);

  const hasPrd = prdReady;

  const draftAttachmentChars = attachments.reduce((sum, a) => sum + a.content.length, 0);
  const {
    estimatedTokens,
    contextLimit: contextTokenLimit,
    usagePercent: contextPercent,
    label: contextLabel,
  } = useContextEstimate(visibleMessages, input, streamingText, model, draftAttachmentChars);

  const slashQuery = useMemo(() => {
    const m = input.match(/^\/(.*)$/s);
    return m ? m[1].toLowerCase() : null;
  }, [input]);

  const filteredSkills = useMemo(() => {
    if (slashQuery === null) return [];
    if (!slashQuery) return skills;
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(slashQuery) ||
        s.path.toLowerCase().includes(slashQuery),
    );
  }, [slashQuery, skills]);

  // Update model to global default once loaded, if user hasn't changed it yet
  useEffect(() => {
    if (globalDefaultModel?.value && model === DEFAULT_MODEL_ID) {
      setModel(globalDefaultModel.value);
    }
  }, [globalDefaultModel?.value]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear thread when the project changes and the loaded thread belongs to a different project
  const prevProjectRef = useRef(selectedProject);
  useEffect(() => {
    if (prevProjectRef.current !== selectedProject) {
      prevProjectRef.current = selectedProject;
      setThreadId(sessionStorage.getItem(sessionStorageKey) ?? null);
      setSeedMessages([]);
    }
  }, [selectedProject, sessionStorageKey]);

  // Scroll messages to bottom — skip while jump-to-match is pending/active so
  // we do not yank the viewport away from the matched message.
  const skipScrollToEndRef = useRef(false);
  skipScrollToEndRef.current = Boolean(focusMessageId || highlightedMessageId);
  useEffect(() => {
    if (skipScrollToEndRef.current) return;
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [visibleMessages.length, streamingText]);

  // Auto-grow textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  // Scroll highlighted skill into view on keyboard nav
  useEffect(() => {
    if (!skillPickerOpen || !skillPickerRef.current) return;
    const active = skillPickerRef.current.querySelector<HTMLElement>('[data-picker-active="true"]');
    active?.scrollIntoView({ block: 'nearest' });
  }, [skillPickerIdx, skillPickerOpen]);

  // Auto-open PRD preview the first time the server signals prdReady
  useEffect(() => {
    if (prdReady && !prdAutoOpenedRef.current) {
      prdAutoOpenedRef.current = true;
      setShowPrdPreview(true);
    }
  }, [prdReady]);

  // Browser speech-to-text setup
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const speechWindow = window as Window & {
      SpeechRecognition?: SpeechRecognitionCtor;
      webkitSpeechRecognition?: SpeechRecognitionCtor;
    };
    const SpeechRecognitionClass = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
    if (!SpeechRecognitionClass) {
      setIsSpeechSupported(false);
      return;
    }

    setIsSpeechSupported(true);
    const recognition = new SpeechRecognitionClass();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';

    recognition.onstart = () => {
      setIsListening(true);
      setSpeechError(null);
    };

    recognition.onend = () => {
      setIsListening(false);
    };

    recognition.onerror = (event) => {
      const code = event.error ?? 'unknown';
      if (code === 'not-allowed') {
        setSpeechError('Microphone access is blocked. Allow microphone permissions and try again.');
        return;
      }
      if (code === 'no-speech') {
        setSpeechError('No speech detected. Try again and speak closer to your microphone.');
        return;
      }
      setSpeechError(`Speech recognition error: ${code}`);
    };

    recognition.onresult = (event) => {
      let finalTranscript = '';
      let interimTranscript = '';

      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0]?.transcript?.trim();
        if (!text) continue;
        if (result.isFinal) {
          finalTranscript += `${text} `;
        } else {
          interimTranscript += `${text} `;
        }
      }

      const base = speechInputBaseRef.current.trim();
      const nextText = [base, finalTranscript.trim(), interimTranscript.trim()].filter(Boolean).join(' ');
      setInput(nextText);
    };

    speechRecognitionRef.current = recognition;

    return () => {
      recognition.onstart = null;
      recognition.onend = null;
      recognition.onerror = null;
      recognition.onresult = null;
      recognition.stop();
      speechRecognitionRef.current = null;
    };
  }, []);

  // Keep the URL and sessionStorage in sync with the active thread.
  // URL gives shareable/bookmarkable links; sessionStorage survives the
  // navigate('/home') call in App.tsx which strips query params.
  useEffect(() => {
    setSearchParams(threadId ? { thread: threadId } : {}, { replace: true });
    if (threadId) {
      sessionStorage.setItem(sessionStorageKey, threadId);
    } else {
      sessionStorage.removeItem(sessionStorageKey);
    }
  }, [threadId, setSearchParams, sessionStorageKey]);

  // On first mount, if a ?thread=<id> param was present, reload that thread's
  // message history so the UI is immediately usable without re-fetching.
  useEffect(() => {
    const id = initialThreadIdRef.current;
    if (!id) return;
    fetch(`/api/chat/threads/${id}`, { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((thread: ChatThread | null) => {
        if (!thread) {
          setThreadId(null);
          return;
        }
        setSeedMessages(thread.messages ?? []);
        setInitialPrdReady(thread.prdReady ?? false);
      })
      .catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- intentional mount-only

  // ── Callbacks ────────────────────────────────────────────────────────────────

  const selectSkill = useCallback((skill: { name: string; path: string }) => {
    setInput(`/${skill.name}`);
    setSelectedSkillPath(skill.path);
    setSelectedSkillName(skill.name);
    setSkillPickerOpen(false);
  }, []);

  const handleAttachmentChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    await addFiles(e.currentTarget.files);
    e.currentTarget.value = '';
  }, [addFiles]);

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const toggleSpeechRecognition = useCallback(() => {
    const recognition = speechRecognitionRef.current;
    if (!recognition) return;
    if (isListening) {
      recognition.stop();
      return;
    }
    speechInputBaseRef.current = input;
    setSpeechError(null);
    try {
      recognition.start();
    } catch {
      setSpeechError('Could not start voice transcription. Please try again.');
    }
  }, [input, isListening]);

  // Used by AgentMessage choice block submissions (thread already exists)
  const doSend = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isRunning || isSending || !threadId || resumeGate.composerBlocked) return;
    await session.send(trimmed, { model });
  }, [threadId, isRunning, isSending, model, resumeGate.composerBlocked, session]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || isRunning || isSending) return;
    if (!threadId && !resolvedRepoName) return;
    if (!repoReadiness.isReady) return;
    if (resumeGate.composerBlocked) return;

    if (isListening) {
      speechRecognitionRef.current?.stop();
    }

    setInput('');
    setSkillPickerOpen(false);
    setIsSending(true);

    try {
      let activeThreadId = threadId;
      const wasNewThread = !activeThreadId;

      if (!activeThreadId) {
        // Starting a new thread: bake the skill path into the kickoff so the
        // server-side system prompt loads it automatically via get_skill.
        const skillSlug = selectedSkillName ? `/${selectedSkillName}` : null;
        const freeformContext = selectedSkillPath && skillSlug
          ? (text === skillSlug ? undefined : text.startsWith(`${skillSlug} `) ? text.slice(skillSlug.length + 1).trim() || undefined : text)
          : undefined;
        // Only the exact "/skill" with no follow-up message relies on server "Begin." kickoff.
        const skillSlugOnlyKickoff =
          Boolean(
            selectedSkillPath &&
              selectedSkillName &&
              text === `/${selectedSkillName}` &&
              attachments.length === 0,
          );
        const effectiveSkillPath = selectedSkillPath ?? selectedQuickSkill?.skillPath ?? undefined;
        const result = await startChat.mutateAsync({
          kickoff: {
            project: selectedProject,
            repo: resolvedRepoName!,
            branch: defaultBranch,
            skillProvider: skillConfig?.skillProvider ?? undefined,
            skillPath: effectiveSkillPath,
            freeformContext,
            model,
            skillSettingsId: skillConfig?.id ?? undefined,
            ...(selectedMcpPill ? { mcpPill: selectedMcpPill } : {}),
            pillLabel: selectedQuickSkill?.label ?? selectedMcpPill?.label ?? undefined,
            pillDescription: (selectedQuickSkill?.description ?? selectedMcpPill?.description) ?? undefined,
            pillBypassScopePolicy: selectedQuickSkill?.bypassScopePolicy ?? undefined,
          },
          skipAutoKickoff: !skillSlugOnlyKickoff,
        });
        activeThreadId = result.threadId;
        setThreadId(activeThreadId);
        setSelectedQuickSkill(null);
        setSelectedMcpPill(null);
      }

      // For new threads the skill is baked into the kickoff system prompt, so a bare
      // /skill send needs no extra user message. Attachments still need a real first
      // message so they are persisted and shown before the agent response.
      if (
        wasNewThread &&
        selectedSkillPath &&
        selectedSkillName &&
        text === `/${selectedSkillName}` &&
        attachments.length === 0
      ) {
        setSelectedSkillPath(null);
        setSelectedSkillName(null);
        clearAttachments();
        return;
      }

      // For existing threads, translate a skill selection into the explicit "Run skill"
      // format that the agent's free-chat system prompt is documented to handle.
      // This ensures mid-conversation skill switches (e.g. /to-prd after a /grill-with-docs
      // interview) reliably trigger get_skill via MCP instead of being treated as plain text.
      let messageText = text || 'Please use the attached files as additional context.';
      if (
        wasNewThread &&
        selectedSkillPath &&
        selectedSkillName &&
        text === `/${selectedSkillName}` &&
        attachments.length > 0
      ) {
        messageText = 'Please use the attached files as additional context.';
      }
      if (!wasNewThread && selectedSkillPath && selectedSkillName) {
        const isSkillSlug = text === `/${selectedSkillName}` || text === selectedSkillName;
        messageText = isSkillSlug
          ? `Run skill: ${selectedSkillName} (\`${selectedSkillPath}\`)`
          : `Run skill: ${selectedSkillName} (\`${selectedSkillPath}\`)\n\n${text}`;
        setSelectedSkillPath(null);
        setSelectedSkillName(null);
      }

      const response = await fetch(`/api/chat/threads/${activeThreadId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          text: messageText,
          model,
          attachments,
        }),
      });
      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        throw new Error((errorBody as { error?: string }).error ?? `HTTP ${response.status}`);
      }
      void queryClient.invalidateQueries({ queryKey: ['chat-thread-list'] });
      clearAttachments();
    } finally {
      setIsSending(false);
    }
  }, [input, attachments, isRunning, isSending, threadId, resolvedRepoName, startChat, selectedProject, defaultBranch, selectedSkillPath, selectedSkillName, selectedQuickSkill, selectedMcpPill, model, clearAttachments, isListening, queryClient, skillConfig?.id, skillConfig?.skillProvider, repoReadiness.isReady, resumeGate.composerBlocked]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
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
  }, [skillPickerOpen, filteredSkills, skillPickerIdx, selectSkill]);

  const handleStop = useCallback(async () => {
    await session.cancel();
  }, [session]);

  const handleNewSession = useCallback(() => {
    if (isRunning || isSending) return;
    if (isListening) {
      speechRecognitionRef.current?.stop();
    }
    setSeedMessages([]);
    setThreadId(null);
    setFocusMessageId(undefined);
    setInput('');
    setSpeechError(null);
    setSkillPickerOpen(false);
    setSkillPickerIdx(0);
    setSelectedSkillPath(null);
    setSelectedSkillName(null);
    setSelectedQuickSkill(null);
    setSelectedMcpPill(null);
    clearAttachments();
    setShowPrdPreview(false);
    setInitialPrdReady(false);
    prdAutoOpenedRef.current = false;
  }, [isRunning, isSending, clearAttachments, isListening]);

  const handleSelectThread = useCallback(async (id: string, options?: SelectChatThreadOptions) => {
    try {
      const resp = await fetch(`/api/chat/threads/${id}`, { credentials: 'include' });
      if (!resp.ok) return;
      const thread: ChatThread = await resp.json();
      setSeedMessages(thread.messages ?? []);
      setInitialPrdReady(thread.prdReady ?? false);
      setThreadId(id);
      setFocusMessageId(options?.focusMessageId);
      setShowHistory(false);
      setShowPrdPreview(false);
    } catch {
      // non-fatal
    }
  }, []);

  const isCompose = !threadId;
  const hasPills = quickSkillPills.length > 0 || quickMcpPills.length > 0;
  const needsSkillSelection = isCompose && hasPills && !selectedQuickSkill && !selectedMcpPill;
  const canSend = (input.trim().length > 0 || attachments.length > 0) && !isRunning && !isSending && !needsSkillSelection && (!!threadId || !!resolvedRepoName) && repoReadiness.isReady && !resumeGate.composerBlocked;

  // ── Shared input area ────────────────────────────────────────────────────────

  const inputArea = (
    <div className={styles.inputWrapper}>
      {resumeGate.showCard && resumeGate.status ? (
        <GroundingResumeCard
          status={resumeGate.status}
          isPending={resumeGate.isUpdating}
          error={resumeGate.error}
          onContinue={resumeGate.continueOnPin}
          onUpdateToLatest={() => void resumeGate.updateToLatest()}
          {...{ 'data-testid': 'grounding-resume-card' }}
        />
      ) : null}
      <AgentComposer
        className={styles.composerEmbed}
      value={input}
      onChange={(val) => {
        setInput(val);
        const skillStillActive = !!(selectedSkillPath && selectedSkillName && val.startsWith(`/${selectedSkillName}`));
        if (selectedSkillPath && !skillStillActive) {
          setSelectedSkillPath(null);
          setSelectedSkillName(null);
        }
        const isSlash = /^\//.test(val);
        setSkillPickerOpen(isSlash && !skillStillActive);
        if (isSlash && !skillStillActive) setSkillPickerIdx(0);
      }}
      onSend={() => void handleSend()}
      onCancel={() => void handleStop()}
      disabled={needsSkillSelection || !repoReadiness.isReady || resumeGate.composerBlocked}
      isRunning={isRunning}
      isSending={isSending}
      isBusy={isSending || needsSkillSelection || !repoReadiness.isReady || resumeGate.composerBlocked}
      shellDisabled={needsSkillSelection || !repoReadiness.isReady || resumeGate.composerBlocked}
      canSend={canSend}
      allowEmptySend
      autoFocus={isCompose && !needsSkillSelection && repoReadiness.isReady}
      rows={isCompose ? 3 : 1}
      placeholder={
        !repoReadiness.isReady
          ? (repoReadiness.message ?? 'Repository not ready')
          : isCompose
            ? (needsSkillSelection ? 'Select an option above to get started' : 'Let Apex know what you need…')
            : isRunning
              ? 'Type your follow-up…'
              : 'Continue the conversation…'
      }
      testIdPrefix="agent-home"
      testIds={{
        input: 'agent-home-composer-input',
        send: 'agent-home-send-btn',
        stop: 'agent-home-stop-btn',
        attach: 'agent-home-attach-btn',
        microphone: 'agent-home-mic-btn',
        model: 'agent-home-model-select',
      }}
      {...{ 'data-testid': 'agent-home-composer' }}
      textareaRef={textareaRef}
      attachments={attachments}
      attachmentError={attachmentError ?? (!repoReadiness.isReady ? repoReadiness.message : null)}
      onRemoveAttachment={removeAttachment}
      onAttachClick={openFilePicker}
      speech={{
        isListening,
        isSpeechSupported,
        speechError,
        onToggle: toggleSpeechRecognition,
      }}
      model={isCompose ? undefined : model}
      models={isCompose ? undefined : availableModels}
      modelsLoading={modelsLoading}
      onModelChange={isCompose ? undefined : setModel}
      onKeyDown={handleKeyDown}
      fileInput={(
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className={styles.fileInput}
          onChange={handleAttachmentChange}
          disabled={isRunning || isSending || needsSkillSelection}
          {...{ 'data-testid': 'agent-home-file-input' }}
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
              {...{ 'data-testid': `agent-home-skill-picker-${skill.id}` }}
            >
              <span className={styles.skillPickerName}>{skill.name}</span>
              {skill.description && (
                <span className={styles.skillPickerDesc}>{skill.description}</span>
              )}
            </button>
          ))}
        </div>
      ) : undefined}
    />
    </div>
  );

  return (
    <div className={styles.page}>
      {showHistory && (
        <ThreadHistorySidebar
          activeThreadId={threadId}
          onSelectThread={handleSelectThread}
          onDeleteThread={(id) => { if (id === threadId) { setSeedMessages([]); setThreadId(null); } }}
          onClose={() => setShowHistory(false)}
          project={selectedProject}
        />
      )}
      {/* Column wrapper so the banner stacks above the compose/chat area */}
      <div className={styles.mainCol}>
        {isAdmin && resolvedRepoName && (
          <FoundationSkillUpdateBanner
            project={selectedProject || null}
            repo={resolvedRepoName}
            provider={skillConfig?.skillProvider ?? 'ado'}
            branch={defaultBranch}
            {...{ 'data-testid': 'agent-home-foundation-skill-banner' }}
          />
        )}
        {isCompose ? (
          <div className={styles.compose}>
            <button
              className={styles.historyToggleBtn}
            onClick={() => setShowHistory((v) => !v)}
            type="button"
            {...{ 'data-testid': 'agent-home-compose-history-toggle' }}
          >
            {showHistory ? '← Hide History' : '⏱ History'}
          </button>
          <div className={styles.composeInner}>
            <div className={styles.composeLogo}>
              <BrandLogo />
            </div>

            <h1 className={styles.composeHeading}>What would you like to work on?</h1>

            <div className={styles.contextPills}>
              {quickSkillPills.map((pill) => (
                <button
                  key={pill.skillPath}
                  type="button"
                  className={`${styles.pill} ${styles.pillClickable} ${
                    selectedQuickSkill?.skillPath === pill.skillPath ? styles.pillSelected : ''
                  }`}
                  onClick={() => {
                    const isDeselect = selectedQuickSkill?.skillPath === pill.skillPath;
                    setSelectedQuickSkill(isDeselect ? null : pill);
                    setSelectedMcpPill(null);
                    setModel(
                      isDeselect
                        ? (globalDefaultModel?.value ?? DEFAULT_MODEL_ID)
                        : (pill.model ?? globalDefaultModel?.value ?? DEFAULT_MODEL_ID),
                    );
                  }}
                  {...{ 'data-testid': `agent-home-skill-pill-${pill.skillPath}` }}
                >
                  {pill.label}
                </button>
              ))}
              {quickMcpPills.map((pill) => (
                <button
                  key={pill.mcpServerName}
                  type="button"
                  className={`${styles.pill} ${styles.pillClickable} ${styles.pillMcp} ${
                    selectedMcpPill?.mcpServerName === pill.mcpServerName ? styles.pillSelected : ''
                  }`}
                  onClick={() => {
                    const isDeselect = selectedMcpPill?.mcpServerName === pill.mcpServerName;
                    setSelectedMcpPill(isDeselect ? null : pill);
                    setSelectedQuickSkill(null);
                    setModel(
                      isDeselect
                        ? (globalDefaultModel?.value ?? DEFAULT_MODEL_ID)
                        : (pill.model ?? globalDefaultModel?.value ?? DEFAULT_MODEL_ID),
                    );
                  }}
                  {...{ 'data-testid': `agent-home-mcp-pill-${pill.mcpServerName}` }}
                >
                  {pill.label}
                </button>
              ))}
            </div>

            {selectedQuickSkill && (
              <div className={styles.pillDescription}>
                {selectedQuickSkill.description
                  || skills.find((s) => s.path === selectedQuickSkill.skillPath)?.description
                  || `Skill: ${selectedQuickSkill.label}`}
              </div>
            )}
            {selectedMcpPill && (
              <div className={styles.pillDescription}>
                {selectedMcpPill.description || `MCP: ${selectedMcpPill.label}`}
              </div>
            )}

            {inputArea}

            <p className={styles.hint}>Enter to send · Shift+Enter for new line</p>
          </div>
        </div>
      ) : (
        <div className={styles.chat}>
          <div className={styles.chatHeader}>
            <div>
              <div className={styles.chatTitle}>Agent session</div>
              <div className={styles.chatSubtitle}>{selectedProject} · {resolvedRepoName ?? 'workspace'}</div>
            </div>
            <div className={styles.chatHeaderActions}>
              <button
                className={styles.historyToggleBtn}
                onClick={() => setShowHistory((v) => !v)}
                type="button"
                {...{ 'data-testid': 'agent-home-chat-history-toggle' }}
              >
                {showHistory ? '← Hide' : '⏱ History'}
              </button>
              <div
                className={styles.contextMeter}
                style={{ '--context-percent': `${contextPercent}%` } as React.CSSProperties}
                title={`Estimated context usage: ${estimatedTokens.toLocaleString()} of ${contextTokenLimit.toLocaleString()} tokens`}
              >
                <div className={styles.contextMeterRing}>
                  <span>{contextPercent}%</span>
                </div>
                <div className={styles.contextMeterText}>
                  <span>Context</span>
                  <strong>{contextLabel} tokens</strong>
                </div>
              </div>
              <button
                className={styles.newSessionBtn}
                onClick={handleNewSession}
                disabled={isRunning || isSending}
                type="button"
                {...{ 'data-testid': 'agent-home-new-session-btn' }}
              >
                + New chat
              </button>
            </div>
          </div>

          <div className={styles.messages}>
            {(() => {
              let qOffset = 0;
              return visibleMessages.map((msg, idx) => {
                const offset = qOffset;
                if (msg.role === 'agent') {
                  qOffset += parseAgentMessage(msg.text).filter((p) => p.type === 'choices').length;
                }
                const lastUserText = msg.role === 'system' && msg.text.startsWith('Error:')
                  ? visibleMessages.slice(0, idx).reverse().find((m) => m.role === 'user')?.text ?? null
                  : null;
                return (
                  <MessageBubble
                    key={msg.id}
                    msg={msg}
                    onSend={doSend}
                    onRetry={lastUserText ? () => doSend(lastUserText) : undefined}
                    isRunning={isRunning}
                    questionOffset={offset}
                    highlighted={highlightedMessageId === msg.id}
                  />
                );
              });
            })()}

            {showTypingIndicator && (
              <div
                className={styles.agentRow}
                role="status"
                aria-live="polite"
                aria-label={progressLabel ?? 'Agent is processing'}
                {...{ 'data-testid': 'agent-home-typing' }}
              >
                <div className={styles.agentAvatar}>AI</div>
                <div className={`${styles.agentBubble} ${styles.typing}`}>
                  <span /><span /><span />
                  {progressLabel && (
                    <p
                      className={styles.progressLabel}
                      {...{ 'data-testid': 'agent-home-progress-label' }}
                    >
                      {progressLabel}
                    </p>
                  )}
                </div>
              </div>
            )}

            {streamingText && (
              <div className={styles.agentRow}>
                <div className={styles.agentAvatar}>AI</div>
                <div className={`${styles.agentBubble} ${styles.agentBubbleMd}`}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingText}</ReactMarkdown>
                  <span className={styles.cursor} />
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* PRD ready banner */}
          {hasPrd && (
            <div className={styles.prdBanner}>
              <span className={styles.prdBannerText}>PRD is ready for review</span>
              <div className={styles.prdActions}>
                <button className={styles.btnSecondary} onClick={() => setShowPrdPreview(true)} type="button" {...{ 'data-testid': 'agent-home-prd-preview-btn' }}>
                  Preview
                </button>
              </div>
            </div>
          )}

          <div className={styles.chatInputBar}>
            {inputArea}
          </div>
        </div>
      )}

      {showPrdPreview && threadId && (
        <PRDPreviewDrawer
          threadId={threadId}
          onClose={() => setShowPrdPreview(false)}
          {...{ 'data-testid': 'agent-home-prd-preview-drawer' }}
        />
      )}
      </div>{/* end mainCol */}
    </div>
  );
};
