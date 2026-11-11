import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AgentComposer, AgentPanelShell, AgentTranscript } from './agentChat';
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
  const session = useAgentChatSession(threadId);
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
      snowMode,
      cutReleaseBranch,
    });
  } catch (err: unknown) {
    kickoffError = err instanceof Error ? err.message : 'Could not start cab-release.';
  }
  const shownError = createError ?? (threadId ? kickoffError ?? session.sendError : null);

  useEffect(() => {
    if (!threadId || kickoffSentRef.current || session.isPreparing || !kickoffText) return;
    kickoffSentRef.current = true;
    void sendKickoff(kickoffText, {
      skill: { name: CAB_RELEASE_SKILL_NAME, path: CAB_RELEASE_SKILL_PATH },
    });
  }, [threadId, kickoffText, sendKickoff, session.isPreparing]);

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

  const handleSend = useCallback(async () => {
    const text = input.trim();
    const outgoing = [...attachments];
    if (!text && outgoing.length === 0) return;
    const message = text || 'Please use the attached files as additional context.';
    setInput('');
    const sent = await session.send(
      message,
      outgoing.length > 0 ? { attachments: outgoing } : undefined,
    );
    if (sent && outgoing.length > 0) clearAttachments();
  }, [attachments, clearAttachments, input, session]);

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
        composer={(
          <AgentComposer
            className={styles.composerEmbed}
            value={input}
            onChange={setInput}
            onSend={() => void handleSend()}
            onCancel={session.isRunning ? () => void session.cancel() : undefined}
            disabled={session.isRunning || session.isSending || isCreating || !threadId}
            isRunning={session.isRunning}
            isSending={session.isSending}
            allowEmptySend
            placeholder={
              isCreating || skillConfigPending ? 'Starting cab-release…'
                : session.isRunning ? 'Agent is working…'
                  : 'Reply to cab-release… (Enter to send)'
            }
            testIdPrefix="cab-release-assistant"
            textareaRef={textareaRef}
            attachments={attachments}
            attachmentError={attachmentError}
            onRemoveAttachment={removeAttachment}
            onAttachClick={() => fileInputRef.current?.click()}
            onPasteFiles={(files) => { void addFiles(files); }}
            fileInput={(
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                onChange={(event) => { void handleAttachmentChange(event); }}
                disabled={session.isRunning || session.isSending || isCreating || !threadId}
                {...{ 'data-testid': 'cab-release-assistant-file-input' }}
              />
            )}
          />
        )}
      >
        {(isCreating || skillConfigPending) && (
          <div className={styles.starting}>Starting cab-release…</div>
        )}
        {shownError && (
          <div className={styles.error} {...{ 'data-testid': 'cab-release-assistant-error' }}>
            {shownError}
          </div>
        )}
        <AgentTranscript
          messages={session.visibleMessages}
          streamingText={session.streamingText}
          isRunning={session.isRunning || session.showTypingIndicator}
          onChoiceSubmit={(text) => { void session.send(text); }}
        />
      </AgentPanelShell>
    </div>
  );
};
