import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { ChatMessage } from '../../shared/types/chat';
import type { CodeLabSession, CodeLabSessionStatus } from '../../shared/types/codeLab';
import { useAgentChatSession } from '../hooks/useAgentChatSession';
import {
  codeLabKeys,
  useActiveCodeLabSession,
  useCodeLabDiff,
  useCodeLabLogs,
  usePushCodeLabBranch,
  useRestartCodeLabPreview,
  useStartCodeLabSession,
  useStopCodeLabSession,
} from '../hooks/useCodeLab';
import { parseGitDiff } from '../utils/parseGitDiff';
import { AgentComposer, AgentTranscript, AgentTypingIndicator } from './agentChat';
import styles from './CodeLabView.module.css';

export interface CodeLabViewProps {
  selectedProject: string;
}

type PreviewTab = 'preview' | 'changes' | 'logs';
type DeviceWidth = 'desktop' | 'tablet' | 'mobile';

const DEVICE_WIDTHS: Record<DeviceWidth, string> = {
  desktop: '100%',
  tablet: '768px',
  mobile: '390px',
};

/** Matches the preview proxy's own sandbox; never add allow-same-origin. */
const PREVIEW_SANDBOX = 'allow-scripts allow-forms allow-popups allow-modals allow-downloads';

const SUGGESTED_PROMPTS = [
  'Change the main heading on the home page to say "Welcome back"',
  'Make the primary buttons rounded and add a hover state',
  'Add an empty state message when the list has no items',
];

function statusLabel(status: CodeLabSessionStatus): string {
  switch (status) {
    case 'preparing':
      return 'Preparing';
    case 'starting_preview':
      return 'Starting preview';
    case 'ready':
      return 'Live';
    case 'preview_unavailable':
      return 'No preview';
    case 'failed':
      return 'Failed';
    case 'stopped':
      return 'Stopped';
    default: {
      const unreachable: never = status;
      return String(unreachable);
    }
  }
}

function isChatMessageVisible(message: ChatMessage): boolean {
  return message.role !== 'tool'
    && !message.hidden
    && message.toolName !== '_reasoning'
    && message.toolName !== '_thinking';
}

const CodeLabChat: React.FC<{
  threadId: string;
  onTurnFinished: () => void;
}> = ({ threadId, onTurnFinished }) => {
  const [input, setInput] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const wasRunning = useRef(false);
  const session = useAgentChatSession(threadId, { visibleMessageFilter: isChatMessageVisible });
  const { visibleMessages, streamingText, isRunning, isSending, isCancelling, showTypingIndicator, progressLabel, sendError } = session;

  useEffect(() => {
    if (wasRunning.current && !isRunning) onTurnFinished();
    wasRunning.current = isRunning;
  }, [isRunning, onTurnFinished]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [visibleMessages.length, streamingText]);

  const sendText = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setInput('');
    await session.send(trimmed);
  }, [session]);

  return (
    <section className={styles.chat} aria-label="Code Lab chat">
      <div className={styles['chat-transcript']}>
        {visibleMessages.length === 0 && !streamingText && (
          <div className={styles['chat-intro']}>
            <p className={styles['chat-intro-title']}>Describe a change to the app.</p>
            <p className={styles['chat-intro-body']}>The agent edits the code, and the preview reloads when it finishes.</p>
            <div className={styles['suggestions']}>
              {SUGGESTED_PROMPTS.map((prompt, index) => (
                <button
                  key={prompt}
                  type="button"
                  className={styles.suggestion}
                  onClick={() => setInput(prompt)}
                  {...{ 'data-testid': `code-lab-suggestion-${index}` }}
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        )}
        <AgentTranscript
          messages={visibleMessages}
          streamingText={streamingText}
          isRunning={isRunning}
          onChoiceSubmit={(text) => void sendText(text)}
          interactiveLastOnly
        />
        {showTypingIndicator && <AgentTypingIndicator label={progressLabel ?? 'Working on it…'} />}
        {sendError && <div className={styles['inline-error']} role="alert">{sendError}</div>}
        <div ref={endRef} />
      </div>
      <AgentComposer
        className={styles.composer}
        value={input}
        onChange={setInput}
        onSend={() => void sendText(input)}
        onCancel={isRunning ? () => void session.cancel() : undefined}
        disabled={isRunning || isSending}
        isRunning={isRunning}
        isSending={isSending}
        isCancelling={isCancelling}
        placeholder={isRunning ? 'The agent is working…' : 'Ask for a change, e.g. "make the header sticky"'}
        testIdPrefix="code-lab"
        textareaRef={textareaRef}
        {...{ 'data-testid': 'code-lab-composer' }}
      />
    </section>
  );
};

const CodeLabDiff: React.FC<{ diffText: string }> = ({ diffText }) => {
  const files = useMemo(() => parseGitDiff(diffText), [diffText]);
  if (files.length === 0) {
    return <p className={styles['pane-empty']}>No changes yet. Ask the agent for a change and it will show up here.</p>;
  }
  return (
    <div className={styles.diff}>
      {files.map((file) => (
        <details key={file.path} className={styles['diff-file']} open>
          <summary className={styles['diff-file-header']}>
            <span className={styles['diff-file-path']}>{file.path}</span>
            <span className={styles['diff-stat-add']}>+{file.hunks.filter((line) => line.type === 'add').length}</span>
            <span className={styles['diff-stat-remove']}>-{file.hunks.filter((line) => line.type === 'remove').length}</span>
          </summary>
          <pre className={styles['diff-body']}>
            {file.hunks.map((line, index) => (
              <div key={index} className={styles[`diff-line-${line.type}`]}>
                {line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}{line.content}
              </div>
            ))}
          </pre>
        </details>
      ))}
    </div>
  );
};

const PreviewPane: React.FC<{
  session: CodeLabSession;
  reloadNonce: number;
  onReload: () => void;
}> = ({ session, reloadNonce, onReload }) => {
  const [pathInput, setPathInput] = useState('/');
  const [activePath, setActivePath] = useState('/');
  const [device, setDevice] = useState<DeviceWidth>('desktop');

  if (!session.previewUrl) {
    const waiting = session.status === 'preparing' || session.status === 'starting_preview';
    return (
      <div className={styles['pane-empty']}>
        {waiting ? <div className={styles.spinner} aria-hidden="true" /> : null}
        <p>{session.statusDetail ?? (waiting ? 'Starting the preview…' : 'The preview is not available.')}</p>
        {session.preview && session.preview.kind !== 'unsupported' && !waiting && (
          <p className={styles['pane-hint']}>Open the Logs tab to see why, then restart the preview.</p>
        )}
      </div>
    );
  }

  const src = `${session.previewUrl}${activePath.replace(/^\/+/, '')}`;

  return (
    <div className={styles.preview}>
      <form
        className={styles['preview-toolbar']}
        onSubmit={(event) => {
          event.preventDefault();
          setActivePath(pathInput.startsWith('/') ? pathInput : `/${pathInput}`);
          onReload();
        }}
      >
        <button type="button" className={styles['icon-btn']} onClick={onReload} aria-label="Reload preview" title="Reload" {...{ 'data-testid': 'code-lab-preview-reload' }}>
          ↻
        </button>
        <input
          className={styles['address-bar']}
          value={pathInput}
          onChange={(event) => setPathInput(event.target.value)}
          aria-label="Preview path"
          spellCheck={false}
          {...{ 'data-testid': 'code-lab-preview-path' }}
        />
        <div className={styles['device-toggle']} role="group" aria-label="Preview width">
          {(Object.keys(DEVICE_WIDTHS) as DeviceWidth[]).map((option) => (
            <button
              key={option}
              type="button"
              className={`${styles['device-btn']} ${device === option ? styles['device-btn-active'] : ''}`}
              aria-pressed={device === option}
              onClick={() => setDevice(option)}
              {...{ 'data-testid': `code-lab-device-${option}` }}
            >
              {option[0].toUpperCase() + option.slice(1)}
            </button>
          ))}
        </div>
        <a className={styles['icon-btn']} href={src} target="_blank" rel="noopener noreferrer" title="Open in new tab" aria-label="Open preview in new tab" {...{ 'data-testid': 'code-lab-preview-open' }}>
          ↗
        </a>
      </form>
      <div className={styles['preview-stage']}>
        <iframe
          key={`${reloadNonce}-${src}`}
          className={styles['preview-frame']}
          style={{ width: DEVICE_WIDTHS[device] }}
          src={src}
          title="Code Lab live preview"
          sandbox={PREVIEW_SANDBOX}
          referrerPolicy="no-referrer"
          {...{ 'data-testid': 'code-lab-preview-frame' }}
        />
      </div>
    </div>
  );
};

const CodeLabWorkspace: React.FC<{ session: CodeLabSession; project: string }> = ({ session, project }) => {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<PreviewTab>('preview');
  const [reloadNonce, setReloadNonce] = useState(0);
  const [confirmStop, setConfirmStop] = useState(false);
  const diff = useCodeLabDiff(session.id, project, tab === 'changes');
  const logs = useCodeLabLogs(session.id, project, tab === 'logs');
  const restart = useRestartCodeLabPreview(project);
  const push = usePushCodeLabBranch(project);
  const stop = useStopCodeLabSession(project);
  const reload = useCallback(() => setReloadNonce((value) => value + 1), []);

  const handleTurnFinished = useCallback(() => {
    reload();
    void queryClient.invalidateQueries({ queryKey: codeLabKeys.diff(session.id) });
  }, [queryClient, reload, session.id]);

  const busy = session.status === 'preparing' || session.status === 'starting_preview';
  const actionError = restart.error?.message ?? push.error?.message ?? stop.error?.message ?? null;

  return (
    <div className={styles.workspace}>
      <header className={styles.toolbar}>
        <div className={styles['toolbar-info']}>
          <span className={`${styles.status} ${styles[`status-${session.status}`]}`} {...{ 'data-testid': 'code-lab-status' }}>
            {statusLabel(session.status)}
          </span>
          <span className={styles['toolbar-repo']}>
            {session.repo || session.project}
            {session.baseBranch && <span className={styles['toolbar-branch']}> · {session.branchName} from {session.baseBranch}</span>}
          </span>
          {session.preview && <span className={styles['stack-label']}>{session.preview.label}</span>}
        </div>
        <div className={styles['toolbar-actions']}>
          <button
            type="button"
            className={styles['ghost-btn']}
            disabled={busy || restart.isPending}
            onClick={() => restart.mutate(session.id)}
            {...{ 'data-testid': 'code-lab-restart-preview' }}
          >
            Restart preview
          </button>
          <button
            type="button"
            className={styles['ghost-btn']}
            disabled={busy || push.isPending}
            onClick={() => push.mutate(session.id)}
            {...{ 'data-testid': 'code-lab-push' }}
          >
            {push.isPending ? 'Pushing…' : session.branchPushed ? 'Push again' : 'Push branch'}
          </button>
          {confirmStop ? (
            <span className={styles['confirm-stop']}>
              Unpushed changes will be lost.
              <button type="button" className={styles['ghost-btn']} onClick={() => setConfirmStop(false)} {...{ 'data-testid': 'code-lab-stop-cancel' }}>Keep</button>
              <button type="button" className={styles['danger-btn']} onClick={() => stop.mutate(session.id)} disabled={stop.isPending} {...{ 'data-testid': 'code-lab-stop-confirm' }}>Stop</button>
            </span>
          ) : (
            <button type="button" className={styles['ghost-btn']} onClick={() => setConfirmStop(true)} {...{ 'data-testid': 'code-lab-stop' }}>
              Stop session
            </button>
          )}
        </div>
      </header>
      {push.data && (
        <div className={styles['inline-success']} role="status">
          Pushed {push.data.branch} with {push.data.changedFiles.length} changed file{push.data.changedFiles.length === 1 ? '' : 's'}. Open a pull request from it in your repository.
        </div>
      )}
      {actionError && <div className={styles['inline-error']} role="alert">{actionError}</div>}
      {session.status === 'failed' && (
        <div className={styles['inline-error']} role="alert">{session.statusDetail}</div>
      )}

      <div className={styles.split}>
        {session.chatThreadId ? (
          <CodeLabChat threadId={session.chatThreadId} onTurnFinished={handleTurnFinished} />
        ) : (
          <section className={`${styles.chat} ${styles['pane-empty']}`} aria-label="Code Lab chat">
            {session.status !== 'failed' && <div className={styles.spinner} aria-hidden="true" />}
            <p>{session.status === 'failed' ? 'The session could not start.' : session.statusDetail ?? 'Preparing the workspace…'}</p>
          </section>
        )}

        <section className={styles.panel} aria-label="Preview and changes">
          <div className={styles.tabs} role="tablist">
            {(['preview', 'changes', 'logs'] as PreviewTab[]).map((option) => (
              <button
                key={option}
                type="button"
                role="tab"
                aria-selected={tab === option}
                className={`${styles.tab} ${tab === option ? styles['tab-active'] : ''}`}
                onClick={() => setTab(option)}
                {...{ 'data-testid': `code-lab-tab-${option}` }}
              >
                {option === 'preview' ? 'Preview' : option === 'changes' ? 'Changes' : 'Logs'}
              </button>
            ))}
          </div>
          <div className={styles['tab-body']}>
            {tab === 'preview' && <PreviewPane session={session} reloadNonce={reloadNonce} onReload={reload} />}
            {tab === 'changes' && (
              diff.isLoading ? <p className={styles['pane-empty']}>Loading changes…</p>
                : diff.error ? <p className={styles['inline-error']}>{diff.error.message}</p>
                  : <CodeLabDiff diffText={diff.data?.diffText ?? ''} />
            )}
            {tab === 'logs' && (
              <pre className={styles.logs} {...{ 'data-testid': 'code-lab-logs' }}>
                {(logs.data?.lines ?? []).join('\n') || 'No output yet.'}
              </pre>
            )}
          </div>
        </section>
      </div>
    </div>
  );
};

export const CodeLabView: React.FC<CodeLabViewProps> = ({ selectedProject }) => {
  const active = useActiveCodeLabSession(selectedProject);
  const start = useStartCodeLabSession();

  if (active.isLoading) {
    return <div className={styles.page}><p className={styles['pane-empty']}>Loading Code Lab…</p></div>;
  }

  const session = active.data;

  return (
    <div className={styles.page} {...{ 'data-testid': 'code-lab-view' }}>
      <div className={styles.heading}>
        <h1 className={styles.title}>Code Lab</h1>
        <p className={styles.subtitle}>Ask for a change, watch it run, and push the branch when it looks right.</p>
      </div>

      {session ? (
        <CodeLabWorkspace session={session} project={selectedProject} />
      ) : (
        <div className={styles['start-card']}>
          <h2 className={styles['start-title']}>Start a session for {selectedProject}</h2>
          <p className={styles['start-body']}>
            Code Lab checks out this project&apos;s repository on a new branch, installs its dependencies, and starts a
            live preview next to an AI agent that edits the code for you.
          </p>
          <ul className={styles['start-list']}>
            <li>The live preview supports Vite apps (React, Vue, Svelte and others) and static HTML sites.</li>
            <li>For other stacks, the agent still edits code and you can review the diff and push the branch.</li>
            <li>The preview runs isolated from your Apex sign-in, so pages behind a login show their signed-out state.</li>
            <li>Idle sessions stop after 30 minutes. Push your branch to keep the changes.</li>
          </ul>
          {start.error && <div className={styles['inline-error']} role="alert">{start.error.message}</div>}
          {active.error && <div className={styles['inline-error']} role="alert">{active.error.message}</div>}
          <button
            type="button"
            className={styles['primary-btn']}
            disabled={start.isPending}
            onClick={() => start.mutate({ project: selectedProject })}
            {...{ 'data-testid': 'code-lab-start' }}
          >
            {start.isPending ? 'Starting…' : 'Start session'}
          </button>
        </div>
      )}
    </div>
  );
};

export default CodeLabView;
