import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAppShell } from '../hooks/useAppShell';
import { useChatStream } from '../hooks/useChatStream';
import { useChatThread, useSkillRepos, useStartChat } from '../hooks/useChatThreads';
import { useAvailableModels, useGlobalDefaultModel, useProjectSkillConfig } from '../hooks/useProjectSkillConfig';
import {
  useAdr,
  useAdrAssignments,
  useAdrComments,
  useAdrOwnerApproval,
  useAssignAdrReviewers,
  useCreateAdrComment,
  useCreateAdr,
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
import { AdrAssistantPanel } from './AdrAssistantPanel';
import { ProposedAdrChangesReview } from './ProposedAdrChangesReview';
import { AdrReviewerModal } from './AdrReviewerModal';
import { AnnotationLayer } from './AnnotationLayer';
import { ReviewCommentSidebar } from './ReviewCommentSidebar';
import { useChatAttachments, formatAttachmentSize } from '../hooks/useChatAttachments';
import { useSpeechInput } from '../hooks/useSpeechInput';
import type { ReviewSectionKey, TextSelector } from '../../shared/types/reviewComments';
import styles from './InterviewChatView.module.css';

function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds.toString().padStart(2, '0')}s` : `${seconds}s`;
}

const NewAdrCompose: React.FC = () => {
  const [title, setTitle] = useState('');
  const [input, setInput] = useState('');
  const [model, setModel] = useState(DEFAULT_MODEL_ID);
  const [error, setError] = useState<string | null>(null);
  const [showReviewerModal, setShowReviewerModal] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { selectedProject, selectedSkillSettingsId, authenticatedUser } = useAppShell();
  const navigate = useNavigate();
  const { data: skillConfig } = useProjectSkillConfig(selectedProject || null, selectedSkillSettingsId);
  const { data: repos = [] } = useSkillRepos(selectedProject || null);
  const { data: globalDefault } = useGlobalDefaultModel();
  const { data: models = [] } = useAvailableModels();
  const startChat = useStartChat();
  const createAdr = useCreateAdr();
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

  useEffect(() => {
    setModel(skillConfig?.adrModel ?? globalDefault?.value ?? DEFAULT_MODEL_ID);
  }, [skillConfig?.adrModel, globalDefault?.value]);

  const handleStart = useCallback(() => {
    if (!title.trim() || (!input.trim() && attachments.length === 0) || !repo || pending) return;
    if (speech.isListening) speech.stop();
    setError(null);
    setShowReviewerModal(true);
  }, [title, input, attachments.length, repo, pending, speech]);

  const handleCreateAdr = useCallback(async (reviewerIds: string[]) => {
    if (!title.trim() || (!input.trim() && attachments.length === 0) || !repo || pending) return;
    setError(null);
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
          text: input.trim() || 'Please use the attached files as context.',
          attachments,
          model,
        }),
      });
      if (!response.ok) throw new Error('Failed to start the ADR interview');
      clearAttachments();
      navigate(`/adr/${adr.adrId}`);
    } catch (caught) {
      setShowReviewerModal(false);
      setError(caught instanceof Error ? caught.message : 'Failed to start ADR');
    }
  }, [title, input, attachments, repo, pending, startChat, selectedProject, branch, skillConfig, model, createAdr, clearAttachments, navigate]);

  const handleAttachmentChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) void addFiles(event.target.files);
    event.target.value = '';
  }, [addFiles]);

  return (
    <div className={styles.composeContainer}>
      <button className={styles.backBtn} onClick={() => navigate('/adr')} type="button">← Back</button>
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
          />
          <div className={styles.composeTitleRow}>
            <label className={styles.composeTitleLabel} htmlFor="adr-title">Title</label>
            <input
              id="adr-title"
              className={styles.composeTitleInput}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Short decision title"
              autoFocus
            />
          </div>
          <textarea
            className={styles.composeTextarea}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Describe what is being built or refactored, the decision to resolve, and known constraints."
            rows={5}
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
            >
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <rect x="7" y="2.5" width="6" height="10" rx="3" />
                <path d="M4.5 9.5v0.5a5.5 5.5 0 0 0 11 0v-0.5" />
                <path d="M10 15.5v2.5" />
                <path d="M7.5 18h5" />
              </svg>
            </button>
            <select className={styles.modelSelect} value={model} onChange={(event) => setModel(event.target.value)}>
              {models.length ? models.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>) : <option value={model}>{model}</option>}
            </select>
            <button
              className={styles.sendBtn}
              type="button"
              aria-label="Start ADR"
              disabled={!title.trim() || (!input.trim() && attachments.length === 0) || !repo || pending}
              onClick={() => void handleStart()}
            >
              {pending ? '…' : '→'}
            </button>
          </div>
          {speech.isListening && <div className={styles.speechStatus}>Listening… your speech is being transcribed.</div>}
        </div>
      </div>
      {showReviewerModal && (
        <AdrReviewerModal
          project={selectedProject}
          ownerName={authenticatedUser?.name ?? 'You'}
          isSubmitting={pending}
          onCancel={() => setShowReviewerModal(false)}
          onConfirm={(reviewerIds) => void handleCreateAdr(reviewerIds)}
        />
      )}
    </div>
  );
};

const ExistingAdrView: React.FC<{ id: string }> = ({ id }) => {
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [generationNow, setGenerationNow] = useState(Date.now());
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [pendingSelector, setPendingSelector] = useState<{ sectionKey: ReviewSectionKey; selector: TextSelector } | null>(null);
  const [newCommentBody, setNewCommentBody] = useState('');
  const [fixingCommentId, setFixingCommentId] = useState<string | null>(null);
  const [reviewerModalOpen, setReviewerModalOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const { can, userId } = useAppShell();
  const { data: adr, isLoading, isError } = useAdr(id);
  const { data: reviewConfig } = useProjectSkillConfig(adr?.project);
  const { data: assignments = [] } = useAdrAssignments(id);
  const { data: reviewComments = [] } = useAdrComments(id);
  const { data: ownerApproval } = useAdrOwnerApproval(id);
  const { data: thread } = useChatThread(adr?.chatThreadId ?? null);
  const { messages, streamingText, status } = useChatStream(adr?.chatThreadId ?? null, {
    initialMessages: thread?.messages,
    initialStatus: thread?.status,
  });
  const generateAdr = useGenerateAdr();
  const updateAdr = useUpdateAdr();
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
  const isRunning = status === 'running';
  const isAuthor = adr?.authorId === userId;
  const chatLocked = !isAuthor || adr?.status !== 'in_progress';

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
    if (adr?.status !== 'generating') return;
    setGenerationNow(Date.now());
    const intervalId = window.setInterval(() => setGenerationNow(Date.now()), 1_000);
    return () => window.clearInterval(intervalId);
  }, [adr?.status]);

  const send = useCallback(async (text: string) => {
    if (!adr || !text.trim() || isRunning || chatLocked) return;
    setInput('');
    setError(null);
    const response = await fetch(`/api/chat/threads/${adr.chatThreadId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ text: text.trim(), model: adr.model }),
    });
    if (!response.ok) setError('Failed to send message');
  }, [adr, isRunning, chatLocked]);

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

  const visibleMessages = messages.filter((message) =>
    !(message.role === 'user' && message.text === 'Begin.')
    && message.toolName !== '_reasoning'
    && message.toolName !== '_thinking');
  let lastUserIndex = -1;
  visibleMessages.forEach((message, index) => {
    if (message.role === 'user') lastUserIndex = index;
  });
  const generationStartedAt = Date.parse(adr.updatedAt);
  const generationElapsed = Number.isFinite(generationStartedAt)
    ? formatElapsed(generationNow - generationStartedAt)
    : null;

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <button className={styles.backBtn} onClick={() => navigate('/adr')} type="button">← Back</button>
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
              >
                Manage Reviewers
              </button>
              <button
                className={styles.actionBtn}
                type="button"
                aria-expanded={assistantOpen}
                onClick={() => setAssistantOpen((open) => !open)}
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
              >
                Request Revision
              </button>
            </>
          )}
          {isAuthor && adr.status === 'accepted' && can('adr:edit') && (
            <button className={styles.actionBtnDanger} type="button" onClick={() => updateAdr.mutate({ id, changes: { status: 'superseded' } })}>
              Mark Superseded
            </button>
          )}
        </div>
      </div>
      {error && <div className={styles.sendError}>{error}</div>}
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
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{adr.content}</ReactMarkdown>
                </div>
              </AnnotationLayer>
            ) : (
              <div className={`${styles.messageBubble} ${styles.messageBubbleAssistant} ${styles.adrMarkdown}`}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{adr.content}</ReactMarkdown>
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
            {visibleMessages.map((message, index) => {
              if (message.role === 'agent') {
                return (
                  <InterviewAgentMessage
                    key={message.id}
                    text={message.text}
                    onSend={(text) => void send(text)}
                    isRunning={isRunning}
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
            {streamingText && (
              <div className={`${styles.messageBubble} ${styles.messageBubbleAssistant}`}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamingText}</ReactMarkdown>
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
        <div className={styles.inputArea}>
          <div className={styles.inputBox}>
            <textarea
              className={styles.inputField}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void send(input);
                }
              }}
              placeholder={isRunning ? 'Architect is thinking…' : 'Continue the ADR interview…'}
              disabled={isRunning}
            />
            <button className={styles.sendBtn} type="button" disabled={!input.trim() || isRunning} onClick={() => void send(input)}>→</button>
          </div>
        </div>
      ))}
      {pendingSelector && (
        <div
          className={styles.commentModal}
          role="dialog"
          aria-modal="true"
          aria-labelledby="adr-comment-title"
          onClick={(event) => {
            if (event.target === event.currentTarget) setPendingSelector(null);
          }}
        >
          <div className={styles.commentModalCard}>
            <h3 className={styles.commentModalTitle} id="adr-comment-title">Add ADR Comment</h3>
            <blockquote className={styles.commentModalQuote}>{pendingSelector.selector.exact}</blockquote>
            <textarea
              className={styles.commentModalInput}
              value={newCommentBody}
              onChange={(event) => setNewCommentBody(event.target.value)}
              placeholder="Write your review comment…"
              rows={3}
              autoFocus
            />
            <div className={styles.commentModalActions}>
              <button className={styles.actionBtn} type="button" onClick={() => setPendingSelector(null)}>Cancel</button>
              <button
                className={styles.actionBtnPrimary}
                type="button"
                disabled={!newCommentBody.trim() || createComment.isPending}
                onClick={() => void handleSubmitComment()}
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
