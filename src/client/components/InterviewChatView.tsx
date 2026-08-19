import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate, useLocation, Navigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAppShell } from '../hooks/useAppShell';
import { useStartChat, useChatThread, useSkillList, useSkillRepos } from '../hooks/useChatThreads';
import { useProjectSkillConfig, useGlobalDefaultModel, useAvailableModels } from '../hooks/useProjectSkillConfig';
import { useAgentChatSession } from '../hooks/useAgentChatSession';
import { useChatAttachments, formatAttachmentSize } from '../hooks/useChatAttachments';
import { useProjectRepositoryReadiness } from '../hooks/useProjectRepositoryReadiness';
import {
  adrAttachmentFileName,
  buildFeatureRequestInterviewPrefillText,
  type FeatureRequestInterviewPrefill,
} from '../utils/featureRequestInterview';
import type { Adr } from '../../shared/types/adr';
import { useSpeechInput } from '../hooks/useSpeechInput';
import { useContextEstimate } from '../hooks/useContextEstimate';
import { useLinkFeatureRequestInterview } from '../hooks/useFeatureRequests';
import { usePersistStagedLinks } from '../hooks/useLinkedContext';
import { DEFAULT_MODEL_ID } from '../config/models';
import { friendlyChatProgressLabel } from '../../shared/utils/chatProgressCopy';
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
import { RunGroundingStatus } from './RunGroundingStatus';
import { GroundingResumeCard } from './GroundingResumeCard';
import { GroundingHandoffDialog } from './GroundingHandoffDialog';
import { useGroundingResumeGate } from '../hooks/useGroundingResumeGate';
import type { PipelinePinPolicy } from '../../shared/types/runGrounding';
import type { InterviewStatus } from '../../shared/types/interview';
import type { InterviewSkillOption } from '../../shared/types/projectSettings';
import { parseAgentMessage } from '../utils/parseAgentMessage';
import type { ChoiceBlock } from '../utils/parseAgentMessage';
import { trackEvent, trackException } from '../services/telemetry';
import { ReadAloudButton } from './ReadAloudButton';
import {
  LinkedContextPicker,
  type StagedLinkedContextSelection,
} from './LinkedContextPicker';
import { AgentComposer } from './agentChat';
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
            {...{ 'data-testid': `interview-choice-${opt.letter}` }}
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
        {...{ 'data-testid': 'interview-choice-other' }}
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
        {...{ 'data-testid': 'interview-choice-freeform' }}
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
  fullWidth?: boolean;
}

export const InterviewAgentMessage: React.FC<InterviewAgentMessageProps> = ({ text, onSend, isRunning, questionOffset = 0, interviewLocked = false, alreadyAnswered = false, fullWidth = false }) => {
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
      <div className={`${styles.messageBubble} ${styles.messageBubbleAssistant} ${fullWidth ? styles.assistantBubbleFullWidth : ''}`}>
        <div className={styles.bubbleActions}>
          <ReadAloudButton
            text={text}
            {...{ 'data-testid': 'interview-message-read-aloud' }}
          />
        </div>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
      </div>
    );
  }

  let questionCounter = questionOffset;
  return (
    <div className={`${styles.assistantBubble} ${fullWidth ? styles.assistantBubbleFullWidth : ''}`}>
      <div className={styles.bubbleActions}>
        <ReadAloudButton
          text={text}
          {...{ 'data-testid': 'interview-message-read-aloud' }}
        />
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
          {...{ 'data-testid': 'interview-submit-answers' }}
        >
          {isRunning ? 'Agent is thinking…' : 'Submit answers ↑'}
        </button>
      )}
      {sent && <div className={styles.choiceSentLabel}>✓ Answers sent</div>}
    </div>
  );
};

// ── New interview compose view ────────────────────────────────────────────────

interface NewInterviewLocationState {
  featureRequest?: FeatureRequestInterviewPrefill;
}

interface ExistingInterviewLocationState {
  openLinkedContext?: boolean;
  linkedContextInitialErrorText?: string;
}

interface StagedLinkFailure {
  selection: Pick<StagedLinkedContextSelection, 'type' | 'id'>;
  error: string;
}

function buildLinkedContextFailureSummary(
  failures: StagedLinkFailure[],
  stagedSelections: StagedLinkedContextSelection[],
): string {
  const details = failures.map(({ selection, error }) => {
    const staged = stagedSelections.find(
      (candidate) =>
        candidate.type === selection.type && candidate.id === selection.id,
    );
    const fallbackLabel =
      selection.type === 'adr'
        ? `ADR ${selection.id}`
        : `Design Module ${selection.id}`;
    return `${staged?.label ?? fallbackLabel}: ${error}`;
  });
  return `Some linked context could not be saved. ${details.join(' ')} The Interview was created and other valid links were saved. Open Linked Context to retry.`;
}

const NewInterviewCompose: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const featureRequest = (location.state as NewInterviewLocationState | null)?.featureRequest;
  const { selectedProject, selectedSkillSettingsId, can } = useAppShell();
  const [input, setInput] = useState(() => buildFeatureRequestInterviewPrefillText(featureRequest));
  const [title, setTitle] = useState(() => featureRequest?.title ?? '');
  const [titleTouched, setTitleTouched] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [showOwnerModal, setShowOwnerModal] = useState(false);
  const [showStagedLinkedContext, setShowStagedLinkedContext] = useState(false);
  const [model, setModel] = useState(DEFAULT_MODEL_ID);
  const [stagedLinkedContext, setStagedLinkedContext] = useState<
    StagedLinkedContextSelection[]
  >([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const stagedLinkedContextTriggerRef = useRef<HTMLButtonElement>(null);
  const stagedLinkedContextDialogRef = useRef<HTMLDialogElement>(null);
  const stagedLinkedContextWasOpenRef = useRef(false);
  const prevEffectiveDefaultRef = useRef<string>(DEFAULT_MODEL_ID);
  const featureRequestIdRef = useRef(featureRequest?.id);
  const linkedAdrSeedDoneRef = useRef(false);

  const [selectedSkillOption, setSelectedSkillOption] = useState<InterviewSkillOption | null>(null);

  const { data: repos = [] } = useSkillRepos(selectedProject || null);
  const { data: skillConfig } = useProjectSkillConfig(selectedProject || null, selectedSkillSettingsId);
  const repoReadiness = useProjectRepositoryReadiness(skillConfig?.id, selectedProject || null);
  const { data: globalDefaultModel } = useGlobalDefaultModel();
  const { data: availableModels, isLoading: modelsLoading } = useAvailableModels();

  const interviewSkillOptions = skillConfig?.interviewSkillOptions ?? [];

  useEffect(() => {
    if (interviewSkillOptions.length === 1) {
      setSelectedSkillOption(interviewSkillOptions[0]);
    } else if (interviewSkillOptions.length >= 2 && !selectedSkillOption) {
      setSelectedSkillOption(interviewSkillOptions[0]);
    }
  }, [interviewSkillOptions.length]); // eslint-disable-line react-hooks/exhaustive-deps

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
    skillConfig?.skillProvider,
  );

  const resolvedSkillPath = interviewSkillOptions.length > 0
    ? selectedSkillOption?.path
    : (skillConfig?.interviewSkillPath ?? undefined);

  const grillSkill = resolvedSkillPath
    ? skills.find((s) => s.path === resolvedSkillPath)
    : skills.find((s) => s.name === 'grill-with-docs');

  // Per-option checkbox defaults to on (undefined === checked). Do not fall back to
  // stale project-level prototypeStageEnabled when an interview skill option is selected.
  const prototypeStageEnabled = selectedSkillOption
    ? selectedSkillOption.wantsDesignPrototype !== false
    : (skillConfig?.prototypeStageEnabled !== false);
  const testCasesEnabled = selectedSkillOption?.wantsTestCases ?? true;

  const {
    attachments,
    attachmentError,
    addFiles,
    addTextAttachments,
    removeAttachment,
    clearAttachments,
  } = useChatAttachments();

  const speech = useSpeechInput(useCallback((text: string) => setInput(text), []));

  const startChat = useStartChat();
  const createInterview = useCreateInterview();
  const persistStagedLinks = usePersistStagedLinks(selectedProject);
  const { mutateAsync: linkFeatureRequestInterview } = useLinkFeatureRequestInterview();

  useEffect(() => {
    if (linkedAdrSeedDoneRef.current) return;
    const linkedAdrs = featureRequest?.linkedAdrs ?? [];
    if (linkedAdrs.length === 0) return;
    linkedAdrSeedDoneRef.current = true;

    let cancelled = false;
    void (async () => {
      try {
        const results = await Promise.all(
          linkedAdrs.map(async (adr) => {
            const res = await fetch(`/api/adr/${adr.id}`, { credentials: 'include' });
            if (!res.ok) return null;
            const body = (await res.json()) as Adr;
            if (!body.content?.trim()) return null;
            return {
              name: adrAttachmentFileName(adr),
              content: body.content,
              type: 'text/markdown',
            };
          }),
        );
        if (cancelled) return;
        const files = results.filter((file): file is NonNullable<typeof file> => file != null);
        if (files.length > 0) addTextAttachments(files);
      } catch (err) {
        console.error('[InterviewChatView] Failed to seed linked ADR attachments:', err);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [featureRequest?.linkedAdrs, addTextAttachments]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [input]);

  useEffect(() => {
    const newDefault = selectedSkillOption?.model ?? skillConfig?.interviewModel ?? globalDefaultModel?.value ?? DEFAULT_MODEL_ID;
    const prevDefault = prevEffectiveDefaultRef.current;
    prevEffectiveDefaultRef.current = newDefault;
    setModel((current) => current === prevDefault ? newDefault : current);
  }, [selectedSkillOption?.model, skillConfig?.interviewModel, globalDefaultModel?.value]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSend = useCallback(() => {
    const text = input.trim();
    const trimmedTitle = title.trim();
    if ((!text && attachments.length === 0) || isSending || !resolvedRepoName) return;
    if (!repoReadiness.isReady) {
      setSendError(repoReadiness.message);
      return;
    }
    if (!trimmedTitle) {
      setTitleTouched(true);
      titleInputRef.current?.focus();
      return;
    }
    if (speech.isListening) speech.stop();
    setSendError(null);
    setShowOwnerModal(true);
  }, [input, title, attachments, isSending, resolvedRepoName, speech, repoReadiness.isReady, repoReadiness.message]);

  const handleCreateInterview = useCallback(async (selections: { prdOwnerId?: string; designDocOwnerId?: string; designPrototypeOwnerId?: string; testCaseOwnerId?: string; prdApproverIds?: string[]; designDocApproverIds?: string[]; designPrototypeApproverIds?: string[]; testCaseApproverIds?: string[] }) => {
    const text = input.trim();
    const trimmedTitle = title.trim();
    if (!resolvedRepoName || !trimmedTitle) return;
    if (!repoReadiness.isReady) {
      setSendError(repoReadiness.message);
      setShowOwnerModal(false);
      return;
    }
    setIsSending(true);
    try {
      const threadResult = await startChat.mutateAsync({
        kickoff: {
          project: selectedProject,
          repo: resolvedRepoName,
          branch: resolvedBranch,
          skillProvider: skillConfig?.skillProvider ?? undefined,
          skillPath: resolvedSkillPath ?? grillSkill?.path,
          model,
          skillSettingsId: skillConfig?.id ?? undefined,
        },
        skipAutoKickoff: true,
      });
      const result = await createInterview.mutateAsync({
        project: selectedProject,
        repo: resolvedRepoName,
        title: trimmedTitle,
        chatThreadId: threadResult.threadId,
        model,
        skillSettingsId: skillConfig?.id ?? undefined,
        prdOwnerId: selections.prdOwnerId,
        designDocOwnerId: selections.designDocOwnerId,
        designPrototypeOwnerId: selections.designPrototypeOwnerId,
        testCaseOwnerId: selections.testCaseOwnerId,
        prdApproverIds: selections.prdApproverIds,
        designDocApproverIds: selections.designDocApproverIds,
        designPrototypeApproverIds: selections.designPrototypeApproverIds,
        testCaseApproverIds: selections.testCaseApproverIds,
        prototypeStageEnabled,
        testCasesEnabled,
      });
      let linkedContextInitialErrorText: string | undefined;
      if (stagedLinkedContext.length > 0) {
        try {
          const persistenceResult = await persistStagedLinks.mutateAsync({
            interviewId: result.interviewId,
            selections: stagedLinkedContext.map(({ type, id }) => ({
              type,
              id,
            })),
          });
          if (persistenceResult.failures.length > 0) {
            linkedContextInitialErrorText = buildLinkedContextFailureSummary(
              persistenceResult.failures,
              stagedLinkedContext,
            );
          }
        } catch (persistError: unknown) {
          const message =
            persistError instanceof Error
              ? persistError.message
              : 'Unable to save linked context.';
          linkedContextInitialErrorText =
            `Linked context could not be saved: ${message} The Interview was created. Open Linked Context to retry.`;
        }
      }
      trackEvent('interview.started', {
        interviewId: result.interviewId,
        project: selectedProject,
        repo: resolvedRepoName,
      });
      if (featureRequestIdRef.current) {
        try {
          await linkFeatureRequestInterview({
            id: featureRequestIdRef.current,
            interviewId: result.interviewId,
          });
        } catch (linkError: unknown) {
          const error = linkError instanceof Error ? linkError : new Error(String(linkError));
          console.error('[InterviewChatView] Failed to link feature request:', error);
          trackException(error, {
            context: 'interview.link-feature-request',
            featureRequestId: featureRequestIdRef.current,
            interviewId: result.interviewId,
          });
        }
      }
      await fetch(`/api/chat/threads/${threadResult.threadId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ text: text || 'Please use the attached files as context.', attachments, model }),
      });
      clearAttachments();
      if (linkedContextInitialErrorText) {
        navigate(`/backlog/interview/${result.interviewId}`, {
          state: {
            openLinkedContext: true,
            linkedContextInitialErrorText,
          },
        });
      } else {
        navigate(`/backlog/interview/${result.interviewId}`);
      }
    } catch (err: unknown) {
      trackException(err instanceof Error ? err : new Error(String(err)), {
        context: 'interview.create',
      });
      const msg = err instanceof Error ? err.message : 'Failed to start interview';
      setSendError(msg);
      setIsSending(false);
    }
  }, [input, title, attachments, resolvedRepoName, resolvedBranch, selectedProject, resolvedSkillPath, grillSkill, startChat, createInterview, persistStagedLinks, stagedLinkedContext, linkFeatureRequestInterview, navigate, clearAttachments, model, skillConfig, prototypeStageEnabled, testCasesEnabled, repoReadiness.isReady, repoReadiness.message]);

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

  const openStagedLinkedContext = useCallback(() => {
    setShowStagedLinkedContext(true);
  }, []);

  const closeStagedLinkedContext = useCallback(() => {
    setShowStagedLinkedContext(false);
  }, []);

  const handleStagedLinkedContextKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDialogElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeStagedLinkedContext();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusableElements = Array.from(
        stagedLinkedContextDialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => element.getAttribute('aria-hidden') !== 'true');
      if (focusableElements.length === 0) {
        event.preventDefault();
        return;
      }

      const first = focusableElements[0];
      const last = focusableElements[focusableElements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [closeStagedLinkedContext],
  );

  useEffect(() => {
    if (showStagedLinkedContext) {
      stagedLinkedContextDialogRef.current
        ?.querySelector<HTMLElement>('[data-testid="linked-context-close"]')
        ?.focus();
    } else if (stagedLinkedContextWasOpenRef.current) {
      stagedLinkedContextTriggerRef.current?.focus();
    }
    stagedLinkedContextWasOpenRef.current = showStagedLinkedContext;
  }, [showStagedLinkedContext]);

  return (
    <div className={styles.composeContainer}>
      <button
        className={styles.backBtn}
        onClick={() => navigate('/backlog')}
        type="button"
        {...{ 'data-testid': 'interview-compose-back' }}
      >
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

          {interviewSkillOptions.length === 0 && (
            <span className={`${styles.composePill} ${grillSkill ? styles.composePillSkill : styles.composePillError}`}>
              {grillSkill ? `✨ ${grillSkill.name}` : '⚠ No interview skill configured'}
            </span>
          )}
          {interviewSkillOptions.length === 1 && (
            <span className={`${styles.composePill} ${styles.composePillSkill}`}>
              ✨ {interviewSkillOptions[0].friendlyName}
            </span>
          )}
          {interviewSkillOptions.length >= 2 && (
            <span className={`${styles.composePill} ${styles.composePillSelect} ${styles.composePillSkill}`}>
              <span className={styles.composePillSelectLabel}>
                ✨ {selectedSkillOption?.friendlyName ?? 'Select skill…'}
              </span>
              <select
                className={styles.composePillSelectEl}
                value={selectedSkillOption?.path ?? ''}
                onChange={(e) => {
                  const opt = interviewSkillOptions.find((o) => o.path === e.target.value);
                  if (opt) setSelectedSkillOption(opt);
                }}
                disabled={isSending}
                {...{ 'data-testid': 'interview-skill-select' }}
              >
                {interviewSkillOptions.map((opt) => (
                  <option key={opt.path} value={opt.path}>{opt.friendlyName}</option>
                ))}
              </select>
              <svg className={styles.composePillChevron} viewBox="0 0 8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M1.5 3L4 5.5L6.5 3" />
              </svg>
            </span>
          )}
        </div>

        <div className={styles.composeInputBox}>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".txt,.pdf,.docx,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/*"
            className={styles.fileInput}
            onChange={handleAttachmentChange}
            disabled={isSending}
            {...{ 'data-testid': 'interview-compose-file-input' }}
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
              {...{ 'data-testid': 'interview-compose-title' }}
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
            {...{ 'data-testid': 'interview-compose-message' }}
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
                    {...{ 'data-testid': `interview-attachment-remove-${a.id}` }}
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
              {...{ 'data-testid': 'interview-compose-attach' }}
            >
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 10.5l5.2-5.2a3 3 0 114.2 4.2l-6.7 6.7a5 5 0 01-7.1-7.1l6.4-6.4" />
              </svg>
            </button>
            {selectedProject && (
              <button
                ref={stagedLinkedContextTriggerRef}
                className={`${styles.attachBtn} ${styles.linkedContextAttachBtn} ${stagedLinkedContext.length > 0 ? styles.linkedContextAttachBtnActive : ''}`}
                onClick={openStagedLinkedContext}
                type="button"
                aria-label="Select ADRs and Design Modules"
                aria-haspopup="dialog"
                aria-expanded={showStagedLinkedContext}
                title="Select ADRs and Design Modules for linked context"
                disabled={isSending}
                {...{
                  'data-testid': 'interview-compose-linked-context-trigger',
                }}
              >
                <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="2.5" y="2.5" width="7" height="7" rx="1.5" />
                  <rect x="10.5" y="10.5" width="7" height="7" rx="1.5" />
                  <path d="M8 8l4 4" />
                </svg>
                {stagedLinkedContext.length > 0 && (
                  <span
                    className={styles.linkedContextAttachCount}
                    aria-hidden="true"
                    {...{
                      'data-testid': 'interview-compose-linked-context-count',
                    }}
                  >
                    {stagedLinkedContext.length}
                  </span>
                )}
              </button>
            )}
            <button
              className={`${styles.micBtn} ${speech.isListening ? styles.micBtnActive : ''}`}
              onClick={() => speech.toggle(input)}
              type="button"
              aria-label={speech.isListening ? 'Stop voice transcription' : 'Start voice transcription'}
              title={speech.isSpeechSupported
                ? (speech.isListening ? 'Stop listening' : 'Talk to transcribe into chat')
                : 'Speech recognition not supported in this browser'}
              disabled={!speech.isSpeechSupported || isSending}
              {...{ 'data-testid': 'interview-compose-microphone' }}
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
              {...{ 'data-testid': 'interview-compose-model' }}
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
              disabled={(!input.trim() && attachments.length === 0) || isSending || !resolvedRepoName || !title.trim() || (!resolvedSkillPath && !grillSkill) || !repoReadiness.isReady}
              type="button"
              aria-label="Start interview"
              {...{ 'data-testid': 'interview-compose-start' }}
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

        {!grillSkill && !resolvedSkillPath && skillConfig && interviewSkillOptions.length === 0 && (
          <div className={styles.composeError}>
            No interview skill is configured for this repo project. Please ask an admin to set the interview skill path in project settings.
          </div>
        )}
        {!repoReadiness.isReady && repoReadiness.message && (
          <div className={styles.composeError} {...{ 'data-testid': 'interview-compose-repo-not-ready' }}>
            {repoReadiness.message}
          </div>
        )}
        {(grillSkill || resolvedSkillPath) && (
          <p className={styles.composeHint}>
            Enter to send · Shift+Enter for new line · The <strong>{selectedSkillOption?.friendlyName ?? grillSkill?.name ?? 'Interview'}</strong> skill will guide this structured interview
          </p>
        )}
      </div>

      {showStagedLinkedContext && selectedProject && (
        <div
          className={styles.linkedContextOverlay}
          {...{
            'data-testid': 'interview-compose-linked-context-overlay',
          }}
        >
          <dialog
            open
            ref={stagedLinkedContextDialogRef}
            className={styles.linkedContextPanel}
            aria-modal="true"
            aria-label="Select ADRs and Design Modules"
            onKeyDown={handleStagedLinkedContextKeyDown}
            {...{
              'data-testid': 'interview-compose-linked-context-dialog',
            }}
          >
            <LinkedContextPicker
              mode="staged"
              project={selectedProject}
              canManage={can('interviews:manage')}
              interviewStatus="in_progress"
              stagedSelections={stagedLinkedContext}
              onStagedSelectionsChange={setStagedLinkedContext}
              onClose={closeStagedLinkedContext}
            />
          </dialog>
        </div>
      )}

      {showOwnerModal && (
        <SectionOwnerModal
          project={selectedProject}
          prototypeStageEnabled={prototypeStageEnabled}
          testCasesEnabled={testCasesEnabled}
          onConfirm={(selections) => {
            setShowOwnerModal(false);
            void handleCreateInterview(selections);
          }}
          onCancel={() => {
            setShowOwnerModal(false);
          }}
          isSubmitting={isSending}
          {...{ 'data-testid': 'interview-owner-modal' }}
        />
      )}
    </div>
  );
};

// ── Existing interview chat view ──────────────────────────────────────────────

const ExistingInterviewView: React.FC<{ id: string }> = ({ id }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { can, userId, isAdmin } = useAppShell();
  const linkedContextLocationState =
    location.state as ExistingInterviewLocationState | null;

  const { data: interview, isLoading, isError } = useInterview(id);
  const { data: skillConfig } = useProjectSkillConfig(interview?.project ?? null);
  const repoReadiness = useProjectRepositoryReadiness(
    skillConfig?.id ?? interview?.skillSettingsId,
    interview?.project ?? null,
  );
  const { data: globalDefaultModel } = useGlobalDefaultModel();
  const { data: availableModels, isLoading: modelsLoading } = useAvailableModels();

  const [input, setInput] = useState('');
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [model, setModel] = useState(DEFAULT_MODEL_ID);
  const [prdGenError, setPrdGenError] = useState<string | null>(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [wrapUpDismissed, setWrapUpDismissed] = useState(false);
  const [showSendConfirm, setShowSendConfirm] = useState(false);
  const [showLinkedContext, setShowLinkedContext] = useState(
    Boolean(linkedContextLocationState?.openLinkedContext),
  );
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const linkedContextTriggerRef = useRef<HTMLButtonElement>(null);
  const linkedContextPanelRef = useRef<HTMLDialogElement>(null);
  const linkedContextWasOpenRef = useRef(false);

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
    skillConfig?.skillProvider,
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

  const {
    data: chatThread,
    isLoading: isChatThreadLoading,
    isError: isChatThreadError,
  } = useChatThread(interview?.chatThreadId ?? null);

  const session = useAgentChatSession(interview?.chatThreadId ?? null, {
    initialMessages: chatThread?.messages,
    initialStatus: chatThread?.status,
    enablePreparationState: interview?.status === 'in_progress',
    beforeSend: () => {
      if (!repoReadiness.isReady) {
        throw new Error(repoReadiness.message ?? 'Repository is not ready');
      }
    },
  });

  const {
    messages,
    visibleMessages: visibleMessagesForContext,
    streamingText,
    isRunning,
    isSending,
    isRetrying,
    retryReason,
    progressLabel,
    progressPhase,
    isPreparing: isPreparingInterview,
    hasPreparationError,
    isInteractionBusy,
    sendError,
    clearSendError,
  } = session;

  const isAgentProcessing = isRunning || isSending || session.isAwaitingAgentResponse;
  const resumeGate = useGroundingResumeGate(
    'interview',
    interview?.id ?? id,
    interview?.project ?? null,
    isRunning,
  );
  const [handoffOpen, setHandoffOpen] = useState(false);
  const draftAttachmentChars = attachments.reduce((sum, a) => sum + a.content.length, 0);
  const contextEstimate = useContextEstimate(
    visibleMessagesForContext, input, streamingText, model, draftAttachmentChars,
  );

  useEffect(() => {
    const resolved = chatThread?.kickoff.model ?? interview?.model;
    if (resolved) {
      setModel(resolved);
    }
  }, [chatThread?.id, interview?.id]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const openLinkedContext = useCallback(() => {
    setShowLinkedContext(true);
  }, []);

  const closeLinkedContext = useCallback(() => {
    setShowLinkedContext(false);
  }, []);

  const handleLinkedContextPanelKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDialogElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeLinkedContext();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusableElements = Array.from(
        linkedContextPanelRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => element.getAttribute('aria-hidden') !== 'true');
      if (focusableElements.length === 0) {
        event.preventDefault();
        return;
      }

      const first = focusableElements[0];
      const last = focusableElements[focusableElements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [closeLinkedContext],
  );

  useEffect(() => {
    if (showLinkedContext) {
      const closeControl =
        linkedContextPanelRef.current?.querySelector<HTMLElement>(
          '[data-testid="linked-context-close"], button[aria-label="Close linked context"]',
        );
      closeControl?.focus();
    } else if (linkedContextWasOpenRef.current) {
      linkedContextTriggerRef.current?.focus();
    }
    linkedContextWasOpenRef.current = showLinkedContext;
  }, [showLinkedContext]);

  const sendMessageToAgent = useCallback(async (
    text: string,
    includeDraftAttachments: boolean,
  ) => {
    const outgoingAttachments = includeDraftAttachments ? attachments : [];
    if (
      (!text && outgoingAttachments.length === 0)
      || isInteractionBusy
      || !interview?.chatThreadId
      || resumeGate.composerBlocked
    ) return;

    if (speech.isListening) speech.stop();
    setInput('');
    clearSendError();
    await session.send(text || 'Please use the attached files as context.', {
      attachments: outgoingAttachments,
      model,
    });
    if (includeDraftAttachments) clearAttachments();
  }, [
    attachments,
    clearAttachments,
    clearSendError,
    isInteractionBusy,
    interview?.chatThreadId,
    model,
    resumeGate.composerBlocked,
    session,
    speech,
  ]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text && attachments.length === 0) return;
    await sendMessageToAgent(text, true);
  }, [attachments.length, input, sendMessageToAgent]);

  const handleRetryLast = useCallback(() => {
    session.retryLast();
  }, [session]);

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

  const handleGeneratePrd = useCallback(async (groundingPolicy: PipelinePinPolicy = 'inherit') => {
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

      // Create the row and watcher before starting the agent so kickoff is
      // deterministic and output cannot beat PRD persistence.
      const prdModel = skillConfig?.prdModel ?? globalDefaultModel?.value ?? DEFAULT_MODEL_ID;
      const threadResult = await startChat.mutateAsync({
        kickoff: {
          project: interview.project,
          repo: resolvedPrdRepo ?? interview.repo,
          branch: resolvedPrdBranch,
          skillProvider: skillConfig?.skillProvider ?? undefined,
          skillPath,
          transcript,
          model: prdModel,
          skillSettingsId: interview.skillSettingsId ?? skillConfig?.id ?? undefined,
        },
        skipAutoKickoff: true,
      });

      const prdResult = await createPrd.mutateAsync({
        interviewId: id,
        chatThreadId: threadResult.threadId,
        title: interview.title,
        model: prdModel,
        kickoffGeneration: true,
        groundingPolicy,
      });
      navigate(`/backlog/prd/${prdResult.prdId}`);
    } catch (err: unknown) {
      trackException(err instanceof Error ? err : new Error(String(err)), {
        context: 'interview.generatePrd',
        interviewId: id,
      });
      const msg = err instanceof Error ? err.message : 'Failed to generate PRD';
      setPrdGenError(msg);
    }
  }, [id, interview, messages, toPrdSkill, skillConfig?.prdModel, globalDefaultModel?.value, startChat, createPrd, navigate]);

  const requestGeneratePrd = useCallback(() => {
    if (resumeGate.status) {
      setHandoffOpen(true);
      return;
    }
    void handleGeneratePrd('inherit');
  }, [handleGeneratePrd, resumeGate.status]);

  if (isLoading) return <div className={styles.loadingState}>Loading interview…</div>;
  if (isError || !interview) return <div className={styles.errorState}>Interview not found.</div>;

  const visibleMessages = messages.filter((m) =>
    !(m.role === 'user' && m.text === 'Begin.') &&
    m.toolName !== '_reasoning' && m.toolName !== '_thinking'
  );
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
          <button
            className={styles.backBtn}
            onClick={() => navigate('/backlog')}
            type="button"
            {...{ 'data-testid': 'interview-back' }}
          >
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
                  {...{ 'data-testid': 'interview-title-input' }}
                />
              ) : (
                <h1
                  className={styles.title}
                  onClick={canManage ? startTitleEdit : undefined}
                  title={canManage ? 'Click to rename' : undefined}
                  {...{ 'data-testid': 'interview-title' }}
                >
                  {interview.title}
                </h1>
              )}
              <span
                className={`${styles.badge} ${badgeClass(interview.status)}`}
                {...{ 'data-testid': 'interview-status-badge' }}
              >
                {badgeLabel(interview.status)}
              </span>
            </div>
            <div className={styles.titleMeta}>
              <span>{interview.project}</span>
              <span className={styles.titleMetaSep}>·</span>
              <span>{interview.repo}</span>
              {interview.model && (
                <>
                  <span className={styles.titleMetaSep}>·</span>
                  <span>Model: {interview.model}</span>
                </>
              )}
            </div>
            {(interview.prdOwnerName || interview.designDocOwnerName || interview.designPrototypeOwnerName) && (
              <div className={styles.ownerChips} {...{ 'data-testid': 'interview-owner-chips' }}>
                {interview.prdOwnerName && (
                  <span className={styles.ownerChip} {...{ 'data-testid': 'interview-owner-chip-prd' }}>
                    PRD: {interview.prdOwnerName}
                  </span>
                )}
                {interview.designDocOwnerName && (
                  <span className={styles.ownerChip} {...{ 'data-testid': 'interview-owner-chip-design-doc' }}>
                    Design Doc: {interview.designDocOwnerName}
                  </span>
                )}
                {interview.designPrototypeOwnerName && (
                  <span className={styles.ownerChip} {...{ 'data-testid': 'interview-owner-chip-prototype' }}>
                    Design Prototype: {interview.designPrototypeOwnerName}
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
                    {...{ 'data-testid': `interview-prd-link-${prd.id}` }}
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
            <RunGroundingStatus
              surface="interview"
              domainRunId={interview.id}
              project={interview.project}
            />
          </div>
        </div>

        <div className={styles.headerRight}>
          <button
            ref={linkedContextTriggerRef}
            className={styles.actionBtn}
            type="button"
            aria-haspopup="dialog"
            aria-expanded={showLinkedContext}
            onClick={openLinkedContext}
            {...{ 'data-testid': 'interview-linked-context-trigger' }}
          >
            Linked Context
          </button>
          {canManage && (
            <div className={styles.actions}>
              {interview.status === 'in_progress' && (
                <button
                  className={styles.actionBtn}
                  onClick={() => void handleStatusChange('complete')}
                  disabled={updateStatus.isPending}
                  type="button"
                  title="Mark this interview as complete"
                  {...{ 'data-testid': 'complete-interview-btn' }}
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
                  {...{ 'data-testid': 'reopen-interview-btn' }}
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
                  {...{ 'data-testid': 'archive-interview-btn' }}
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
                  onClick={requestGeneratePrd}
                  disabled={startChat.isPending || createPrd.isPending || interview.prds.length > 0}
                  type="button"
                  title={interview.prds.length > 0 ? 'A PRD has already been generated for this interview' : 'Generate a PRD from this interview'}
                  {...{ 'data-testid': 'generate-prd-btn' }}
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
                {...{ 'data-testid': 'delete-interview-btn' }}
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

      {(sendError || prdGenError || (!repoReadiness.isReady && repoReadiness.message)) && (
        <div className={styles.sendError} {...{ 'data-testid': 'interview-repo-not-ready' }}>
          {sendError ?? prdGenError ?? repoReadiness.message}
          {(sendError || prdGenError) && (
            <button
              type="button"
              className={styles.sendErrorDismiss}
              onClick={() => { clearSendError(); setPrdGenError(null); }}
              aria-label="Dismiss error"
              {...{ 'data-testid': 'interview-dismiss-error' }}
            >×</button>
          )}
        </div>
      )}

      <div className={styles.messages}>
        <div className={styles.messageList}>
          {hasPreparationError && (
            <div className={styles.preparationState} role="alert">
              <div className={styles.preparationErrorIcon}>!</div>
              <h2 className={styles.preparationTitle}>Unable to prepare this interview</h2>
              <p className={styles.preparationDetail}>
                {chatThread?.lastError ?? 'Repository preparation was interrupted. Try sending your message again.'}
              </p>
            </div>
          )}

          {isPreparingInterview && (
            <div
              className={styles.preparationState}
              {...{ 'data-testid': 'interview-preparation-state' }}
            >
              <div className={styles.preparationSpinner} />
              <h2 className={styles.preparationTitle}>Preparing your interview</h2>
              <p
                className={styles.preparationDetail}
                role="status"
                aria-live="polite"
                {...{ 'data-testid': 'agent-run-status-label' }}
              >
                {progressPhase === 'queued' ? (
                  <span {...{ 'data-testid': 'agent-run-status-queued' }}>
                    {friendlyChatProgressLabel(progressLabel, 'queued')}
                  </span>
                ) : progressPhase === 'dispatched' ? (
                  <span {...{ 'data-testid': 'agent-run-status-dispatched' }}>
                    {friendlyChatProgressLabel(progressLabel, 'dispatched')}
                  </span>
                ) : progressLabel ? (
                  friendlyChatProgressLabel(progressLabel, progressPhase)
                ) : isChatThreadError ? (
                  'The interview service is reconnecting after a temporary interruption…'
                ) : isChatThreadLoading ? (
                  'Connecting to the interview service…'
                ) : (
                  friendlyChatProgressLabel(
                    'Getting the latest repository requirements so your interview starts with current context…',
                    'setup'
                  )
                )}
              </p>
            </div>
          )}

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
                    <span
                      className={styles.systemErrorText}
                      role="alert"
                      {...{ 'data-testid': 'chat-run-terminal' }}
                    >
                      {msg.text}
                    </span>
                    <button
                      className={styles.retryBtn}
                      onClick={() => handleRetryLast()}
                      disabled={isInteractionBusy}
                      type="button"
                      {...{ 'data-testid': 'interview-retry-message' }}
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
                  void sendMessageToAgent(text, false);
                }}
                isRunning={isInteractionBusy}
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

          {isAgentProcessing && !streamingText && !isRetrying && (
            <div
              className={styles.typingIndicator}
              role="status"
              aria-live="polite"
              aria-label="Agent is processing your response"
              {...{ 'data-testid': 'interview-agent-processing' }}
            >
              <span aria-hidden="true" {...{ 'data-testid': 'chat-run-spinner' }} />
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
        <div className={styles.lockedNotice} {...{ 'data-testid': 'locked-notice' }}>
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
              {...{ 'data-testid': 'interview-locked-reopen' }}
            >
              Reopen
            </button>
          )}
        </div>
      ) : (
        <div className={styles.inputArea}>
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
                    onClick={requestGeneratePrd}
                    disabled={startChat.isPending || createPrd.isPending || interview.prds.length > 0}
                    type="button"
                    {...{ 'data-testid': 'interview-context-generate-prd-critical' }}
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
                    onClick={requestGeneratePrd}
                    disabled={startChat.isPending || createPrd.isPending || interview.prds.length > 0}
                    type="button"
                    {...{ 'data-testid': 'interview-context-generate-prd-warning' }}
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
                    {...{ 'data-testid': 'interview-context-dismiss-warning' }}
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
            accept=".txt,.pdf,.docx,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,image/*"
            className={styles.fileInput}
            onChange={handleAttachmentChange}
            disabled={isInteractionBusy || isSending}
            {...{ 'data-testid': 'interview-file-input' }}
          />
          <AgentComposer
            className={styles.composerEmbed}
            value={input}
            onChange={setInput}
            onSend={() => {
              if (contextEstimate.isCritical) {
                setShowSendConfirm(true);
              } else {
                void handleSend();
              }
            }}
            onCancel={() => void session.cancel()}
            disabled={isInteractionBusy || isSending || resumeGate.composerBlocked}
            isRunning={isRunning}
            isSending={isSending}
            isBusy={isInteractionBusy}
            isCancelling={session.isCancelling}
            placeholder={isPreparingInterview
              ? 'Preparing the latest requirements…'
              : isAgentProcessing
                ? 'Agent is thinking…'
                : 'Continue the interview… (Enter to send)'}
            testIdPrefix="interview"
            testIds={{
              input: 'interview-message-input',
              send: 'interview-send-message',
              stop: 'interview-stop-agent',
            }}
            {...{ 'data-testid': 'interview-chat-composer' }}
            allowEmptySend
            textareaRef={textareaRef}
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
            models={availableModels}
            modelsLoading={modelsLoading}
            onModelChange={setModel}
            sendButton={(
              <div className={contextEstimate.isCritical ? styles.sendBtnCritical : undefined}>
                {showSendConfirm && (
                  <div className={styles.sendConfirmOverlay}>
                    <div className={styles.sendConfirmText}>
                      The context window is nearly full. Sending more messages may degrade the agent&apos;s ability to process the conversation. Continue anyway?
                    </div>
                    <div className={styles.sendConfirmActions}>
                      <button
                        className={styles.sendConfirmNo}
                        onClick={() => setShowSendConfirm(false)}
                        type="button"
                        {...{ 'data-testid': 'interview-send-confirm-cancel' }}
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
                        {...{ 'data-testid': 'interview-send-confirm-submit' }}
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
                  disabled={
                    (!input.trim() && attachments.length === 0)
                    || isInteractionBusy
                    || !repoReadiness.isReady
                    || resumeGate.composerBlocked
                  }
                  type="button"
                  aria-label="Send"
                  {...{ 'data-testid': 'interview-send-message' }}
                >
                  <svg viewBox="0 0 20 20" fill="currentColor">
                    <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
                  </svg>
                </button>
              </div>
            )}
          />
        </div>
      )}

      {handoffOpen && resumeGate.status ? (
        <GroundingHandoffDialog
          parentLabel="the interview"
          status={resumeGate.status}
          isPending={startChat.isPending || createPrd.isPending}
          error={prdGenError ? new Error(prdGenError) : null}
          onInherit={() => {
            setHandoffOpen(false);
            void handleGeneratePrd('inherit');
          }}
          onUseLatest={() => {
            setHandoffOpen(false);
            void handleGeneratePrd('latest');
          }}
          onClose={() => setHandoffOpen(false)}
          {...{ 'data-testid': 'grounding-handoff-dialog' }}
        />
      ) : null}

      {showLinkedContext && (
        <div
          className={styles.linkedContextOverlay}
          {...{ 'data-testid': 'interview-linked-context-overlay' }}
        >
          <dialog
            open
            ref={linkedContextPanelRef}
            className={styles.linkedContextPanel}
            aria-modal="true"
            aria-label="Linked Context"
            onKeyDown={handleLinkedContextPanelKeyDown}
            {...{ 'data-testid': 'interview-linked-context-panel' }}
          >
            <LinkedContextPicker
              mode="persisted"
              project={interview.project}
              interviewId={interview.id}
              canManage={canManage}
              interviewStatus={interview.status}
              initialErrorText={
                linkedContextLocationState?.linkedContextInitialErrorText
              }
              onClose={closeLinkedContext}
            />
          </dialog>
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
          {...{ 'data-testid': 'interview-delete-modal' }}
        />
      )}
    </div>
  );
};

// ── Router / entry point ──────────────────────────────────────────────────────

export const InterviewChatView: React.FC = () => {
  const location = useLocation();
  const { can, isInAnyGroup, permissionsLoaded } = useAppShell();
  const id = location.pathname.split('/').pop();

  if (id === 'new') {
    if (!permissionsLoaded) return null;
    if (!can('interviews:manage') || !isInAnyGroup(['BA', 'Manager', 'Product-Owner'])) {
      return <Navigate to="/backlog" replace />;
    }
    return <NewInterviewCompose />;
  }
  if (!id) return null;
  return <ExistingInterviewView id={id} />;
};

export default InterviewChatView;
