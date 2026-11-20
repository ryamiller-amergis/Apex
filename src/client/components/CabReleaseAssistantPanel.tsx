import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AgentHarnessPanel, AgentPanelShell } from './agentChat';
import { useAgentChatSession } from '../hooks/useAgentChatSession';
import { useChatAttachments } from '../hooks/useChatAttachments';
import { useStartChat } from '../hooks/useChatThreads';
import { useProjectSkillConfig } from '../hooks/useProjectSkillConfig';
import { DEFAULT_MODEL_ID } from '../config/models';
import {
  buildCabReleaseKickoffMessage,
  CAB_RELEASE_SKILL_NAME,
  CAB_RELEASE_SKILL_PATH,
  type CabSnowMode,
} from '../utils/cabReleaseKickoff';
import styles from './CabReleaseAssistantPanel.module.css';

const MIN_WIDTH = 320;
const MAX_WIDTH = 860;
const DEFAULT_WIDTH = 420;

export interface CabReleaseAssistantPanelProps {
  onClose: () => void;
  project: string;
  targetVersion: string;
  apexReleaseEpicId: number;
  relatedWorkItemIds: number[];
  previousReleaseBranch: string;
  snowMode: CabSnowMode;
  cutReleaseBranch: boolean;
  'data-testid'?: string;
}

export const CabReleaseAssistantPanel: React.FC<CabReleaseAssistantPanelProps> = ({
  onClose,
  project,
  targetVersion,
  apexReleaseEpicId,
  relatedWorkItemIds,
  previousReleaseBranch,
  snowMode,
  cutReleaseBranch,
  'data-testid': dataTestId = 'cab-release-assistant-panel',
}) => {
  const [threadId, setThreadId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [activeSnowMode, setActiveSnowMode] = useState<CabSnowMode>(snowMode);
  const [prodConfirmed, setProdConfirmed] = useState(false);
  const [showProdConfirm, setShowProdConfirm] = useState(false);
  const [panelWidth, setPanelWidth] = useState(DEFAULT_WIDTH);
  const [isDragging, setIsDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const kickoffSentRef = useRef(false);
  const dragStartXRef = useRef(0);
  const dragStartWidthRef = useRef(DEFAULT_WIDTH);

  const startChat = useStartChat();
  const {
    data: skillConfig,
    isPending: skillConfigPending,
    isError: skillConfigFailed,
    error: skillConfigError,
  } = useProjectSkillConfig(project);
  const session = useAgentChatSession(threadId, {
    harnessArea: 'cab-release',
    area: 'cab-release',
  });
  const {
    attachments,
    attachmentError,
    addFiles,
    removeAttachment,
    clearAttachments,
  } = useChatAttachments();

  const startChatMutate = startChat.mutateAsync;

  useEffect(() => {
    if (threadId) return;
    if (skillConfigPending) return;
    if (skillConfigFailed) {
      setCreateError(
        skillConfigError instanceof Error
          ? skillConfigError.message
          : 'Failed to load project skill settings.',
      );
      return;
    }
    if (!skillConfig?.skillRepo) {
      setCreateError('Project skill settings are missing a skill repo.');
      return;
    }

    let cancelled = false;
    setIsCreating(true);
    setCreateError(null);
    void startChatMutate({
      skipAutoKickoff: true,
      kickoff: {
        project,
        repo: skillConfig.skillRepo,
        branch: skillConfig.skillBranch || 'main',
        skillProvider: skillConfig.skillProvider,
        skillSettingsId: skillConfig.id,
        skillPath: CAB_RELEASE_SKILL_PATH,
        pillLabel: 'Create CAB request',
        model: DEFAULT_MODEL_ID,
      },
    }).then((result) => {
      if (!cancelled) setThreadId(result.threadId);
    }).catch((err: unknown) => {
      if (!cancelled) {
        setCreateError(err instanceof Error ? err.message : 'Failed to start cab-release.');
      }
    }).finally(() => {
      if (!cancelled) setIsCreating(false);
    });

    return () => {
      cancelled = true;
    };
  }, [
    threadId,
    skillConfig,
    skillConfigPending,
    skillConfigFailed,
    skillConfigError,
    project,
    startChatMutate,
  ]);

  const sendKickoff = session.send;
  let kickoffText: string | null = null;
  let kickoffError: string | null = null;
  try {
    kickoffText = buildCabReleaseKickoffMessage({
      targetVersion,
      apexReleaseEpicId,
      relatedWorkItemIds,
      previousReleaseBranch,
      snowMode: activeSnowMode,
      cutReleaseBranch,
    });
  } catch (err: unknown) {
    kickoffError = err instanceof Error ? err.message : 'Could not start cab-release.';
  }
  const shownError = createError ?? (threadId ? kickoffError ?? session.sendError : null);
  const awaitingProdConfirmation = activeSnowMode === 'run' && !prodConfirmed;

  useEffect(() => {
    if (
      !threadId
      || kickoffSentRef.current
      || session.isPreparing
      || !kickoffText
      || awaitingProdConfirmation
    ) {
      return;
    }
    kickoffSentRef.current = true;
    void sendKickoff(kickoffText, {
      skill: { name: CAB_RELEASE_SKILL_NAME, path: CAB_RELEASE_SKILL_PATH },
    });
  }, [threadId, kickoffText, sendKickoff, session.isPreparing, awaitingProdConfirmation]);

  const handleResizeMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragStartXRef.current = event.clientX;
    dragStartWidthRef.current = panelWidth;
    setIsDragging(true);
  }, [panelWidth]);

  useEffect(() => {
    if (!isDragging) return;
    const onMouseMove = (event: MouseEvent) => {
      const delta = dragStartXRef.current - event.clientX;
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, dragStartWidthRef.current + delta));
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

  const handleAttachmentChange = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    await addFiles(event.currentTarget.files);
    event.currentTarget.value = '';
  }, [addFiles]);

  const handleSend = useCallback(async (text: string) => {
    const trimmed = text.trim();
    const outgoing = [...attachments];
    if (!trimmed && outgoing.length === 0) return false;
    const message = trimmed || 'Please use the attached files as additional context.';
    const sent = await session.send(
      message,
      outgoing.length > 0 ? { attachments: outgoing } : undefined,
    );
    if (sent && outgoing.length > 0) clearAttachments();
    return sent;
  }, [attachments, clearAttachments, session]);

  const handleConfirmProdPromotion = useCallback(() => {
    if (!threadId || session.isRunning || session.isSending) return;
    setActiveSnowMode('run');
    setProdConfirmed(true);
    setShowProdConfirm(false);
    void session.send(
      `Confirmed: proceed with Production SNOW CAB request (definition 595 / mv-application-prod-snow.yml) for ${targetVersion}.`,
    );
  }, [session, targetVersion, threadId]);

  const composerDisabled = session.isRunning || session.isSending || isCreating || !threadId;

  const proposalContent = awaitingProdConfirmation ? (
    <div
      role="status"
      style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: '0.82rem' }}
      {...{ 'data-testid': 'cab-release-proposal-banner' }}
    >
      <div>
        <strong>Production CAB confirmation required</strong> — Prod SNOW (definition 595)
        {cutReleaseBranch ? ` and Release/${targetVersion} branch cut` : ''} will not run until you confirm.
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          disabled={composerDisabled}
          onClick={() => setProdConfirmed(true)}
          {...{ 'data-testid': 'cab-release-confirm-prod-apply' }}
        >
          Confirm production CAB run
        </button>
        <button
          type="button"
          disabled={composerDisabled}
          onClick={() => setActiveSnowMode('dry-run')}
          {...{ 'data-testid': 'cab-release-confirm-dry-run-btn' }}
        >
          Switch to dry-run
        </button>
      </div>
    </div>
  ) : activeSnowMode === 'dry-run' ? (
    <div
      role="status"
      style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: '0.82rem' }}
      {...{ 'data-testid': 'cab-release-proposal-banner' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <span>
          <strong>Dry-run mode</strong> — QA SNOW (definition 670). Production writes require confirmation.
        </span>
        {!showProdConfirm ? (
          <button
            type="button"
            disabled={composerDisabled}
            onClick={() => setShowProdConfirm(true)}
            {...{ 'data-testid': 'cab-release-confirm-prod-btn' }}
          >
            Promote to Production CAB
          </button>
        ) : (
          <span style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              disabled={composerDisabled}
              onClick={handleConfirmProdPromotion}
              {...{ 'data-testid': 'cab-release-confirm-prod-apply' }}
            >
              Confirm production run
            </button>
            <button
              type="button"
              onClick={() => setShowProdConfirm(false)}
              {...{ 'data-testid': 'cab-release-confirm-prod-cancel' }}
            >
              Cancel
            </button>
          </span>
        )}
      </div>
    </div>
  ) : (
    <div
      role="status"
      style={{ fontSize: '0.82rem' }}
      {...{ 'data-testid': 'cab-release-proposal-banner' }}
    >
      <strong>Production mode confirmed</strong> — Prod SNOW (definition 595)
    </div>
  );

  return (
    <div {...{ 'data-testid': dataTestId }}>
      <AgentPanelShell
        {...{ 'data-testid': 'cab-release-assistant-shell' }}
        title={`CAB ${targetVersion}`}
        ariaLabel="CAB release assistant panel"
        onClose={onClose}
        closeAriaLabel="Close CAB assistant"
        closeTestId="cab-release-assistant-close"
        width={panelWidth}
        onResizeMouseDown={handleResizeMouseDown}
      >
        <AgentHarnessPanel
          area="cab-release"
          session={session}
          testIdPrefix="cab-release-assistant"
          {...{ 'data-testid': 'cab-release-harness-panel' }}
          draft={input}
          onDraftChange={setInput}
          onSend={handleSend}
          onCancel={session.isRunning ? () => void session.cancel() : undefined}
          onChoiceSelect={(text) => { void session.send(text); }}
          slots={{
            header: (isCreating || skillConfigPending || shownError) ? (
              <>
                {(isCreating || skillConfigPending) && (
                  <div className={styles.starting}>Starting cab-release…</div>
                )}
                {shownError && (
                  <div className={styles.error} {...{ 'data-testid': 'cab-release-assistant-error' }}>
                    {shownError}
                  </div>
                )}
              </>
            ) : undefined,
            proposal: proposalContent,
          }}
          composer={{
            disabled: session.isSending || isCreating || !threadId,
            allowEmptySend: true,
            placeholder: isCreating || skillConfigPending
              ? 'Starting cab-release…'
              : session.isRunning
                ? 'Send a follow-up while the agent works…'
                : 'Reply to cab-release… (Enter to send)',
            textareaRef,
            attachments,
            attachmentError,
            onRemoveAttachment: removeAttachment,
            onAttachClick: () => fileInputRef.current?.click(),
            onPasteFiles: (files) => { void addFiles(files); },
            fileInput: (
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                onChange={(event) => { void handleAttachmentChange(event); }}
                disabled={composerDisabled}
                {...{ 'data-testid': 'cab-release-assistant-file-input' }}
              />
            ),
          }}
        />
      </AgentPanelShell>
    </div>
  );
};
