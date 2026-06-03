import React, { useState, useRef, useEffect, useCallback, useMemo, KeyboardEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  useSkillRepos,
  useStartChat,
  useSkillList,
} from '../hooks/useChatThreads';
import { useProjectSkillConfig, useAvailableModels, useGlobalDefaultModel } from '../hooks/useProjectSkillConfig';
import { useChatStream } from '../hooks/useChatStream';
import { formatAttachmentSize, useChatAttachments } from '../hooks/useChatAttachments';
import { parseAgentMessage } from '../utils/parseAgentMessage';
import type { ChoiceBlock } from '../utils/parseAgentMessage';
import { PRDPreviewDrawer } from './PRDPreviewDrawer';
import { ThreadHistorySidebar } from './ThreadHistorySidebar';
import { DEFAULT_MODEL_ID } from '../config/models';
import type { ChatMessage, ChatThread } from '../../shared/types/chat';
import type { QuickSkillPill, QuickMcpPill } from '../../shared/types/projectSettings';
import { useContextEstimate } from '../hooks/useContextEstimate';
import { BrandLogo } from './BrandLogo';
import styles from './AgentHome.module.css';

interface AgentHomeProps {
  selectedProject: string;
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
          <MessageCopyButton text={msg.text} label="Copy agent response" />
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

// ── Message bubble dispatcher ─────────────────────────────────────────────────

function MessageBubble({
  msg,
  onSend,
  onRetry,
  isRunning,
  questionOffset,
}: {
  msg: ChatMessage;
  onSend: (text: string) => void;
  onRetry?: () => void;
  isRunning: boolean;
  questionOffset: number;
}) {
  if (msg.role === 'tool') {
    return (
      <div className={styles.toolMsg}>
        <ToolIcon />
        <span>{msg.text}</span>
      </div>
    );
  }
  if (msg.role === 'system') {
    const isError = msg.text.startsWith('Error:');
    if (isError && onRetry) {
      return (
        <div className={styles.systemErrorMsg}>
          <span className={styles.systemErrorText}>{msg.text}</span>
          <button className={styles.retryBtn} onClick={onRetry} disabled={isRunning} type="button">
            ↺ Try again
          </button>
        </div>
      );
    }
    return <div className={styles.systemMsg}>{msg.text}</div>;
  }
  if (msg.role === 'user') {
    return (
      <div className={styles.userRow}>
        <div className={styles.userBubble}>
          <div className={styles.bubbleActions}>
            <MessageCopyButton text={msg.text} label="Copy your message" inverted />
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
  return <AgentMessage msg={msg} onSend={onSend} isRunning={isRunning} questionOffset={questionOffset} />;
}

// ── Main component ─────────────────────────────────────────────────────────────

export const AgentHome: React.FC<AgentHomeProps> = ({ selectedProject }) => {
  const [searchParams, setSearchParams] = useSearchParams();
  const [input, setInput] = useState('');
  // Prefer the URL param (direct links) then sessionStorage (survives SPA
  // navigation where App.tsx resets the URL to /home without query params).
  const [threadId, setThreadId] = useState<string | null>(
    () => searchParams.get('thread') ?? sessionStorage.getItem('agentHomeThreadId') ?? null,
  );
  const [showHistory, setShowHistory] = useState(false);
  const [seedMessages, setSeedMessages] = useState<ChatMessage[]>([]);
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

  const { data: repos = [] } = useSkillRepos(selectedProject || null);
  const { data: skillConfig } = useProjectSkillConfig(selectedProject || null);

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
  );

  const startChat = useStartChat();
  const { messages, streamingText, status, prdReady } = useChatStream(threadId, {
    initialMessages: seedMessages,
    initialPrdReady,
  });
  const isRunning = status === 'running';

  const visibleMessages = messages.filter((m) => !(m.role === 'user' && m.text === 'Begin.'));

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

  // Scroll messages to bottom
  useEffect(() => {
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
      sessionStorage.setItem('agentHomeThreadId', threadId);
    } else {
      sessionStorage.removeItem('agentHomeThreadId');
    }
  }, [threadId, setSearchParams]);

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

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInput(val);
    const skillStillActive = !!(selectedSkillPath && selectedSkillName && val.startsWith(`/${selectedSkillName}`));
    if (selectedSkillPath && !skillStillActive) {
      setSelectedSkillPath(null);
      setSelectedSkillName(null);
    }
    const isSlash = /^\//.test(val);
    setSkillPickerOpen(isSlash && !skillStillActive);
    if (isSlash && !skillStillActive) setSkillPickerIdx(0);
  }, [selectedSkillPath, selectedSkillName]);

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
    if (!trimmed || isRunning || isSending || !threadId) return;
    setIsSending(true);
    try {
      const resp = await fetch(`/api/chat/threads/${threadId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ text: trimmed, model }),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${resp.status}`);
      }
    } finally {
      setIsSending(false);
    }
  }, [threadId, isRunning, isSending, model]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || isRunning || isSending) return;
    if (!threadId && !resolvedRepoName) return;

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
            skillPath: effectiveSkillPath,
            freeformContext,
            model,
            ...(selectedMcpPill ? { mcpPill: selectedMcpPill } : {}),
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
      clearAttachments();
    } finally {
      setIsSending(false);
    }
  }, [input, attachments, isRunning, isSending, threadId, resolvedRepoName, startChat, selectedProject, defaultBranch, selectedSkillPath, selectedSkillName, selectedQuickSkill, selectedMcpPill, model, clearAttachments, isListening]);

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
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }, [skillPickerOpen, filteredSkills, skillPickerIdx, selectSkill, handleSend]);

  const handleStop = useCallback(async () => {
    if (!threadId) return;
    await fetch(`/api/chat/threads/${threadId}/cancel`, {
      method: 'POST',
      credentials: 'include',
    });
  }, [threadId]);

  const handleNewSession = useCallback(() => {
    if (isRunning || isSending) return;
    if (isListening) {
      speechRecognitionRef.current?.stop();
    }
    setSeedMessages([]);
    setThreadId(null);
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

  const handleSelectThread = useCallback(async (id: string) => {
    try {
      const resp = await fetch(`/api/chat/threads/${id}`, { credentials: 'include' });
      if (!resp.ok) return;
      const thread: ChatThread = await resp.json();
      setSeedMessages(thread.messages ?? []);
      setInitialPrdReady(thread.prdReady ?? false);
      setThreadId(id);
      setShowHistory(false);
      setShowPrdPreview(false);
    } catch {
      // non-fatal
    }
  }, []);

  const isCompose = !threadId;
  const hasPills = quickSkillPills.length > 0 || quickMcpPills.length > 0;
  const needsSkillSelection = isCompose && hasPills && !selectedQuickSkill && !selectedMcpPill;
  const canSend = (input.trim().length > 0 || attachments.length > 0) && !isRunning && !isSending && !needsSkillSelection && (!!threadId || !!resolvedRepoName);

  // ── Shared input area ────────────────────────────────────────────────────────

  const inputArea = (
    <div className={styles.inputWrapper}>
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

      <div className={`${styles.inputBox} ${needsSkillSelection ? styles.inputBoxDisabled : ''}`}>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className={styles.fileInput}
          onChange={handleAttachmentChange}
          disabled={isRunning || isSending || needsSkillSelection}
        />
        <textarea
          ref={textareaRef}
          className={styles.textarea}
          placeholder={
            isCompose
              ? (needsSkillSelection ? 'Select an option above to get started' : 'Let Apex know what you need…')
              : isRunning
                ? 'Agent is thinking…'
                : 'Continue the conversation…'
          }
          value={input}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          rows={isCompose ? 3 : 1}
          disabled={isRunning || isSending || needsSkillSelection}
          autoFocus={isCompose && !needsSkillSelection}
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
                  disabled={isRunning || isSending}
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
        {speechError && (
          <div className={styles.speechError}>{speechError}</div>
        )}
        <div className={styles.inputActions}>
          <button
            className={styles.attachBtn}
            onClick={openFilePicker}
            type="button"
            aria-label="Attach files"
            title="Attach files for context"
            disabled={isRunning || isSending || needsSkillSelection}
          >
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M7 10.5l5.2-5.2a3 3 0 114.2 4.2l-6.7 6.7a5 5 0 01-7.1-7.1l6.4-6.4" />
            </svg>
          </button>
          <button
            className={`${styles.micBtn} ${isListening ? styles.micBtnActive : ''}`}
            onClick={toggleSpeechRecognition}
            type="button"
            aria-label={isListening ? 'Stop voice transcription' : 'Start voice transcription'}
            title={isSpeechSupported
              ? (isListening ? 'Stop listening' : 'Talk to transcribe into chat')
              : 'Speech recognition is not supported in this browser'}
            disabled={!isSpeechSupported || isRunning || isSending || needsSkillSelection}
          >
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <rect x="7" y="2.5" width="6" height="10" rx="3" />
              <path d="M4.5 9.5v0.5a5.5 5.5 0 0 0 11 0v-0.5" />
              <path d="M10 15.5v2.5" />
              <path d="M7.5 18h5" />
            </svg>
          </button>
          {!isCompose && (
            <select
              className={styles.modelSelect}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={isRunning}
            >
              {modelsLoading || !availableModels?.length ? (
                <option value="">Loading models…</option>
              ) : (
                availableModels.map((m) => (
                  <option key={m.id} value={m.id}>{m.displayName}</option>
                ))
              )}
            </select>
          )}
          {isRunning ? (
            <button
              className={`${styles.sendBtn} ${styles.stopBtn}`}
              onClick={handleStop}
              type="button"
              aria-label="Stop"
            >
              <svg viewBox="0 0 20 20" fill="currentColor">
                <rect x="4" y="4" width="12" height="12" rx="2" />
              </svg>
            </button>
          ) : (
            <button
              className={styles.sendBtn}
              onClick={handleSend}
              disabled={!canSend}
              type="button"
              aria-label="Send"
            >
              <svg viewBox="0 0 20 20" fill="currentColor">
                <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
              </svg>
            </button>
          )}
        </div>
        {isListening && (
          <div className={styles.speechStatus}>Listening... your speech is being transcribed into the draft.</div>
        )}
      </div>
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
        />
      )}
      {isCompose ? (
        <div className={styles.compose}>
          <button
            className={styles.historyToggleBtn}
            onClick={() => setShowHistory((v) => !v)}
            type="button"
          >
            {showHistory ? '← Hide History' : '⏱ History'}
          </button>
          <div className={styles.composeInner}>
            <div className={styles.composeLogo}>
              <BrandLogo />
              <svg viewBox="0 0 154 63" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M16.268 32.4067C16.268 32.6846 15.9569 32.8434 15.7255 32.6846C14.1857 31.6127 12.2868 31.0015 10.1885 31.0015C4.53975 31.0015 0 35.6854 0 41.7824C0 44.5927 1.02922 47.1492 2.65682 49.0226C4.49983 51.1504 7.41199 52.5158 10.4917 52.5158C12.3666 52.5158 14.1458 51.9996 15.7255 50.8566C15.9569 50.69 16.268 50.8487 16.268 51.1266V51.5471C16.268 51.8488 16.5154 52.087 16.8106 52.087H21.0711C21.3743 52.087 21.6136 51.8408 21.6136 51.5471V31.9701C21.6136 31.6683 21.3663 31.4302 21.0711 31.4302H16.8106C16.5074 31.4302 16.268 31.6763 16.268 31.9701V32.4067ZM16.0526 44.7356C16.0526 44.8072 16.0287 44.8785 15.9888 44.9422C14.9117 46.4268 13.1006 47.411 11.0422 47.411C7.91461 47.411 5.56096 45.0293 5.56096 41.7903C5.56096 38.8053 7.65932 36.1221 10.9145 36.1221C13.0128 36.1221 14.8239 37.1066 15.9808 38.5832C16.0287 38.6466 16.0526 38.7179 16.0526 38.7974V44.7435V44.7356Z" fill="currentColor"/>
                <path d="M100.209 31.0017C97.68 31.0017 95.4143 31.9782 94.1695 33.5182V31.9624C94.1695 31.6685 93.9301 31.4304 93.6352 31.4304H89.3586C89.0633 31.4304 88.8242 31.6685 88.8242 31.9624V40.2267C87.3001 43.0291 85.1062 46.1649 83.0398 47.8719C80.8615 49.6819 78.2766 50.674 75.2527 50.0152C78.1886 47.8003 80.5984 45.3949 82.0185 42.5767C83.3108 39.9964 83.239 37.7577 83.0398 36.2731C82.4174 31.4939 76.9043 29.5727 72.5161 30.9461C69.9549 31.7162 67.9605 33.4548 66.6839 35.7173C64.3701 39.8059 64.5457 45.4345 66.652 48.9911C65.551 49.2452 64.2027 49.269 63.1173 48.864C61.5617 48.2607 60.8118 46.8715 60.8118 45.355C60.8118 45.355 60.7799 43.0054 60.8277 40.9093C60.7879 37.9639 60.0297 35.8998 58.7295 34.3281C57.0619 32.2799 54.3173 31.0017 51.4529 31.0017C48.5887 31.0017 46.0195 32.3512 44.3443 33.9786C44.2005 34.1136 43.977 34.1057 43.8495 33.9628C42.2218 32.1607 39.8044 31.0017 37.1076 31.0017C35.3205 31.0017 33.5653 31.5098 32.0495 32.637C31.818 32.8037 31.4989 32.6528 31.4989 32.367V31.9545C31.4989 31.6606 31.2595 31.4225 30.9643 31.4225H26.6879C26.3927 31.4225 26.1533 31.6606 26.1533 31.9545V51.5473C26.1533 51.8411 26.3927 52.0793 26.6879 52.0793H31.1797C31.475 52.0793 31.7143 51.8411 31.7143 51.5473V38.6626C32.4882 37.6864 34.1956 36.1064 36.5493 36.1064C37.6184 36.1064 38.815 36.4477 39.6768 37.3844C40.3151 38.1068 40.706 39.0438 40.706 40.9172V51.5473C40.706 51.8411 40.9455 52.0793 41.2404 52.0793H45.7326C46.0275 52.0793 46.2669 51.8411 46.2669 51.5473V41.1317C46.2669 40.2822 46.1793 39.5122 46.0995 38.8293C46.8255 37.7656 48.7083 36.1064 51.1098 36.1064C52.1789 36.1064 53.3758 36.4477 54.2373 37.3844C54.8756 38.1068 55.2586 39.0438 55.2665 40.9172C55.2665 42.4734 55.2346 44.2437 55.3147 45.5537C55.6577 50.9202 60.1815 54.2626 65.3674 54.0722C66.9154 53.9926 68.4869 53.6114 70.0269 53.0002C74.1837 55.9455 79.7924 55.8105 84.5237 52.3335C86.255 51.0552 87.7468 49.4119 88.8162 47.5303V51.5473C88.8162 51.8411 89.0553 52.0793 89.3506 52.0793H93.8424C94.1377 52.0793 94.3771 51.8411 94.3771 51.5473V39.0914C95.0633 37.853 96.9859 36.1064 99.4275 36.1064C99.9619 36.1064 100.497 36.146 100.903 36.2015C101.199 36.2493 101.47 36.0348 101.51 35.7411L102.012 31.6844C102.052 31.3907 101.845 31.1287 101.55 31.089C101.159 31.0335 100.76 30.9938 100.193 30.9938L100.209 31.0017ZM69.8034 41.338C70.0349 37.9085 73.2102 34.4394 76.2979 35.3919C78.7313 36.1381 78.4839 38.996 77.0877 41.3858C75.803 43.5846 74.0159 45.625 71.0801 47.2762C70.0508 45.5933 69.6198 44.0691 69.8034 41.338Z" fill="currentColor"/>
                <path d="M118.256 33.0893C116.629 31.7714 114.531 31.0015 112.177 31.0015C106.528 31.0015 101.988 35.6854 101.988 41.7824C101.988 44.5927 102.97 47.1492 104.597 49.0226C106.44 51.1504 109.392 52.5158 112.472 52.5158C114.57 52.5158 116.365 51.9204 118.041 50.6421V51.325C118.041 53.9686 117.61 55.2466 116.756 56.1836C115.815 57.2948 114.315 57.8427 112.52 57.8427C109.328 57.8427 107.438 56.2948 106.297 55.1119C106.161 54.9769 105.914 55.0086 105.802 55.1119L102.762 58.2477C102.611 58.3985 102.603 58.5652 102.754 58.716C104.852 60.9864 108.586 62.7409 112.52 62.7409C116.453 62.7409 119.844 61.2089 121.727 58.6048C122.972 56.8582 123.61 54.6433 123.61 50.9358V31.7476C123.61 31.5731 123.466 31.4222 123.283 31.4222H118.575C118.4 31.4222 118.249 31.5651 118.249 31.7476V33.0893H118.256ZM118.041 44.8468C116.972 46.3789 115.129 47.403 113.03 47.403C109.903 47.403 107.549 45.0214 107.549 41.7824C107.549 38.7974 109.647 36.1141 112.903 36.1141C115.041 36.1141 116.884 37.1383 118.041 38.6703V44.8468Z" fill="currentColor"/>
                <path d="M133.025 31.4302H128.142C127.953 31.4302 127.799 31.583 127.799 31.7717V51.7537C127.799 51.9422 127.953 52.0949 128.142 52.0949H133.025C133.214 52.0949 133.368 51.9422 133.368 51.7537V31.7717C133.368 31.583 133.214 31.4302 133.025 31.4302Z" fill="currentColor"/>
                <path d="M131.006 20.5859C128.772 20.3557 126.898 22.007 126.953 24.1901C126.993 25.9605 128.405 27.4292 130.177 27.6118C132.411 27.842 134.285 26.1907 134.23 24.0075C134.19 22.2372 132.778 20.7685 131.006 20.5859Z" fill="currentColor"/>
                <path d="M143.939 37.3523C143.939 36.2886 145.223 35.6932 146.763 35.6932C148.08 35.6932 149.332 36.1853 150.338 36.8285C150.561 36.9714 150.864 36.9077 151.016 36.6856L153.098 33.4941C153.25 33.264 153.178 32.9624 152.947 32.8115C151.455 31.8587 148.79 31.0093 146.333 31.0093C142.224 31.0093 138.37 33.4782 138.37 37.4398C138.37 44.0846 148.431 42.9809 148.431 46.085C148.431 47.1091 147.274 47.8316 145.774 47.8316C143.867 47.8316 141.889 47.1966 140.484 46.1249C140.261 45.9503 139.934 45.9979 139.774 46.2358L137.652 49.3561C137.5 49.5782 137.564 49.8878 137.788 50.0386C140.157 51.6502 143.021 52.5235 145.734 52.5235C150.098 52.5235 154 50.0944 154 46.1328C154 38.9718 143.939 40.0438 143.939 37.3523Z" fill="currentColor"/>
                <path d="M41.5675 24.5315H48.7723C48.9238 24.5315 49.0593 24.4283 49.1071 24.2854C52.0832 14.5842 60.8596 8.70941 71.2793 8.06638C71.7024 8.04255 71.6861 7.38361 71.2633 7.35186C56.4235 6.2166 43.8096 15.5686 41.2324 24.087C41.1686 24.3093 41.3363 24.5315 41.5754 24.5315H41.5675Z" fill="currentColor"/>
                <path d="M101.605 24.5313H108.499C108.754 24.5313 108.937 24.301 108.889 24.0549C106.36 10.5033 91.6402 -0.960387 71.6221 0.0637259C65.032 0.405096 59.5906 2.4692 56.5189 4.94612C56.1918 5.20811 56.4711 5.73206 56.87 5.5971C61.4737 4.05698 66.5637 3.42979 71.5503 3.62033C86.5499 4.19986 98.757 14.568 101.206 24.2058C101.254 24.3884 101.406 24.5313 101.597 24.5313H101.605Z" fill="currentColor"/>
              </svg>
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
                  />
                );
              });
            })()}

            {isRunning && !streamingText && (
              <div className={styles.agentRow}>
                <div className={styles.agentAvatar}>AI</div>
                <div className={`${styles.agentBubble} ${styles.typing}`}>
                  <span /><span /><span />
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
                <button className={styles.btnSecondary} onClick={() => setShowPrdPreview(true)} type="button">
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
        />
      )}
    </div>
  );
};
