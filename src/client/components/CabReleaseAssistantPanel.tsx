import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AgentComposer, AgentPanelShell, AgentTranscript } from './agentChat';
import { useAgentChatSession } from '../hooks/useAgentChatSession';
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
  open: boolean;
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
  open,
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
  const kickoffSentRef = useRef(false);
  const dragStartXRef = useRef(0);
  const dragStartWidthRef = useRef(DEFAULT_WIDTH);

  const startChat = useStartChat();
  const { data: skillConfig } = useProjectSkillConfig(project);
  const session = useAgentChatSession(threadId, { enablePreparationState: true });

  useEffect(() => {
    if (open) return;
    setThreadId(null);
    setCreateError(null);
    setIsCreating(false);
    setInput('');
    kickoffSentRef.current = false;
  }, [open]);

  const startChatMutate = startChat.mutateAsync;

  useEffect(() => {
    if (!open || threadId) return;
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
  }, [open, threadId, skillConfig, project, startChatMutate]);

  const sendKickoff = session.send;

  useEffect(() => {
    if (!threadId || kickoffSentRef.current) return;
    kickoffSentRef.current = true;
    const text = buildCabReleaseKickoffMessage({
      targetVersion,
      apexReleaseEpicId,
      relatedWorkItemIds,
      previousReleaseBranch,
      snowMode,
      cutReleaseBranch,
    });
    void sendKickoff(text, {
      skill: { name: CAB_RELEASE_SKILL_NAME, path: CAB_RELEASE_SKILL_PATH },
    });
  }, [
    threadId,
    targetVersion,
    apexReleaseEpicId,
    relatedWorkItemIds,
    previousReleaseBranch,
    snowMode,
    cutReleaseBranch,
    sendKickoff,
  ]);

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

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    await session.send(text);
  }, [input, session]);

  if (!open) return null;

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
            placeholder={
              isCreating ? 'Starting cab-release…'
                : session.isRunning ? 'Agent is working…'
                  : 'Reply to cab-release… (Enter to send)'
            }
            testIdPrefix="cab-release-assistant"
            textareaRef={textareaRef}
          />
        )}
      >
        {isCreating && (
          <div className={styles.starting}>Starting cab-release…</div>
        )}
        {createError && (
          <div className={styles.error} {...{ 'data-testid': 'cab-release-assistant-error' }}>
            {createError}
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

export default CabReleaseAssistantPanel;
