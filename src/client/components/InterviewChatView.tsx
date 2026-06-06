import React, { useState, useRef, useEffect, useCallback, KeyboardEvent } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAppShell } from '../hooks/useAppShell';
import { useStartChat, useChatThread, useSkillList, useSkillRepos } from '../hooks/useChatThreads';
import { useProjectSkillConfig, useGlobalDefaultModel, useAvailableModels } from '../hooks/useProjectSkillConfig';
import { useChatStream } from '../hooks/useChatStream';
import { useChatAttachments, formatAttachmentSize } from '../hooks/useChatAttachments';
import { useSpeechInput } from '../hooks/useSpeechInput';
import { useContextEstimate } from '../hooks/useContextEstimate';
import { AGENT_MODELS, DEFAULT_MODEL_ID } from '../config/models';
import {
  useInterview,
  useUpdateInterviewStatus,
  useUpdateInterviewTitle,
  useCreatePrd,
  useCreateInterview,
  useDeleteInterview,
} from '../hooks/useInterviews';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import { SectionOwnerModal } from './SectionOwnerModal';
import type { InterviewStatus } from '../../shared/types/interview';
import { parseAgentMessage } from '../utils/parseAgentMessage';
import type { ChoiceBlock } from '../utils/parseAgentMessage';
import { trackEvent, trackException } from '../services/telemetry';
import styles from './InterviewChatView.module.css';

function badgeClass(status: InterviewStatus): string {
  switch (status) {
    case 'in_progress': return styles.badgeInProgress;
    case 'complete': return styles.badgeComplete;
    case 'archived': return styles.badgeArchived;
  }
}

function badgeLabel(status: InterviewStatus): string {
  switch (status) {
    case 'in_progress': return 'In Progress';
    case 'complete': return 'Complete';
    case 'archived': return 'Archived';
  }
}

// ── Interactive choice block ──────────────────────────────────────────────────

interface ChoiceBlockUIProps {
  block: ChoiceBlock;
  questionNumber: number;
  selection: string | null;
  freeform: string;
  locked: boolean;
  onSelect: (letter: string) => void;
  onFreeform: (text: string) => void;
}

const InterviewChoiceBlockUI: React.FC<ChoiceBlockUIProps> = ({
  block, questionNumber, selection, freeform, locked, onSelect, onFreeform,
}) => (
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
    {(selection === 'other') && !locked && (
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

// ── Assistant message with interactive choices ────────────────────────────────

interface QuestionState { selected: string | null; freeform: string; }

interface InterviewAgentMessageProps {
  text: string;
  onSend: (text: string) => void;
  isRunning: boolean;
  questionOffset?: number;
  interviewLocked?: boolean;
  alreadyAnswered?: boolean;
}

const InterviewAgentMessage: React.FC<InterviewAgentMessageProps> = ({ text, onSend, isRunning, questionOffset = 0, interviewLocked = false, alreadyAnswered = false }) => {
  const parts = parseAgentMessage(text);
  const choiceBlocks = parts.filter((p): p is ChoiceBlock => p.type === 'choices');

  const [selections, setSelections] = useState<Record<string, QuestionState>>(() => {
    const init: Record<string, QuestionState> = {};
    for (const b of choiceBlocks) init[b.id] = { selected: null, freeform: '' };
    return init;
  });
  // Initialize from `alreadyAnswered` so a previously-submitted question stays
  // locked after a page reload (the submission state is otherwise only kept in
  // ephemeral component state).
  const [sent, setSent] = useState(alreadyAnswered);

  // Lock the block if the thread later shows it was answered (e.g. when message
  // history loads asynchronously after this component first mounts).
  useEffect(() => {
    if (alreadyAnswered) setSent(true);
  }, [alreadyAnswered]);

  const allAnswered = choiceBlocks.every((b) => {
    const s = selections[b.id];
    if (!s) return false;
    if (s.selected === 'other') return s.freeform.trim().length > 0;
    return s.selected !== null;
  });

  const handleSelect = useCallback((blockId: string, letter: string) => {
    setSelections((prev) => ({ ...prev, [blockId]: { ...prev[blockId], selected: letter } }));
  }, []);

  const handleFreeform = useCallback((blockId: string, text: string) => {
    setSelections((prev) => ({ ...prev, [blockId]: { ...prev[blockId], freeform: text } }));
  }, []);

  const handleSubmit = () => {
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
        if (s.freeform.trim()) lines.push(`  Notes: ${s.freeform.trim()}`);
      }
      qNum++;
    }
    onSend(lines.join('\n'));
    setSent(true);
  };

  if (choiceBlocks.length === 0) {
    return (
      <div className={`${styles.messageBubble} ${styles.messageBubbleAssistant}`}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </div>
    );
  }

  let questionCounter = questionOffset;
  return (
    <div className={styles.assistantBubble}>
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
          <InterviewChoiceBlockUI
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
      {!sent && !interviewLocked && (
        <button
          className={styles.choiceSendBtn}
          onClick={handleSubmit}
          disabled={!allAnswered || isRunning}
          type="button"
        >
          {isRunning ? 'Agent is thinking…' : 'Submit answers ↑'}
        </button>
      )}
      {sent && <div className={styles.choiceSentLabel}>✓ Answers sent</div>}
    </div>
  );
};

// ── New interview compose view ────────────────────────────────────────────────

const NewInterviewCompose: React.FC = () => {
  const navigate = useNavigate();
  const { selectedProject } = useAppShell();
  const [input, setInput] = useState('');
  const [title, setTitle] = useState('');
  const [titleTouched, setTitleTouched] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [showOwnerModal, setShowOwnerModal] = useState(false);
  const [model, setModel] = useState(DEFAULT_MODEL_ID);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const prevEffectiveDefaultRef = useRef<string>(DEFAULT_MODEL_ID);

  const { data: repos = [] } = useSkillRepos(selectedProject || null);
  const { data: skillConfig } = useProjectSkillConfig(selectedProject || null);
  const { data: globalDefaultModel } = useGlobalDefaultModel();
  const { data: availableModels, isLoading: modelsLoading } = useAvailableModels();

  // Resolve repo + branch: admin config takes priority, then heuristic fallback
  const resolvedRepoName = skillConfig?.skillRepo
    ?? repos.find((r) => r.name.toLowerCase() === selectedProject.toLowerCase())?.name
    ?? repos[0]?.name
    ?? null;
  const resolvedBranch = skillConfig?.skillBranch
    ?? repos.find((r) => r.name === resolvedRepoName)?.defaultBranch
    ?? 'main';

  const { data: skills = [] } = useSkillList(
    selectedProject || null,
    resolvedRepoName,
    resolvedBranch,
  );
  const grillSkill = skillConfig?.interviewSkillPath
    ? skills.find((s) => s.path === skillConfig.interviewSkillPath)
    : skills.find((s) => s.name === 'grill-with-docs');

  const {
    attachments,
    attachmentError,
    addFiles,
    removeAttachment,
    clearAttachments,
  } = useChatAttachments();

  const speech = useSpeechInput(useCallback((text: string) => setInput(text), []));

  const startChat = useStartChat();
  const createInterview = useCreateInterview();

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  useEffect(() => {
    const newDefault = skillConfig?.interviewModel ?? globalDefaultModel?.value ?? DEFAULT_MODEL_ID;
    const prevDefault = prevEffectiveDefaultRef.current;
    prevEffectiveDefaultRef.current = newDefault;
    setModel((current) => current === prevDefault ? newDefault : current);
  }, [skillConfig?.interviewModel, globalDefaultModel?.value]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSend = useCallback(() => {
    const text = input.trim();
    const trimmedTitle = title.trim();
    if ((!text && attachments.length === 0) || isSending || !resolvedRepoName) return;
    if (!trimmedTitle) {
      setTitleTouched(true);
      titleInputRef.current?.focus();
      return;
    }
    if (speech.isListening) speech.stop();
    setSendError(null);
    setShowOwnerModal(true);
  }, [input, title, attachments, isSending, resolvedRepoName, speech]);

  const handleCreateInterview = useCallback(async (owners: { prdOwnerId?: string; designDocOwnerId?: string }) => {
    const text = input.trim();
    const trimmedTitle = title.trim();
    if (!resolvedRepoName || !trimmedTitle) return;
    setIsSending(true);
    try {
      const threadResult = await startChat.mutateAsync({
        kickoff: {
          project: selectedProject,
          repo: resolvedRepoName,
          branch: resolvedBranch,
          skillPath: grillSkill?.path,
          model,
        },
        skipAutoKickoff: true,
      });
      const result = await createInterview.mutateAsync({
        project: selectedProject,
        repo: resolvedRepoName,
        title: trimmedTitle,
        chatThreadId: threadResult.threadId,
        prdOwnerId: owners.prdOwnerId,
        designDocOwnerId: owners.designDocOwnerId,
      });
      trackEvent('interview.started', {
        interviewId: result.interviewId,
        project: selectedProject,
        repo: resolvedRepoName,
      });
      await fetch(`/api/chat/threads/${threadResult.threadId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ text: text || 'Please use the attached files as context.', attachments, model }),
      });
      clearAttachments();
      navigate(`/backlog/interview/${result.interviewId}`);
    } catch (err: unknown) {
      trackException(err instanceof Error ? err : new Error(String(err)), {
        context: 'interview.create',
      });
      const msg = err instanceof Error ? err.message : 'Failed to start interview';
      setSendError(msg);
      setIsSending(false);
    }
  }, [input, title, attachments, resolvedRepoName, resolvedBranch, selectedProject, grillSkill, startChat, createInterview, navigate, clearAttachments, model]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }, [handleSend]);

  const handleAttachmentChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    await addFiles(e.currentTarget.files);
    e.currentTarget.value = '';
  }, [addFiles]);

  return (
    <div className={styles.composeContainer}>
      <button className={styles.backBtn} onClick={() => navigate('/backlog')} type="button">
        ← Back
      </button>

      <div className={styles.composeInner}>
        <h1 className={styles.composeHeading}>What would you like to interview about?</h1>

        <div className={styles.composePills}>
          {selectedProject && (
            <span className={styles.composePill}>
              <svg viewBox="0 0 12 12" fill="currentColor">
                <rect x="1" y="1" width="4" height="4" rx="0.5" />
                <rect x="7" y="1" width="4" height="4" rx="0.5" />
                <rect x="1" y="7" width="4" height="4" rx="0.5" />
                <rect x="7" y="7" width="4" height="4" rx="0.5" />
              </svg>
              {selectedProject}
            </span>
          )}

          {resolvedRepoName ? (
            <span className={styles.composePill}>
              <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="1,3 4,6 1,9" /><line x1="5" y1="9" x2="11" y2="9" />
              </svg>
              {resolvedRepoName}
            </span>
          ) : null}

          <span className={`${styles.composePill} ${styles.composePillSkill}`}>
            ✨ {grillSkill?.name ?? 'grill-with-docs'}
          </span>
        </div>

        <div className={styles.composeInputBox}>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className={styles.fileInput}
            onChange={handleAttachmentChange}
            disabled={isSending}
          />
          <div className={styles.composeTitleRow}>
            <label className={styles.composeTitleLabel} htmlFor="interview-title">
              Title <span className={styles.composeTitleRequired}>*</span>
            </label>
            <input
              ref={titleInputRef}
              id="interview-title"
              className={`${styles.composeTitleInput} ${titleTouched && !title.trim() ? styles.composeTitleInputError : ''}`}
              value={title}
              onChange={(e) => { setTitle(e.target.value); setTitleTouched(true); }}
              onBlur={() => setTitleTouched(true)}
              placeholder="Give this interview a short, descriptive name"
              disabled={isSending}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  textareaRef.current?.focus();
                }
              }}
            />
            {titleTouched && !title.trim() && (
              <span className={styles.composeTitleErrorMsg}>A title is required</span>
            )}
          </div>
          <textarea
            ref={textareaRef}
            className={styles.composeTextarea}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describe what you'd like to explore in this interview… (Enter to send, Shift+Enter for new line)"
            rows={3}
            disabled={isSending}
          />
          {attachments.length > 0 && (
            <div className={styles.attachmentList}>
              {attachments.map((a) => (
                <span key={a.id} className={styles.attachmentChip}>
                  <span className={styles.attachmentName}>{a.name}</span>
                  <span className={styles.attachmentSize}>{formatAttachmentSize(a.size)}</span>
                  <button
                    type="button"
                    className={styles.attachmentRemove}
                    onClick={() => removeAttachment(a.id)}
                    disabled={isSending}
                    aria-label={`Remove ${a.name}`}
                  >×</button>
                </span>
              ))}
            </div>
          )}
          {attachmentError && <div className={styles.attachmentError}>{attachmentError}</div>}
          {sendError && <div className={styles.composeError}>{sendError}</div>}
          {speech.speechError && <div className={styles.speechError}>{speech.speechError}</div>}
          <div className={styles.inputActions}>
            <button
              className={styles.attachBtn}
              onClick={() => fileInputRef.current?.click()}
              type="button"
              aria-label="Attach files"
              title="Attach files for context"
              disabled={isSending}
            >
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 10.5l5.2-5.2a3 3 0 114.2 4.2l-6.7 6.7a5 5 0 01-7.1-7.1l6.4-6.4" />
              </svg>
            </button>
            <button
              className={`${styles.micBtn} ${speech.isListening ? styles.micBtnActive : ''}`}
              onClick={() => speech.toggle(input)}
              type="button"
              aria-label={speech.isListening ? 'Stop voice transcription' : 'Start voice transcription'}
              title={speech.isSpeechSupported
                ? (speech.isListening ? 'Stop listening' : 'Talk to transcribe into chat')
                : 'Speech recognition not supported in this browser'}
              disabled={!speech.isSpeechSupported || isSending}
            >
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <rect x="7" y="2.5" width="6" height="10" rx="3" />
                <path d="M4.5 9.5v0.5a5.5 5.5 0 0 0 11 0v-0.5" />
                <path d="M10 15.5v2.5" />
                <path d="M7.5 18h5" />
              </svg>
            </button>
            <select
              className={styles.modelSelect}
              value={model}
              onChange={(e) => setModel(e.target.value)}
              disabled={isSending}
            >
              {modelsLoading || !availableModels?.length ? (
                <option value={model}>Loading models…</option>
              ) : (
                availableModels.map((m) => (
                  <option key={m.id} value={m.id}>{m.displayName}</option>
                ))
              )}
            </select>
            <button
              className={styles.sendBtn}
              onClick={() => void handleSend()}
              disabled={(!input.trim() && attachments.length === 0) || isSending || !resolvedRepoName || !title.trim()}
              type="button"
              aria-label="Start interview"
            >
              {isSending ? (
                <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={styles.spinIcon}>
                  <path d="M13 3v4H9" /><path d="M13 7A6 6 0 1 1 9.5 2.5" />
                </svg>
              ) : (
                <svg viewBox="0 0 20 20" fill="currentColor">
                  <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
                </svg>
              )}
            </button>
          </div>
          {speech.isListening && (
            <div className={styles.speechStatus}>Listening… your speech is being transcribed.</div>
          )}
        </div>

        <p className={styles.composeHint}>
          Enter to send · Shift+Enter for new line · The <strong>{grillSkill?.name ?? 'grill-with-docs'}</strong> skill will guide this structured interview
        </p>
      </div>

      {showOwnerModal && (
        <SectionOwnerModal
          project={selectedProject}
          onConfirm={(owners) => {
            setShowOwnerModal(false);
            void handleCreateInterview(owners);
          }}
          onSkip={() => {
            setShowOwnerModal(false);
            void handleCreateInterview({});
          }}
          isSubmitting={isSending}
        />
      )}
    </div>
  );
};

// ── Existing interview chat view ──────────────────────────────────────────────

const ExistingInterviewView: React.FC<{ id: string }> = ({ id }) => {
  const navigate = useNavigate();
  const { can, userId, isAdmin } = useAppShell();

  const { data: interview, isLoading, isError } = useInterview(id);
  const { data: skillConfig } = useProjectSkillConfig(interview?.project ?? null);
  const { data: globalDefaultModel } = useGlobalDefaultModel();

  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [model, setModel] = useState(DEFAULT_MODEL_ID);
  const [sendError, setSendError] = useState<string | null>(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [wrapUpDismissed, setWrapUpDismissed] = useState(false);
  const [showSendConfirm, setShowSendConfirm] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const updateStatus = useUpdateInterviewStatus();
  const updateTitle = useUpdateInterviewTitle();
  const startChat = useStartChat();
  const createPrd = useCreatePrd();
  const deleteInterview = useDeleteInterview();

  const { data: prdRepos = [] } = useSkillRepos(interview?.project ?? null);
  const prdRepoInfo = prdRepos.find((r) => r.name === (skillConfig?.skillRepo ?? interview?.repo));
  // Use admin-configured branch if available; otherwise fall back to repo's defaultBranch
  const resolvedPrdRepo = skillConfig?.skillRepo ?? interview?.repo ?? null;
  const resolvedPrdBranch = skillConfig?.skillBranch ?? prdRepoInfo?.defaultBranch ?? 'main';
  const { data: skills = [] } = useSkillList(
    interview?.project ?? null,
    resolvedPrdRepo,
    resolvedPrdBranch,
  );
  const toPrdSkill = skillConfig?.prdSkillPath
    ? skills.find((s) => s.path === skillConfig.prdSkillPath)
    : skills.find((s) => s.name === 'to-prd');

  const {
    attachments,
    attachmentError,
    addFiles,
    removeAttachment,
    clearAttachments,
  } = useChatAttachments();

  const speech = useSpeechInput(useCallback((text: string) => setInput(text), []));

  const { data: chatThread } = useChatThread(interview?.chatThreadId ?? null);

  const { messages, streamingText, status: threadStatus, isRetrying, retryReason } = useChatStream(
    interview?.chatThreadId ?? null,
    {
      initialMessages: chatThread?.messages,
      initialStatus: chatThread?.status,
    },
  );

  const isRunning = threadStatus === 'running';

  const visibleMessagesForContext = messages.filter((m) => !(m.role === 'user' && m.text === 'Begin.'));
  const draftAttachmentChars = attachments.reduce((sum, a) => sum + a.content.length, 0);
  const contextEstimate = useContextEstimate(
    visibleMessagesForContext, input, streamingText, model, draftAttachmentChars,
  );

  useEffect(() => {
    if (chatThread) {
      setModel(chatThread.kickoff.model ?? DEFAULT_MODEL_ID);
    }
  }, [chatThread?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, streamingText]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [input]);

  useEffect(() => {
    if (isEditingTitle && titleInputRef.current) {
      titleInputRef.current.focus();
      titleInputRef.current.select();
    }
  }, [isEditingTitle]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || isRunning || isSending || !interview?.chatThreadId) return;
    if (speech.isListening) speech.stop();
    setInput('');
    setSendError(null);
    setIsSending(true);
    try {
      const res = await fetch(`/api/chat/threads/${interview.chatThreadId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          text: text || 'Please use the attached files as context.',
          attachments,
          model,
        }),
      });
      if (!res.ok) {
        let msg = 'Failed to send message';
        try {
          const body = await res.json();
          if (body?.error) msg = body.error;
        } catch { /* use default msg */ }
        setSendError(msg);
        return;
      }
      clearAttachments();
    } catch (err: unknown) {
      trackException(err instanceof Error ? err : new Error(String(err)), {
        context: 'interview.send',
        interviewId: id,
      });
      const msg = err instanceof Error ? err.message : 'Failed to send message';
      setSendError(msg);
    } finally {
      setIsSending(false);
    }
  }, [input, attachments, isRunning, isSending, interview?.chatThreadId, clearAttachments, speech]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }, [handleSend]);

  const handleRetryLast = useCallback(() => {
    if (!interview?.chatThreadId || isRunning) return;
    const lastUserMsg = [...visibleMessagesForContext].reverse().find((m) => m.role === 'user');
    if (!lastUserMsg) return;
    void fetch(`/api/chat/threads/${interview.chatThreadId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ text: lastUserMsg.text, model }),
    });
  }, [interview?.chatThreadId, isRunning, visibleMessagesForContext, model]);

  const handleAttachmentChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    await addFiles(e.currentTarget.files);
    e.currentTarget.value = '';
  }, [addFiles]);

  const handleStatusChange = useCallback(async (newStatus: InterviewStatus) => {
    await updateStatus.mutateAsync({ id, status: newStatus });
  }, [id, updateStatus]);

  const startTitleEdit = useCallback(() => {
    if (!interview) return;
    setEditTitle(interview.title);
    setIsEditingTitle(true);
  }, [interview]);

  const commitTitleEdit = useCallback(async () => {
    if (!editTitle.trim()) {
      setIsEditingTitle(false);
      return;
    }
    await updateTitle.mutateAsync({ id, title: editTitle.trim() });
    setIsEditingTitle(false);
  }, [id, editTitle, updateTitle]);

  const handleTitleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') void commitTitleEdit();
    if (e.key === 'Escape') setIsEditingTitle(false);
  }, [commitTitleEdit]);

  const handleGeneratePrd = useCallback(async () => {
    if (!interview) return;
    try {
      // Build a transcript from the interview conversation so the /to-prd skill has full context
      const transcriptLines: string[] = ['# Interview Transcript', ''];
      for (const msg of messages) {
        if (msg.role === 'user' && msg.text !== 'Begin.') {
          transcriptLines.push(`**User:** ${msg.text}`, '');
        } else if (msg.role === 'agent') {
          transcriptLines.push(`**Agent:** ${msg.text}`, '');
        }
      }
      const transcript = transcriptLines.join('\n');

      // Resolve the to-prd skill path; fall back to the convention if not in the skill list yet
      const skillPath = toPrdSkill?.path ?? '.cursor/skills/to-prd/SKILL.md';

      // Create the generation thread — NOT skipAutoKickoff so the agent starts automatically
      const prdModel = skillConfig?.prdModel ?? globalDefaultModel?.value ?? DEFAULT_MODEL_ID;
      const threadResult = await startChat.mutateAsync({
        kickoff: {
          project: interview.project,
          repo: resolvedPrdRepo ?? interview.repo,
          branch: resolvedPrdBranch,
          skillPath,
          transcript,
          model: prdModel,
        },
      });

      const prdResult = await createPrd.mutateAsync({
        interviewId: id,
        chatThreadId: threadResult.threadId,
        title: interview.title,
      });
      navigate(`/backlog/prd/${prdResult.prdId}`);
    } catch (err: unknown) {
      trackException(err instanceof Error ? err : new Error(String(err)), {
        context: 'interview.generatePrd',
        interviewId: id,
      });
      const msg = err instanceof Error ? err.message : 'Failed to generate PRD';
      setSendError(msg);
    }
  }, [id, interview, messages, toPrdSkill, skillConfig?.prdModel, globalDefaultModel?.value, startChat, createPrd, navigate]);

  if (isLoading) return <div className={styles.loadingState}>Loading interview…</div>;
  if (isError || !interview) return <div className={styles.errorState}>Interview not found.</div>;

  const visibleMessages = messages.filter((m) => !(m.role === 'user' && m.text === 'Begin.'));
  const canManage = can('interviews:manage');
  const isAuthor = interview.authorId === userId;
  const isReadOnlyViewer = !isAuthor && !isAdmin;
  const isStatusLocked = interview.status !== 'in_progress';
  const isChatLocked = isReadOnlyViewer || isStatusLocked;

  // Pre-compute cumulative question offset for each assistant message so Q-numbers
  // are globally sequential across the whole conversation rather than restarting at 1
  // for each agent reply.
  let runningQCount = 0;
  const messageQOffsets = new Map<string, number>();
  for (const msg of visibleMessages) {
    if (msg.role === 'agent') {
      messageQOffsets.set(msg.id, runningQCount);
      const parts = parseAgentMessage(msg.text);
      runningQCount += parts.filter((p): p is ChoiceBlock => p.type === 'choices').length;
    }
  }

  // An agent message's choice block has already been answered if any user
  // message follows it in the thread (submitting answers creates a user
  // message). Used to persist the "Answers sent" lock across reloads.
  let lastUserMsgIndex = -1;
  visibleMessages.forEach((m, i) => {
    if (m.role === 'user') lastUserMsgIndex = i;
  });

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <button className={styles.backBtn} onClick={() => navigate('/backlog')} type="button">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 3L5 8l5 5" />
            </svg>
            Back
          </button>

          <div className={styles.titleBlock}>
            <div className={styles.titleRow}>
              {isEditingTitle ? (
                <input
                  ref={titleInputRef}
                  className={styles.titleInput}
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  onBlur={() => void commitTitleEdit()}
                  onKeyDown={handleTitleKeyDown}
                />
              ) : (
                <h1
                  className={styles.title}
                  onClick={canManage ? startTitleEdit : undefined}
                  title={canManage ? 'Click to rename' : undefined}
                >
                  {interview.title}
                </h1>
              )}
              <span className={`${styles.badge} ${badgeClass(interview.status)}`}>
                {badgeLabel(interview.status)}
              </span>
            </div>
            <div className={styles.titleMeta}>
              <span>{interview.project}</span>
              <span className={styles.titleMetaSep}>·</span>
              <span>{interview.repo}</span>
            </div>
            {(interview.prdOwnerName || interview.designDocOwnerName) && (
              <div className={styles.ownerChips}>
                {interview.prdOwnerName && (
                  <span className={styles.ownerChip}>
                    PRD: {interview.prdOwnerName}
                  </span>
                )}
                {interview.designDocOwnerName && (
                  <span className={styles.ownerChip}>
                    Design Doc: {interview.designDocOwnerName}
                  </span>
                )}
              </div>
            )}
            {interview.prds.length > 0 && (
              <div className={styles.titlePrdLinks}>
                {interview.prds.map((prd) => (
                  <button
                    key={prd.id}
                    className={styles.prdLinkChip}
                    onClick={() => navigate(`/backlog/prd/${prd.id}`)}
                    type="button"
                    title={`View PRD: ${prd.title}`}
                  >
                    <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="2" y="1" width="10" height="12" rx="1.5" />
                      <path d="M4.5 4.5h5M4.5 7h5M4.5 9.5h3" />
                    </svg>
                    {prd.title}
                    <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ width: 8, height: 8, opacity: 0.6 }}>
                      <path d="M2 8L8 2M5 2h3v3" />
                    </svg>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className={styles.headerRight}>
          {canManage && (
            <div className={styles.actions}>
              {interview.status === 'in_progress' && (
                <button
                  className={styles.actionBtn}
                  onClick={() => void handleStatusChange('complete')}
                  disabled={updateStatus.isPending}
                  type="button"
                  title="Mark this interview as complete"
                >
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 8l3.5 3.5L13 4" />
                  </svg>
                  Complete
                </button>
              )}
              {interview.status === 'complete' && (
                <button
                  className={styles.actionBtn}
                  onClick={() => void handleStatusChange('in_progress')}
                  disabled={updateStatus.isPending || interview.prds.length > 0}
                  type="button"
                  title={interview.prds.length > 0 ? 'Cannot reopen — a PRD has already been generated' : 'Reopen this interview'}
                >
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M13 3v4H9" />
                    <path d="M13 7A6 6 0 1 1 9.5 2.5" />
                  </svg>
                  Reopen
                </button>
              )}
              {(interview.status === 'in_progress' || interview.status === 'complete') && (
                <button
                  className={styles.actionBtnDanger}
                  onClick={() => void handleStatusChange('archived')}
                  disabled={updateStatus.isPending}
                  type="button"
                  title="Archive this interview"
                >
                  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="5" width="12" height="9" rx="1" />
                    <path d="M2 5l1.5-3h9L14 5" />
                    <path d="M6 9h4" />
                  </svg>
                  Archive
                </button>
              )}
              {interview.status === 'complete' && (
                <button
                  className={styles.actionBtnPrimary}
                  onClick={() => void handleGeneratePrd()}
                  disabled={startChat.isPending || createPrd.isPending || interview.prds.length > 0}
                  type="button"
                  title={interview.prds.length > 0 ? 'A PRD has already been generated for this interview' : 'Generate a PRD from this interview'}
                >
                  {startChat.isPending || createPrd.isPending ? (
                    <>
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={styles.spinIcon}>
                        <path d="M13 3v4H9" />
                        <path d="M13 7A6 6 0 1 1 9.5 2.5" />
                      </svg>
                      Creating…
                    </>
                  ) : (
                    <>
                      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="1" width="10" height="14" rx="1.5" />
                        <path d="M6 5h4M6 8h4M6 11h2" />
                      </svg>
                      Generate PRD
                    </>
                  )}
                </button>
              )}

              <button
                className={styles.actionBtnDanger}
                onClick={() => setShowDeleteModal(true)}
                disabled={deleteInterview.isPending}
                type="button"
                title="Delete this interview"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="2 4 4 4 14 4" />
                  <path d="M13 4l-.7 9.3A1 1 0 0 1 12.3 14H3.7a1 1 0 0 1-1-.7L2 4" />
                  <path d="M6.5 7v4M9.5 7v4" />
                  <path d="M5.5 4V2.7A.7.7 0 0 1 6.2 2h3.6a.7.7 0 0 1 .7.7V4" />
                </svg>
                Delete
              </button>
            </div>
          )}
        </div>
      </div>

      {sendError && (
        <div className={styles.sendError}>
          {sendError}
          <button
            type="button"
            className={styles.sendErrorDismiss}
            onClick={() => setSendError(null)}
            aria-label="Dismiss error"
          >×</button>
        </div>
      )}

      <div className={styles.messages}>
        <div className={styles.messageList}>
          {visibleMessages.map((msg, msgIndex) => {
            if (msg.role === 'tool') {
              return (
                <div key={msg.id} className={styles.messageBubbleTool}>→ {msg.text}</div>
              );
            }
            if (msg.role === 'system') {
              const isError = msg.text.startsWith('Error:');
              if (isError && !isChatLocked) {
                return (
                  <div key={msg.id} className={styles.systemErrorMsg}>
                    <span className={styles.systemErrorText}>{msg.text}</span>
                    <button
                      className={styles.retryBtn}
                      onClick={() => handleRetryLast()}
                      disabled={isRunning}
                      type="button"
                    >
                      ↺ Try again
                    </button>
                  </div>
                );
              }
              return <div key={msg.id} className={styles.messageBubbleSystem}>{msg.text}</div>;
            }
            if (msg.role === 'user') {
              return (
                <div key={msg.id} className={`${styles.messageBubble} ${styles.messageBubbleUser}`}>
                  {msg.text}
                </div>
              );
            }
            return (
              <InterviewAgentMessage
                key={msg.id}
                text={msg.text}
                onSend={(text) => {
                  if (isChatLocked) return;
                  setInput('');
                  void fetch(`/api/chat/threads/${interview.chatThreadId}/messages`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ text, model }),
                  });
                }}
                isRunning={isRunning}
                questionOffset={messageQOffsets.get(msg.id) ?? 0}
                interviewLocked={isChatLocked}
                alreadyAnswered={msgIndex < lastUserMsgIndex}
              />
            );
          })}

          {isRetrying && (
            <div className={styles.retryingIndicator}>
              <span className={styles.retryingSpinner} />
              {retryReason || 'Retrying…'}
            </div>
          )}

          {isRunning && !streamingText && !isRetrying && (
            <div className={styles.typingIndicator}>
              <span className={styles.typingDot} />
              <span className={styles.typingDot} />
              <span className={styles.typingDot} />
            </div>
          )}

          {streamingText && (
            <div className={`${styles.messageBubble} ${styles.messageBubbleAssistant}`}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingText}</ReactMarkdown>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {isChatLocked ? (
        <div className={styles.lockedNotice} data-testid="locked-notice">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="7" width="10" height="8" rx="1.5" />
            <path d="M5 7V5a3 3 0 0 1 6 0v2" />
          </svg>
          <span>
            {isReadOnlyViewer && interview.status === 'in_progress'
              ? "You are viewing another user's interview (read-only)."
              : interview.status === 'complete'
                ? <>This interview is complete and the chat is closed.{interview.prds.length > 0 ? ' View the linked PRD above.' : ''}</>
                : 'This interview is archived and the chat is read-only.'}
          </span>
          {interview.status === 'complete' && canManage && interview.prds.length === 0 && (
            <button
              className={styles.lockedReopenBtn}
              onClick={() => void handleStatusChange('in_progress')}
              disabled={updateStatus.isPending}
              type="button"
            >
              Reopen
            </button>
          )}
        </div>
      ) : (
        <div className={styles.inputArea}>
          <div className={styles.contextBar}>
            <div
              className={styles.contextBarTrack}
              title={`Estimated context: ${contextEstimate.estimatedTokens.toLocaleString()} / ${contextEstimate.contextLimit.toLocaleString()} tokens`}
            >
              <div
                className={`${styles.contextBarFill} ${contextEstimate.isCritical ? styles.contextBarFillCritical : contextEstimate.isWarning ? styles.contextBarFillWarn : ''}`}
                style={{ width: `${contextEstimate.usagePercent}%` }}
              />
            </div>
            <span className={`${styles.contextBarLabel} ${contextEstimate.isWarning ? styles.contextBarLabelWarn : ''}`}>
              {contextEstimate.label} / {contextEstimate.contextLimit >= 1000 ? `${Math.round(contextEstimate.contextLimit / 1000)}k` : contextEstimate.contextLimit}
              {contextEstimate.isWarning && ' ⚠'}
            </span>
          </div>

          {contextEstimate.isCritical && (
            <div className={styles.wrapUpBannerCritical}>
              <svg className={styles.wrapUpIcon} viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              <div className={styles.wrapUpBody}>
                <strong>Context window is nearly full.</strong> To ensure all your Q&amp;A is preserved in the PRD, we strongly recommend generating now.
                <div className={styles.wrapUpActions}>
                  <button
                    className={styles.wrapUpGenerateBtn}
                    onClick={() => void handleGeneratePrd()}
                    disabled={startChat.isPending || createPrd.isPending || interview.prds.length > 0}
                    type="button"
                  >
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="1" width="10" height="14" rx="1.5" />
                      <path d="M6 5h4M6 8h4M6 11h2" />
                    </svg>
                    Generate PRD Now
                  </button>
                </div>
              </div>
            </div>
          )}

          {contextEstimate.isNearLimit && !contextEstimate.isCritical && !wrapUpDismissed && (
            <div className={styles.wrapUpBannerWarn}>
              <svg className={styles.wrapUpIcon} viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              <div className={styles.wrapUpBody}>
                You've covered a lot of ground. Consider wrapping up the interview and generating your PRD to preserve all context.
                <div className={styles.wrapUpActions}>
                  <button
                    className={styles.wrapUpGenerateBtn}
                    onClick={() => void handleGeneratePrd()}
                    disabled={startChat.isPending || createPrd.isPending || interview.prds.length > 0}
                    type="button"
                  >
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="1" width="10" height="14" rx="1.5" />
                      <path d="M6 5h4M6 8h4M6 11h2" />
                    </svg>
                    Generate PRD Now
                  </button>
                  <button
                    className={styles.wrapUpDismissBtn}
                    onClick={() => setWrapUpDismissed(true)}
                    type="button"
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            </div>
          )}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className={styles.fileInput}
            onChange={handleAttachmentChange}
            disabled={isRunning || isSending}
          />
          <div className={styles.inputBox}>
            <textarea
              ref={textareaRef}
              className={styles.inputField}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={isRunning ? 'Agent is thinking…' : 'Continue the interview… (Enter to send)'}
              rows={1}
              disabled={isRunning || isSending}
            />
            {attachments.length > 0 && (
              <div className={styles.attachmentList}>
                {attachments.map((a) => (
                  <span key={a.id} className={styles.attachmentChip}>
                    <span className={styles.attachmentName}>{a.name}</span>
                    <span className={styles.attachmentSize}>{formatAttachmentSize(a.size)}</span>
                    <button
                      type="button"
                      className={styles.attachmentRemove}
                      onClick={() => removeAttachment(a.id)}
                      disabled={isRunning || isSending}
                      aria-label={`Remove ${a.name}`}
                    >×</button>
                  </span>
                ))}
              </div>
            )}
            {attachmentError && <div className={styles.attachmentError}>{attachmentError}</div>}
            {speech.speechError && <div className={styles.speechError}>{speech.speechError}</div>}
            <div className={styles.inputActions}>
              <button
                className={styles.attachBtn}
                onClick={() => fileInputRef.current?.click()}
                type="button"
                aria-label="Attach files"
                title="Attach files for context"
                disabled={isRunning || isSending}
              >
                <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M7 10.5l5.2-5.2a3 3 0 114.2 4.2l-6.7 6.7a5 5 0 01-7.1-7.1l6.4-6.4" />
                </svg>
              </button>
              <button
                className={`${styles.micBtn} ${speech.isListening ? styles.micBtnActive : ''}`}
                onClick={() => speech.toggle(input)}
                type="button"
                aria-label={speech.isListening ? 'Stop voice transcription' : 'Start voice transcription'}
                title={speech.isSpeechSupported
                  ? (speech.isListening ? 'Stop listening' : 'Talk to transcribe into chat')
                  : 'Speech recognition not supported in this browser'}
                disabled={!speech.isSpeechSupported || isRunning || isSending}
              >
                <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="7" y="2.5" width="6" height="10" rx="3" />
                  <path d="M4.5 9.5v0.5a5.5 5.5 0 0 0 11 0v-0.5" />
                  <path d="M10 15.5v2.5" />
                  <path d="M7.5 18h5" />
                </svg>
              </button>
              <select
                className={styles.modelSelect}
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={isRunning}
              >
                {AGENT_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
              {isRunning ? (
                <button
                  className={`${styles.sendBtn} ${styles.stopBtn}`}
                  onClick={async () => {
                    if (interview?.chatThreadId) {
                      await fetch(`/api/chat/threads/${interview.chatThreadId}/cancel`, {
                        method: 'POST', credentials: 'include',
                      });
                    }
                  }}
                  type="button"
                  aria-label="Stop"
                >
                  <svg viewBox="0 0 20 20" fill="currentColor">
                    <rect x="4" y="4" width="12" height="12" rx="2" />
                  </svg>
                </button>
              ) : (
                <div className={contextEstimate.isCritical ? styles.sendBtnCritical : undefined}>
                  {showSendConfirm && (
                    <div className={styles.sendConfirmOverlay}>
                      <div className={styles.sendConfirmText}>
                        The context window is nearly full. Sending more messages may degrade the agent's ability to process the conversation. Continue anyway?
                      </div>
                      <div className={styles.sendConfirmActions}>
                        <button
                          className={styles.sendConfirmNo}
                          onClick={() => setShowSendConfirm(false)}
                          type="button"
                        >
                          Cancel
                        </button>
                        <button
                          className={styles.sendConfirmYes}
                          onClick={() => {
                            setShowSendConfirm(false);
                            void handleSend();
                          }}
                          type="button"
                        >
                          Send anyway
                        </button>
                      </div>
                    </div>
                  )}
                  <button
                    className={styles.sendBtn}
                    onClick={() => {
                      if (contextEstimate.isCritical) {
                        setShowSendConfirm(true);
                      } else {
                        void handleSend();
                      }
                    }}
                    disabled={(!input.trim() && attachments.length === 0) || isSending}
                    type="button"
                    aria-label="Send"
                  >
                    <svg viewBox="0 0 20 20" fill="currentColor">
                      <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
                    </svg>
                  </button>
                </div>
              )}
            </div>
            {speech.isListening && (
              <div className={styles.speechStatus}>Listening… your speech is being transcribed.</div>
            )}
          </div>
        </div>
      )}

      {showDeleteModal && interview && (
        <ConfirmDeleteModal
          title="Delete Interview"
          itemName={interview.title}
          description="Are you sure you want to permanently delete the interview"
          isPending={deleteInterview.isPending}
          onConfirm={() => {
            deleteInterview.mutate(interview.id, {
              onSuccess: () => navigate('/backlog'),
            });
          }}
          onCancel={() => setShowDeleteModal(false)}
        />
      )}
    </div>
  );
};

// ── Router / entry point ──────────────────────────────────────────────────────

export const InterviewChatView: React.FC = () => {
  const location = useLocation();
  const id = location.pathname.split('/').pop();

  if (id === 'new') return <NewInterviewCompose />;
  if (!id) return null;
  return <ExistingInterviewView id={id} />;
};

export default InterviewChatView;
