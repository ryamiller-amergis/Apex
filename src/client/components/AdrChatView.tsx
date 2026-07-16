import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAppShell } from '../hooks/useAppShell';
import { useChatStream } from '../hooks/useChatStream';
import { useChatThread, useSkillRepos, useStartChat } from '../hooks/useChatThreads';
import { useAvailableModels, useGlobalDefaultModel, useProjectSkillConfig } from '../hooks/useProjectSkillConfig';
import { useAdr, useCreateAdr, useGenerateAdr, useUpdateAdr } from '../hooks/useAdrs';
import { DEFAULT_MODEL_ID } from '../config/models';
import { InterviewAgentMessage } from './InterviewChatView';
import { AdrAssistantPanel } from './AdrAssistantPanel';
import { ProposedAdrChangesReview } from './ProposedAdrChangesReview';
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
  const { selectedProject, selectedSkillSettingsId } = useAppShell();
  const navigate = useNavigate();
  const { data: skillConfig } = useProjectSkillConfig(selectedProject || null, selectedSkillSettingsId);
  const { data: repos = [] } = useSkillRepos(selectedProject || null);
  const { data: globalDefault } = useGlobalDefaultModel();
  const { data: models = [] } = useAvailableModels();
  const startChat = useStartChat();
  const createAdr = useCreateAdr();

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

  const handleStart = useCallback(async () => {
    if (!title.trim() || !input.trim() || !repo || pending) return;
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
      });
      const response = await fetch(`/api/chat/threads/${thread.threadId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ text: input.trim(), model }),
      });
      if (!response.ok) throw new Error('Failed to start the ADR interview');
      navigate(`/adr/${adr.adrId}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to start ADR');
    }
  }, [title, input, repo, pending, startChat, selectedProject, branch, skillConfig, model, createAdr, navigate]);

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
          {error && <div className={styles.composeError}>{error}</div>}
          <div className={styles.inputActions}>
            <select className={styles.modelSelect} value={model} onChange={(event) => setModel(event.target.value)}>
              {models.length ? models.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>) : <option value={model}>{model}</option>}
            </select>
            <button
              className={styles.sendBtn}
              type="button"
              aria-label="Start ADR"
              disabled={!title.trim() || !input.trim() || !repo || pending}
              onClick={() => void handleStart()}
            >
              {pending ? '…' : '→'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

const ExistingAdrView: React.FC<{ id: string }> = ({ id }) => {
  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [generationNow, setGenerationNow] = useState(Date.now());
  const [assistantOpen, setAssistantOpen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const { can, userId } = useAppShell();
  const { data: adr, isLoading, isError } = useAdr(id);
  const { data: thread } = useChatThread(adr?.chatThreadId ?? null);
  const { messages, streamingText, status } = useChatStream(adr?.chatThreadId ?? null, {
    initialMessages: thread?.messages,
    initialStatus: thread?.status,
  });
  const generateAdr = useGenerateAdr();
  const updateAdr = useUpdateAdr();
  const isRunning = status === 'running';
  const isAuthor = adr?.authorId === userId;
  const chatLocked = !isAuthor || adr?.status !== 'in_progress';

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
            <div className={styles.titleMeta}>{adr.project} · {adr.repo} · {adr.status.replace('_', ' ')}</div>
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
                aria-expanded={assistantOpen}
                onClick={() => setAssistantOpen((open) => !open)}
              >
                ADR Apex Assistant
              </button>
              <button
                className={styles.actionBtn}
                type="button"
                disabled={adr.proposedContent != null}
                title={adr.proposedContent != null ? 'Apply or reject the proposed edits before accepting the ADR' : undefined}
                onClick={() => updateAdr.mutate({ id, changes: { status: 'accepted' } })}
              >
                Accept ADR
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
      <ProposedAdrChangesReview
        adrId={adr.id}
        currentContent={adr.content}
        proposedContent={adr.proposedContent}
      />
      {adr.content && (
        <div className={styles.messages}>
          <div className={styles.messageList}>
            <div className={`${styles.messageBubble} ${styles.messageBubbleAssistant}`}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{adr.content}</ReactMarkdown>
            </div>
          </div>
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
      <AdrAssistantPanel
        adrId={adr.id}
        open={assistantOpen && isAuthor && adr.status === 'proposed' && can('adr:edit')}
        onClose={() => setAssistantOpen(false)}
        existingThreadId={adr.adrAssistantThreadId}
      />
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
