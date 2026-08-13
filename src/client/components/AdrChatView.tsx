import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAppShell } from '../hooks/useAppShell';
import { useAgentChatSession } from '../hooks/useAgentChatSession';
import { useChatThread, useSkillRepos, useStartChat } from '../hooks/useChatThreads';
import type { ChatMessage } from '../../shared/types/chat';
import { useAvailableModels, useGlobalDefaultModel, useProjectSkillConfig } from '../hooks/useProjectSkillConfig';
import {
  useAdr,
  useAdrAssignments,
  useAdrComments,
  useAdrOwnerApproval,
  useAssignAdrReviewers,
  useCreateAdrComment,
  useCreateAdr,
  useDeleteAdr,
  useDeleteAdrComment,
  useFixAdrCommentWithAi,
  useFixAdrWithAi,
  useGenerateAdr,
  useReopenAdrComment,
  useReplyToAdrComment,
  useResolveAdrComment,
  useRespondToAdrOwnerApproval,
  useRespondToAdrReview,
  useUpdateAdr,
} from '../hooks/useAdrs';
import { DEFAULT_MODEL_ID } from '../config/models';
import { InterviewAgentMessage } from './InterviewChatView';
import { AgentComposer } from './agentChat';
import { AdrAssistantPanel } from './AdrAssistantPanel';
import { ProposedAdrChangesReview } from './ProposedAdrChangesReview';
import { AdrReviewerModal } from './AdrReviewerModal';
import { AnnotationLayer } from './AnnotationLayer';
import { MarkdownWithMermaid } from './MarkdownWithMermaid';
import { ReviewCommentSidebar } from './ReviewCommentSidebar';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import { useChatAttachments, formatAttachmentSize } from '../hooks/useChatAttachments';
import { useSpeechInput } from '../hooks/useSpeechInput';
import {
  PROJECT_REPOSITORY_NOT_READY_MESSAGE,
  useProjectRepositoryReadiness,
} from '../hooks/useProjectRepositoryReadiness';
import { useGroundingResumeGate } from '../hooks/useGroundingResumeGate';
import { GroundingResumeCard } from './GroundingResumeCard';
import { parseAgentMessage, type ChoiceBlock } from '../utils/parseAgentMessage';
import type { ReviewSectionKey, TextSelector } from '../../shared/types/reviewComments';
import styles from './InterviewChatView.module.css';

function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds.toString().padStart(2, '0')}s` : `${seconds}s`;
}

type AdrKickoffLocationState = {
  kickoffPrompt?: string;
};

const NewAdrCompose: React.FC = () => {
  const [title, setTitle] = useState('');
  const [input, setInput] = useState('');
  const [model, setModel] = useState(DEFAULT_MODEL_ID);
  const [error, setError] = useState<string | null>(null);
  const [showReviewerModal, setShowReviewerModal] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const { selectedProject, selectedSkillSettingsId, authenticatedUser } = useAppShell();
  const navigate = useNavigate();
  const { data: skillConfig } = useProjectSkillConfig(selectedProject || null, selectedSkillSettingsId);
  const { data: repos = [] } = useSkillRepos(selectedProject || null);
  const { data: globalDefault } = useGlobalDefaultModel();
  const { data: models = [] } = useAvailableModels();
  const startChat = useStartChat();
  const createAdr = useCreateAdr();
  const repoReadiness = useProjectRepositoryReadiness(skillConfig?.id, selectedProject || null);
  const {
    attachments,
    attachmentError,
    addFiles,
    removeAttachment,
    clearAttachments,
  } = useChatAttachments();
  const speech = useSpeechInput(useCallback((text: string) => setInput(text), []));

  const repo = skillConfig?.skillRepo
    ?? repos.find((candidate) => candidate.name.toLowerCase() === selectedProject.toLowerCase())?.name
    ?? repos[0]?.name;
  const branch = skillConfig?.skillBranch
    ?? repos.find((candidate) => candidate.name === repo)?.defaultBranch
    ?? 'main';
  const pending = startChat.isPending || createAdr.isPending;
  const queryClient = useQueryClient();

  useEffect(() => {
    titleInputRef.current?.focus();
  }, []);

  useEffect(() => {
    setModel(skillConfig?.adrModel ?? globalDefault?.value ?? DEFAULT_MODEL_ID);
  }, [skillConfig?.adrModel, globalDefault?.value]);

  const handleStart = useCallback(() => {
    if (!title.trim() || (!input.trim() && attachments.length === 0) || !repo || pending) return;
    if (!repoReadiness.isReady) {
      setError(repoReadiness.message ?? PROJECT_REPOSITORY_NOT_READY_MESSAGE);
      return;
    }
    if (speech.isListening) speech.stop();
    setError(null);
    setShowReviewerModal(true);
  }, [title, input, attachments.length, repo, pending, speech, repoReadiness.isReady, repoReadiness.message]);

  const handleCreateAdr = useCallback(async (reviewerIds: string[]) => {
    if (!title.trim() || (!input.trim() && attachments.length === 0) || !repo || pending) return;
    if (!repoReadiness.isReady) {
      setShowReviewerModal(false);
      setError(repoReadiness.message ?? PROJECT_REPOSITORY_NOT_READY_MESSAGE);
      return;
    }
    setError(null);
    const kickoffPrompt = input.trim() || 'Please use the attached files as context.';
    try {
      const thread = await startChat.mutateAsync({
        kickoff: {
          project: selectedProject,
          repo,
          branch,
          skillProvider: skillConfig?.skillProvider,
          skillPath: skillConfig?.adrInterviewSkillPath ?? '.cursor/skills/adr-interview/SKILL.md',
          model,
          skillSettingsId: skillConfig?.id,
        },
        skipAutoKickoff: true,
      });
      const adr = await createAdr.mutateAsync({
        project: selectedProject,
        repo,
        title: title.trim(),
        chatThreadId: thread.threadId,
        model,
        skillSettingsId: skillConfig?.id,
        reviewerIds,
      });
      const response = await fetch(`/api/chat/threads/${thread.threadId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          text: kickoffPrompt,
          attachments,
          model,
        }),
      });
      if (!response.ok) throw new Error('Failed to start the ADR interview');
      clearAttachments();
      await queryClient.invalidateQueries({ queryKey: ['chat-thread', thread.threadId] });
      navigate(`/adr/${adr.adrId}`, {
        state: { kickoffPrompt } satisfies AdrKickoffLocationState,
      });
    } catch (caught) {
      setShowReviewerModal(false);
      setError(caught instanceof Error ? caught.message : 'Failed to start ADR');
    }
  }, [title, input, attachments, repo, pending, startChat, selectedProject, branch, skillConfig, model, createAdr, clearAttachments, navigate, queryClient, repoReadiness.isReady, repoReadiness.message]);

  const handleAttachmentChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) void addFiles(event.target.files);
    event.target.value = '';
  }, [addFiles]);

  return (
    <div className={styles.composeContainer}>
      <button
        className={styles.backBtn}
        onClick={() => navigate('/adr')}
        type="button"
        {...{ 'data-testid': 'adr-compose-back' }}
      >
        ← Back
      </button>
      <div className={styles.composeInner}>
        <h1 className={styles.composeHeading}>What architecture decision needs to be made?</h1>
        <div className={styles.composePills}>
          <span className={styles.composePill}>{selectedProject}</span>
          {repo && <span className={styles.composePill}>{repo}</span>}
          <span className={`${styles.composePill} ${styles.composePillSkill}`}>✨ ADR Interview</span>
        </div>
        <div className={styles.composeInputBox}>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".txt,.pdf,.docx,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/*"
            className={styles.fileInput}
            onChange={handleAttachmentChange}
            disabled={pending}
            {...{ 'data-testid': 'adr-compose-file-input' }}
          />
          <div className={styles.composeTitleRow}>
            <label className={styles.composeTitleLabel} htmlFor="adr-title">Title</label>
            <input
              id="adr-title"
              ref={titleInputRef}
              className={styles.composeTitleInput}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Short decision title"
              {...{ 'data-testid': 'adr-compose-title' }}
            />
          </div>
          <textarea
            className={styles.composeTextarea}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Describe what is being built or refactored, the decision to resolve, and known constraints."
            rows={5}
            {...{ 'data-testid': 'adr-compose-message' }}
          />
          {attachments.length > 0 && (
            <div className={styles.attachmentList}>
              {attachments.map((attachment) => (
                <span key={attachment.id} className={styles.attachmentChip}>
                  <span className={styles.attachmentName}>{attachment.name}</span>
                  <span className={styles.attachmentSize}>{formatAttachmentSize(attachment.size)}</span>
                  <button
                    className={styles.attachmentRemove}
                    type="button"
                    onClick={() => removeAttachment(attachment.id)}
                    disabled={pending}
                    aria-label={`Remove ${attachment.name}`}
                    {...{ 'data-testid': `adr-attachment-remove-${attachment.id}` }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          {attachmentError && <div className={styles.attachmentError}>{attachmentError}</div>}
          {error && <div className={styles.composeError}>{error}</div>}
          {speech.speechError && <div className={styles.speechError}>{speech.speechError}</div>}
          <div className={styles.inputActions}>
            <button
              className={styles.attachBtn}
              onClick={() => fileInputRef.current?.click()}
              type="button"
              aria-label="Attach files"
              title="Attach files for context"
              disabled={pending}
              {...{ 'data-testid': 'adr-compose-attach' }}
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
              disabled={!speech.isSpeechSupported || pending}
              {...{ 'data-testid': 'adr-compose-microphone' }}
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
              onChange={(event) => setModel(event.target.value)}
              {...{ 'data-testid': 'adr-compose-model' }}
            >
              {models.length ? models.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>) : <option value={model}>{model}</option>}
            </select>
            <button
              className={styles.sendBtn}
              type="button"
              aria-label="Start ADR"
              disabled={!title.trim() || (!input.trim() && attachments.length === 0) || !repo || pending || !repoReadiness.isReady}
              onClick={() => void handleStart()}
              {...{ 'data-testid': 'adr-compose-start' }}
            >
              {pending ? '…' : '→'}
            </button>
          </div>
          {speech.isListening && <div className={styles.speechStatus}>Listening… your speech is being transcribed.</div>}
        </div>
        {!repoReadiness.isReady && repoReadiness.message && (
          <div className={styles.composeError} {...{ 'data-testid': 'adr-compose-repo-not-ready' }}>
            {repoReadiness.message}
          </div>
        )}
      </div>
      {showReviewerModal && (
        <AdrReviewerModal
          project={selectedProject}
          ownerName={authenticatedUser?.name ?? 'You'}
          isSubmitting={pending}
          onCancel={() => setShowReviewerModal(false)}
          onConfirm={(reviewerIds) => void handleCreateAdr(reviewerIds)}
          {...{ 'data-testid': 'adr-reviewer-modal' }}
        />
      )}
    </div>
  );
};

const ExistingAdrView: React.FC<{ id: string }> = ({ id }) => {
  const [input, setInput] = useState('');
  const [model, setModel] = useState(DEFAULT_MODEL_ID);
  const [error, setError] = useState<string | null>(null);
  const [generationNow, setGenerationNow] = useState(Date.now());
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [pendingSelector, setPendingSelector] = useState<{ sectionKey: ReviewSectionKey; selector: TextSelector } | null>(null);
  const [newCommentBody, setNewCommentBody] = useState('');
  const [fixingCommentId, setFixingCommentId] = useState<string | null>(null);
  const [reviewerModalOpen, setReviewerModalOpen] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const commentInputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const kickoffFromNav = (location.state as AdrKickoffLocationState | null)?.kickoffPrompt?.trim() || null;
  const [seededKickoffPrompt, setSeededKickoffPrompt] = useState<string | null>(kickoffFromNav);
  const { can, userId } = useAppShell();
  const { data: adr, isLoading, isError } = useAdr(id);
  const { data: reviewConfig } = useProjectSkillConfig(adr?.project);
  const { data: models = [], isLoading: modelsLoading } = useAvailableModels();
  const { data: assignments = [] } = useAdrAssignments(id);
  const { data: reviewComments = [] } = useAdrComments(id);
  const { data: ownerApproval } = useAdrOwnerApproval(id);
  const {
    data: thread,
    isLoading: isChatThreadLoading,
    isError: isChatThreadError,
  } = useChatThread(adr?.chatThreadId ?? null);
  const session = useAgentChatSession(adr?.chatThreadId ?? null, {
    initialMessages: thread?.messages,
    initialStatus: thread?.status,
    enablePreparationState: adr?.status === 'in_progress',
  });
  const {
    messages,
    visibleMessages: sessionVisibleMessages,
    streamingText,
    progressLabel,
    progressPhase,
    isPreparing,
    hasPreparationError,
  } = session;
  const {
    attachments,
    attachmentError,
    addFiles,
    removeAttachment,
    clearAttachments,
  } = useChatAttachments();
  const speech = useSpeechInput(useCallback((text: string) => setInput(text), []));
  const generateAdr = useGenerateAdr();
  const updateAdr = useUpdateAdr();
  const deleteAdr = useDeleteAdr();
  const createComment = useCreateAdrComment(id);
  const replyToComment = useReplyToAdrComment(id);
  const resolveComment = useResolveAdrComment(id);
  const reopenComment = useReopenAdrComment(id);
  const deleteComment = useDeleteAdrComment(id);
  const respondToReview = useRespondToAdrReview(id);
  const respondToOwnerApproval = useRespondToAdrOwnerApproval(id);
  const assignReviewers = useAssignAdrReviewers(id);
  const fixWithAi = useFixAdrWithAi(id);
  const fixCommentWithAi = useFixAdrCommentWithAi(id);
  const isRunning = session.isRunning || thread?.status === 'running';
  const isInteractionBusy = session.isInteractionBusy || isRunning;
  const resumeGate = useGroundingResumeGate(
    'adr',
    id,
    adr?.project ?? null,
    isRunning,
  );
  const isAgentProcessing = isRunning || session.isSending || session.isAwaitingAgentResponse;
  const isAuthor = adr?.authorId === userId;
  const chatLocked = !isAuthor || adr?.status !== 'in_progress';

  useEffect(() => {
    if (!kickoffFromNav) return;
    navigate(location.pathname, { replace: true, state: {} });
  }, [kickoffFromNav, location.pathname, navigate]);

  useEffect(() => {
    if (adr?.model) setModel(adr.model);
  }, [adr?.id, adr?.model]);

  const handleAddComment = useCallback((sectionKey: ReviewSectionKey, selector: TextSelector) => {
    setPendingSelector({ sectionKey, selector });
    setNewCommentBody('');
  }, []);

  const handleSubmitComment = useCallback(async () => {
    if (!pendingSelector || !newCommentBody.trim()) return;
    await createComment.mutateAsync({
      sectionKey: pendingSelector.sectionKey,
      selector: pendingSelector.selector,
      body: newCommentBody.trim(),
    });
    setPendingSelector(null);
    setNewCommentBody('');
  }, [createComment, newCommentBody, pendingSelector]);

  const handleFixComment = useCallback(async (commentId: string) => {
    setFixingCommentId(commentId);
    try {
      await fixCommentWithAi.mutateAsync({ commentId });
    } finally {
      setFixingCommentId(null);
    }
  }, [fixCommentWithAi]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, streamingText]);

  useEffect(() => {
    if (!pendingSelector) return;
    commentInputRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPendingSelector(null);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [pendingSelector]);

  useEffect(() => {
    if (adr?.status !== 'generating') return;
    setGenerationNow(Date.now());
    const intervalId = window.setInterval(() => setGenerationNow(Date.now()), 1_000);
    return () => window.clearInterval(intervalId);
  }, [adr?.status]);

  const send = useCallback(async (text: string) => {
    if (!adr || isInteractionBusy || chatLocked || resumeGate.composerBlocked) return;
    if (!text.trim() && attachments.length === 0) return;
    const payload = text.trim();
    const pendingAttachments = attachments;
    setInput('');
    clearAttachments();
    setError(null);
    await session.send(payload, { model, attachments: pendingAttachments });
    if (session.sendError) setError(session.sendError);
  }, [adr, attachments, chatLocked, clearAttachments, isInteractionBusy, model, resumeGate.composerBlocked, session]);

  const cancelActiveRun = useCallback(async () => {
    setError(null);
    await session.cancel();
  }, [session]);

  const handleAttachmentChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    void addFiles(event.target.files);
    event.target.value = '';
  }, [addFiles]);

  const visibleMessages = useMemo(() => {
    const filtered = sessionVisibleMessages.filter(
      (message) => message.toolName !== '_reasoning' && message.toolName !== '_thinking',
    );
    if (!seededKickoffPrompt) return filtered;
    const hasKickoffEcho = filtered.some(
      (message) => message.role === 'user' && message.text === seededKickoffPrompt,
    );
    if (hasKickoffEcho) return filtered;
    const seed: ChatMessage = {
      id: 'adr-seeded-kickoff',
      role: 'user',
      text: seededKickoffPrompt,
      ts: new Date().toISOString(),
    };
    return [...filtered, seed];
  }, [sessionVisibleMessages, seededKickoffPrompt]);

  useEffect(() => {
    if (!seededKickoffPrompt) return;
    const hasKickoffEcho = sessionVisibleMessages.some(
      (message) => message.role === 'user' && message.text === seededKickoffPrompt,
    );
    if (hasKickoffEcho) setSeededKickoffPrompt(null);
  }, [seededKickoffPrompt, sessionVisibleMessages]);

  if (isLoading) return <div className={styles.loadingState}>Loading ADR…</div>;
  if (isError || !adr) return <div className={styles.errorState}>ADR not found.</div>;

  const unresolvedCount = reviewComments.filter((comment) => comment.status === 'open').length;
  const currentAssignment = assignments.find((assignment) => assignment.approverUserId === userId);
  const isAssignedReviewer = !!currentAssignment;
  const approvalMode = reviewConfig?.approvalMode ?? 'any_one';
  const reviewerApprovalComplete = assignments.length === 0
    ? true
    : approvalMode === 'all_required'
      ? assignments.every((assignment) => assignment.status === 'approved')
      : assignments.some((assignment) => assignment.status === 'approved');
  const canReviewAdr = can('adr:review') && isAssignedReviewer && !isAuthor && adr.status === 'proposed';
  const showCommentLayer = (adr.status === 'proposed' || adr.status === 'accepted')
    && (isAssignedReviewer || isAuthor);
  const ownerCanFinalize = isAuthor
    && adr.status === 'proposed'
    && reviewerApprovalComplete
    && unresolvedCount === 0
    && adr.proposedContent == null;
  const reviewerNames = adr.reviewers.length > 0
    ? adr.reviewers.map((reviewer) => reviewer.displayName).join(', ')
    : 'None';
  const approvalSummary = assignments.length === 0
    ? 'No reviewer approval required'
    : `${assignments.filter((assignment) => assignment.status === 'approved').length}/${assignments.length} reviewer approvals`;

  const awaitingFirstAgentReply = Boolean(
    adr.status === 'in_progress'
    && !streamingText
    && !visibleMessages.some((message) => message.role === 'agent')
    && (
      isPreparing
      || isAgentProcessing
      || isChatThreadLoading
      || thread?.status === 'running'
      || Boolean(seededKickoffPrompt)
      || visibleMessages.some((message) => message.role === 'user')
    ),
  );
  const showPreparationState = awaitingFirstAgentReply;

  let lastUserIndex = -1;
  visibleMessages.forEach((message, index) => {
    if (message.role === 'user') lastUserIndex = index;
  });
  let runningQCount = 0;
  const messageQOffsets = new Map<string, number>();
  for (const message of visibleMessages) {
    if (message.role === 'agent') {
      messageQOffsets.set(message.id, runningQCount);
      const parts = parseAgentMessage(message.text);
      runningQCount += parts.filter((part): part is ChoiceBlock => part.type === 'choices').length;
    }
  }
  const generationStartedAt = Date.parse(adr.updatedAt);
  const generationElapsed = Number.isFinite(generationStartedAt)
    ? formatElapsed(generationNow - generationStartedAt)
    : null;

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <button
            className={styles.backBtn}
            onClick={() => navigate('/adr')}
            type="button"
            {...{ 'data-testid': 'adr-back-btn' }}
          >
            ← Back
          </button>
          <div className={styles.titleBlock}>
            <h1 className={styles.title}>{adr.title}</h1>
            <div className={styles.titleMeta}>
              {adr.project} · {adr.repo} · {adr.status.replace('_', ' ')} · Owner: {adr.ownerName} · Reviewers: {reviewerNames} · Model: {adr.model ?? 'Default'}
            </div>
          </div>
        </div>
        <div className={styles.actions}>
          {isAuthor && adr.status === 'in_progress' && can('adr:edit') && (
            <button
              className={styles.actionBtnPrimary}
              type="button"
              disabled={isRunning || generateAdr.isPending}
              onClick={() => generateAdr.mutate(id)}
              {...{ 'data-testid': 'adr-generate-btn' }}
            >
              {generateAdr.isPending ? 'Generating…' : 'Generate ADR'}
            </button>
          )}
          {isAuthor && adr.status === 'proposed' && can('adr:edit') && (
            <>
              <button
                className={styles.actionBtn}
                type="button"
                onClick={() => setReviewerModalOpen(true)}
                {...{ 'data-testid': 'adr-manage-reviewers-btn' }}
              >
                Manage Reviewers
              </button>
              <button
                className={styles.actionBtn}
                type="button"
                aria-expanded={assistantOpen}
                onClick={() => setAssistantOpen((open) => !open)}
                {...{ 'data-testid': 'adr-assistant-toggle-btn' }}
              >
                ADR Apex Assistant
              </button>
              <button
                className={styles.actionBtn}
                type="button"
                disabled={!ownerCanFinalize || respondToOwnerApproval.isPending}
                title={
                  adr.proposedContent != null
                    ? 'Apply or reject the proposed edits before accepting the ADR'
                    : unresolvedCount > 0
                      ? 'Resolve all review comments before accepting the ADR'
                      : !reviewerApprovalComplete
                        ? 'Reviewer approval is required before final acceptance'
                        : undefined
                }
                onClick={() => {
                  setError(null);
                  respondToOwnerApproval.mutate(
                    { status: 'approved' },
                    { onError: (caught) => setError(caught.message) },
                  );
                }}
                {...{ 'data-testid': 'adr-accept-btn' }}
              >
                {respondToOwnerApproval.isPending ? 'Accepting…' : 'Accept ADR'}
              </button>
            </>
          )}
          {canReviewAdr && currentAssignment?.status !== 'approved' && (
            <>
              <button
                className={styles.actionBtnPrimary}
                type="button"
                disabled={unresolvedCount > 0 || respondToReview.isPending}
                title={unresolvedCount > 0 ? 'Resolve all review comments before approving' : undefined}
                onClick={() => respondToReview.mutate({ status: 'approved' })}
                {...{ 'data-testid': 'adr-approve-btn' }}
              >
                Approve ADR
              </button>
              <button
                className={styles.actionBtnDanger}
                type="button"
                disabled={respondToReview.isPending}
                onClick={() => respondToReview.mutate({
                  status: 'revision_requested',
                  comment: 'Revision requested by reviewer',
                })}
                {...{ 'data-testid': 'adr-request-revision-btn' }}
              >
                Request Revision
              </button>
            </>
          )}
          {isAuthor && adr.status === 'accepted' && can('adr:edit') && (
            <button
              className={styles.actionBtnDanger}
              type="button"
              onClick={() => updateAdr.mutate({ id, changes: { status: 'superseded' } })}
              {...{ 'data-testid': 'adr-mark-superseded-btn' }}
            >
              Mark Superseded
            </button>
          )}
          {isAuthor && can('adr:delete') && (
            <button
              className={styles.actionBtnDanger}
              onClick={() => setShowDeleteModal(true)}
              disabled={deleteAdr.isPending}
              type="button"
              title="Delete this ADR"
              {...{ 'data-testid': 'adr-delete-btn' }}
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="2 4 4 4 14 4" />
                <path d="M13 4l-.7 9.3A1 1 0 0 1 12.3 14H3.7a1 1 0 0 1-1-.7L2 4" />
                <path d="M6.5 7v4M9.5 7v4" />
                <path d="M5.5 4V2.7A.7.7 0 0 1 6.2 2h3.6a.7.7 0 0 1 .7.7V4" />
              </svg>
              Delete
            </button>
          )}
        </div>
      </div>
      {error && (
        <div className={styles.sendError}>
          <span>{error}</span>
          {error.toLowerCase().includes('already running') && (
            <button
              type="button"
              className={styles.sendErrorDismiss}
              onClick={() => void cancelActiveRun()}
              title="Stop the stuck agent"
              {...{ 'data-testid': 'adr-error-stop-btn' }}
            >
              Stop
            </button>
          )}
          <button
            type="button"
            className={styles.sendErrorDismiss}
            onClick={() => setError(null)}
            aria-label="Dismiss"
            {...{ 'data-testid': 'adr-error-dismiss-btn' }}
          >
            ×
          </button>
        </div>
      )}
      {adr.content && (
        <div className={styles.adrMetadataSummary}>
          <span><strong>Owner:</strong> {adr.ownerName}</span>
          <span><strong>Reviewers:</strong> {reviewerNames}</span>
          <span><strong>Model:</strong> {adr.model ?? 'Default'}</span>
          <span><strong>Review:</strong> {approvalSummary}{ownerApproval?.status === 'approved' ? ' · Owner approved' : ''}</span>
        </div>
      )}
      <ProposedAdrChangesReview
        adrId={adr.id}
        currentContent={adr.content}
        proposedContent={adr.proposedContent}
        fixCommentId={adr.fixCommentId}
      />
      {adr.content && (
        <div className={styles.adrReviewLayout}>
          <div className={styles.adrDocument}>
            {showCommentLayer ? (
              <AnnotationLayer
                sectionKey="adr"
                comments={reviewComments}
                activeCommentId={activeCommentId}
                onAddComment={handleAddComment}
                onCommentClick={setActiveCommentId}
                readOnly={adr.status === 'accepted'}
              >
                <div className={`${styles.messageBubble} ${styles.messageBubbleAssistant} ${styles.adrMarkdown}`}>
                  <MarkdownWithMermaid content={adr.content} />
                </div>
              </AnnotationLayer>
            ) : (
              <div className={`${styles.messageBubble} ${styles.messageBubbleAssistant} ${styles.adrMarkdown}`}>
                <MarkdownWithMermaid content={adr.content} />
              </div>
            )}
          </div>
          {showCommentLayer && (
            <ReviewCommentSidebar
              comments={reviewComments}
              activeCommentId={activeCommentId}
              currentUserId={userId ?? ''}
              documentAuthorUserId={adr.authorId}
              documentOwnerUserId={adr.authorId}
              isAssignedApprover={isAssignedReviewer}
              onCommentClick={setActiveCommentId}
              onReply={(commentId, body) => replyToComment.mutate({ commentId, body })}
              onResolve={(commentId) => resolveComment.mutate(commentId)}
              onReopen={(commentId) => reopenComment.mutate(commentId)}
              onDelete={(commentId) => deleteComment.mutate(commentId)}
              onFixWithAi={isAuthor && adr.status === 'proposed' ? () => fixWithAi.mutate() : undefined}
              isFixingWithAi={fixWithAi.isPending}
              fixAiError={fixWithAi.error?.message}
              onFixCommentWithAi={isAuthor && adr.status === 'proposed' ? handleFixComment : undefined}
              fixingCommentId={fixingCommentId}
            />
          )}
        </div>
      )}
      {!adr.content && adr.status === 'generating' && (
        <div className={styles.generationStage} role="status" aria-live="polite">
          <div className={styles.generationCard}>
            <div className={styles.generationSpinner} aria-hidden="true" />
            <div className={styles.generationTitle}>Generating your ADR</div>
            <p className={styles.generationDescription}>
              The architect is reviewing the interview, evaluating the trade-offs, and writing the MADR document.
            </p>
            <div className={styles.generationSteps} aria-label="Generation progress">
              <span className={`${styles.generationStep} ${styles.generationStepComplete}`}>Interview captured</span>
              <span className={`${styles.generationStep} ${styles.generationStepActive}`}>Drafting decision record</span>
              <span className={styles.generationStep}>Preparing preview</span>
            </div>
            <div className={styles.generationMeta}>
              {generationElapsed && <span>Elapsed {generationElapsed}</span>}
              <span>This page checks for the result every 5 seconds.</span>
            </div>
          </div>
        </div>
      )}
      {!adr.content && adr.status !== 'generating' && (
        <div className={styles.messages}>
          <div className={styles.messageList}>
            {hasPreparationError && (
              <div className={styles.preparationState} role="alert">
                <div className={styles.preparationErrorIcon}>!</div>
                <h2 className={styles.preparationTitle}>Unable to prepare this ADR interview</h2>
                <p className={styles.preparationDetail}>
                  {thread?.lastError ?? 'Repository preparation was interrupted. Try sending your message again.'}
                </p>
              </div>
            )}

            {visibleMessages.map((message, index) => {
              if (message.role === 'agent') {
                return (
                  <InterviewAgentMessage
                    key={message.id}
                    text={message.text}
                    onSend={(text) => void send(text)}
                    isRunning={isInteractionBusy}
                    questionOffset={messageQOffsets.get(message.id) ?? 0}
                    interviewLocked={chatLocked}
                    alreadyAnswered={index < lastUserIndex}
                  />
                );
              }
              if (message.role === 'user') {
                return <div key={message.id} className={`${styles.messageBubble} ${styles.messageBubbleUser}`}>{message.text}</div>;
              }
              return <div key={message.id} className={styles.messageBubbleSystem}>{message.text}</div>;
            })}

            {showPreparationState && (
              <div
                className={styles.preparationState}
                {...{ 'data-testid': 'adr-preparation-state' }}
              >
                <div className={styles.preparationSpinner} />
                <h2 className={styles.preparationTitle}>
                  {visibleMessages.some((message) => message.role === 'user')
                    ? 'Architect is preparing a response'
                    : 'Preparing your ADR interview'}
                </h2>
                <p
                  className={styles.preparationDetail}
                  role="status"
                  aria-live="polite"
                  {...{ 'data-testid': 'agent-run-status-label' }}
                >
                  {progressPhase === 'queued' ? (
                    <span {...{ 'data-testid': 'agent-run-status-queued' }}>
                      Queued — waiting for available worker
                    </span>
                  ) : progressPhase === 'dispatched' ? (
                    <span {...{ 'data-testid': 'agent-run-status-dispatched' }}>
                      Starting…
                    </span>
                  ) : (
                    progressLabel
                      ?? (isChatThreadError
                        ? 'The ADR service is reconnecting after a temporary interruption…'
                        : isChatThreadLoading
                          ? 'Connecting to the ADR service…'
                          : 'Setting up the workspace and repository context so your ADR interview starts grounded…')
                  )}
                </p>
              </div>
            )}

            {streamingText && (
              <div className={`${styles.messageBubble} ${styles.messageBubbleAssistant}`}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingText}</ReactMarkdown>
              </div>
            )}
            {isAgentProcessing && !streamingText && !showPreparationState && (
              <div
                className={styles.typingIndicator}
                role="status"
                aria-live="polite"
                aria-label="Architect is processing your response"
                {...{ 'data-testid': 'adr-agent-processing' }}
              >
                <span aria-hidden="true" {...{ 'data-testid': 'chat-run-spinner' }} />
                <span className={styles.typingDot} />
                <span className={styles.typingDot} />
                <span className={styles.typingDot} />
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        </div>
      )}
      {!adr.content && adr.status === 'generating' ? (
        <div className={styles.generationNotice}>
          You can leave this page safely. Return to the ADR dashboard to check its status.
        </div>
      ) : !adr.content && (chatLocked ? (
        <div className={styles.lockedNotice}>This ADR conversation is read-only.</div>
      ) : (
        <>
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
          value={input}
          onChange={setInput}
          onSend={() => void send(input)}
          onCancel={() => void cancelActiveRun()}
          disabled={isInteractionBusy || resumeGate.composerBlocked}
          isRunning={isRunning}
          isSending={session.isSending}
          isBusy={isInteractionBusy}
          isCancelling={session.isCancelling}
          placeholder={showPreparationState
            ? 'Preparing the workspace…'
            : isAgentProcessing
              ? 'Architect is thinking…'
              : 'Continue the ADR interview… (Enter to send)'}
          testIdPrefix="adr"
          allowEmptySend
          attachments={attachments}
          attachmentError={attachmentError}
          onRemoveAttachment={removeAttachment}
          onAttachClick={() => fileInputRef.current?.click()}
          speech={{
            isListening: speech.isListening,
            isSpeechSupported: speech.isSpeechSupported,
            speechError: speech.speechError,
            onToggle: () => speech.toggle(input),
          }}
          model={model}
          models={models}
          modelsLoading={modelsLoading}
          onModelChange={setModel}
          {...{ 'data-testid': 'adr-chat-composer' }}
          fileInput={(
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".txt,.pdf,.docx,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/*"
              className={styles.fileInput}
              onChange={handleAttachmentChange}
              disabled={isInteractionBusy}
            />
          )}
        />
        </>
      ))}
      {pendingSelector && (
        <div
          className={styles.commentModal}
          role="dialog"
          aria-modal="true"
          aria-labelledby="adr-comment-title"
          {...{ 'data-testid': 'adr-comment-modal' }}
        >
          <div className={styles.commentModalCard}>
            <h3 className={styles.commentModalTitle} id="adr-comment-title">Add ADR Comment</h3>
            <blockquote className={styles.commentModalQuote}>{pendingSelector.selector.exact}</blockquote>
            <textarea
              ref={commentInputRef}
              className={styles.commentModalInput}
              value={newCommentBody}
              onChange={(event) => setNewCommentBody(event.target.value)}
              placeholder="Write your review comment…"
              rows={3}
              {...{ 'data-testid': 'adr-comment-input' }}
            />
            <div className={styles.commentModalActions}>
              <button
                className={styles.actionBtn}
                type="button"
                onClick={() => setPendingSelector(null)}
                {...{ 'data-testid': 'adr-comment-cancel-btn' }}
              >
                Cancel
              </button>
              <button
                className={styles.actionBtnPrimary}
                type="button"
                disabled={!newCommentBody.trim() || createComment.isPending}
                onClick={() => void handleSubmitComment()}
                {...{ 'data-testid': 'adr-comment-post-btn' }}
              >
                {createComment.isPending ? 'Posting…' : 'Post Comment'}
              </button>
            </div>
          </div>
        </div>
      )}
      <AdrAssistantPanel
        adrId={adr.id}
        open={assistantOpen && isAuthor && adr.status === 'proposed' && can('adr:edit')}
        onClose={() => setAssistantOpen(false)}
        existingThreadId={adr.adrAssistantThreadId}
        {...{ 'data-testid': 'adr-assistant-panel' }}
      />
      {reviewerModalOpen && (
        <AdrReviewerModal
          project={adr.project}
          ownerName={adr.ownerName}
          initialReviewerIds={adr.reviewerIds}
          mode="edit"
          isSubmitting={assignReviewers.isPending}
          onCancel={() => setReviewerModalOpen(false)}
          onConfirm={(reviewerIds) => {
            setError(null);
            assignReviewers.mutate(reviewerIds, {
              onSuccess: () => setReviewerModalOpen(false),
              onError: (caught) => setError(caught.message),
            });
          }}
          {...{ 'data-testid': 'adr-reviewer-modal-edit' }}
        />
      )}
      {showDeleteModal && (
        <ConfirmDeleteModal
          title="Delete ADR"
          itemName={adr.title}
          description="Are you sure you want to permanently delete the ADR"
          isPending={deleteAdr.isPending}
          onConfirm={() => {
            deleteAdr.mutate(id, {
              onSuccess: () => navigate('/adr'),
              onError: (caught) => {
                setShowDeleteModal(false);
                setError(caught.message);
              },
            });
          }}
          onCancel={() => setShowDeleteModal(false)}
          {...{ 'data-testid': 'adr-delete-modal' }}
        />
      )}
    </div>
  );
};

export const AdrChatView: React.FC = () => {
  const location = useLocation();
  const { can, permissionsLoaded } = useAppShell();
  const id = location.pathname.split('/').pop();
  if (id === 'new') {
    if (!permissionsLoaded) return null;
    return can('adr:create') ? <NewAdrCompose /> : <Navigate to="/adr" replace />;
  }
  if (!id) return null;
  return <ExistingAdrView id={id} />;
};

export default AdrChatView;
