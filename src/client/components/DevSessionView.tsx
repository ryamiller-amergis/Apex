import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useLocation, useNavigate } from 'react-router-dom';
import { useChatThread, useSendMessage, useCancelRun } from '../hooks/useChatThreads';
import { useChatStream } from '../hooks/useChatStream';
import { useDevSession, useDevDiff, usePushBranch } from '../hooks/useDevWorkbench';
import type { ChatMessage } from '../../shared/types/chat';
import styles from './DevSessionView.module.css';

/** An "agent turn" groups all activity between a user message and the final agent response */
interface AgentTurn {
  reasoning: ChatMessage[];
  tools: ChatMessage[];
  finalOutput: ChatMessage | null;
}

function isActivityMsg(m: ChatMessage): boolean {
  return m.role === 'tool' || m.toolName === '_reasoning' || m.toolName === '_thinking';
}

function buildTurns(messages: ChatMessage[]): AgentTurn[] {
  const turns: AgentTurn[] = [];
  let current: AgentTurn | null = null;

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (current) turns.push(current);
      current = { reasoning: [], tools: [], finalOutput: null };
      continue;
    }
    if (!current) current = { reasoning: [], tools: [], finalOutput: null };

    if (msg.toolName === '_reasoning' || msg.toolName === '_thinking') {
      current.reasoning.push(msg);
    } else if (msg.role === 'tool') {
      current.tools.push(msg);
    } else if (msg.role === 'agent') {
      current.finalOutput = msg;
    }
  }
  if (current) turns.push(current);
  return turns;
}

interface DiffLine {
  type: 'add' | 'remove' | 'context' | 'hunk-header';
  content: string;
  oldLineNo?: number;
  newLineNo?: number;
}

interface DiffFile {
  path: string;
  hunks: DiffLine[];
}

function parseDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  const lines = raw.split('\n');
  let current: DiffFile | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      const match = line.match(/b\/(.+)$/);
      current = { path: match?.[1] ?? line, hunks: [] };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++') || line.startsWith('new file') || line.startsWith('deleted file')) {
      continue;
    }
    if (line.startsWith('@@')) {
      const hunkMatch = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
      oldLine = hunkMatch ? parseInt(hunkMatch[1], 10) : 0;
      newLine = hunkMatch ? parseInt(hunkMatch[2], 10) : 0;
      current.hunks.push({ type: 'hunk-header', content: line });
      continue;
    }
    if (line.startsWith('+')) {
      current.hunks.push({ type: 'add', content: line.slice(1), newLineNo: newLine });
      newLine++;
    } else if (line.startsWith('-')) {
      current.hunks.push({ type: 'remove', content: line.slice(1), oldLineNo: oldLine });
      oldLine++;
    } else {
      current.hunks.push({ type: 'context', content: line.startsWith(' ') ? line.slice(1) : line, oldLineNo: oldLine, newLineNo: newLine });
      oldLine++;
      newLine++;
    }
  }
  return files;
}

const DiffViewer: React.FC<{ diffText: string }> = ({ diffText }) => {
  const files = useMemo(() => parseDiff(diffText), [diffText]);
  const [collapsed, setCollapsed] = useState<Record<number, boolean>>({});

  const isCollapsed = useCallback((idx: number) => collapsed[idx] ?? true, [collapsed]);

  const toggle = useCallback((idx: number) => {
    setCollapsed((prev) => ({ ...prev, [idx]: !(prev[idx] ?? true) }));
  }, []);

  const collapseAll = useCallback(() => {
    setCollapsed(Object.fromEntries(files.map((_, i) => [i, true])));
  }, [files]);

  const expandAll = useCallback(() => {
    setCollapsed(Object.fromEntries(files.map((_, i) => [i, false])));
  }, [files]);

  if (files.length === 0) return null;

  return (
    <div className={styles['diff-viewer']}>
      <div className={styles['diff-toolbar']}>
        <button type="button" className={styles['diff-toolbar-btn']} onClick={expandAll}>
          Expand all
        </button>
        <button type="button" className={styles['diff-toolbar-btn']} onClick={collapseAll}>
          Collapse all
        </button>
      </div>
      {files.map((file, i) => (
        <div key={i} className={styles['diff-file']}>
          <button
            type="button"
            className={styles['diff-file-header']}
            onClick={() => toggle(i)}
          >
            <span className={styles['diff-file-toggle']}>{isCollapsed(i) ? '▶' : '▼'}</span>
            <span className={styles['diff-file-path']}>{file.path}</span>
            <span className={styles['diff-file-stats']}>
              <span className={styles['diff-stat-add']}>+{file.hunks.filter((l) => l.type === 'add').length}</span>
              <span className={styles['diff-stat-remove']}>-{file.hunks.filter((l) => l.type === 'remove').length}</span>
            </span>
          </button>
          {!isCollapsed(i) && (
            <div className={styles['diff-file-body']}>
              {file.hunks.map((line, j) => {
                if (line.type === 'hunk-header') {
                  return (
                    <div key={j} className={styles['diff-line-hunk']}>
                      <span className={styles['diff-gutter']} />
                      <span className={styles['diff-gutter']} />
                      <span className={styles['diff-line-content']}>{line.content}</span>
                    </div>
                  );
                }
                const cls =
                  line.type === 'add' ? styles['diff-line-add'] :
                  line.type === 'remove' ? styles['diff-line-remove'] :
                  styles['diff-line-context'];
                const prefix = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
                return (
                  <div key={j} className={cls}>
                    <span className={styles['diff-gutter']}>{line.oldLineNo ?? ''}</span>
                    <span className={styles['diff-gutter']}>{line.newLineNo ?? ''}</span>
                    <span className={styles['diff-line-content']}><span className={styles['diff-prefix']}>{prefix}</span>{line.content}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

function describeToolCall(toolName?: string, toolInput?: Record<string, unknown>): { icon: string; label: string } {
  const name = toolName ?? '';
  const input = toolInput ?? {};
  const filePath = (input.path ?? input.filePath ?? input.file ?? input.target_file ?? '') as string;
  const shortPath = filePath ? filePath.split('/').slice(-2).join('/') : '';

  switch (name) {
    case 'file_edit':
    case 'edit_file':
    case 'str_replace_editor':
      return { icon: '✏️', label: shortPath ? `Editing ${shortPath}` : 'Editing file' };
    case 'file_read':
    case 'read_file':
      return { icon: '📄', label: shortPath ? `Reading ${shortPath}` : 'Reading file' };
    case 'file_write':
    case 'write_file':
    case 'create_file':
      return { icon: '📝', label: shortPath ? `Creating ${shortPath}` : 'Writing file' };
    case 'search':
    case 'grep':
    case 'file_search':
      return { icon: '🔍', label: input.query ? `Searching for "${input.query}"` : 'Searching codebase' };
    case 'terminal':
    case 'run_terminal_cmd':
    case 'execute_command':
      return { icon: '⚡', label: input.command ? `Running \`${(input.command as string).slice(0, 60)}\`` : 'Running command' };
    case 'list_dir':
    case 'list_directory':
      return { icon: '📁', label: shortPath ? `Listing ${shortPath}` : 'Listing directory' };
    case 'delete_file':
      return { icon: '🗑️', label: shortPath ? `Deleting ${shortPath}` : 'Deleting file' };
    case 'codebase_search':
      return { icon: '🔍', label: input.query ? `Searching: "${input.query}"` : 'Searching codebase' };
    default:
      return { icon: '⚙️', label: name.replace(/_/g, ' ') };
  }
}

const AgentTurnBlock: React.FC<{
  turn: AgentTurn;
  isLive?: boolean;
  streamingText?: string;
}> = ({ turn, isLive, streamingText }) => {
  const [expanded, setExpanded] = useState(isLive ? true : false);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  const stepCount = turn.reasoning.length + turn.tools.length;
  const hasActivity = stepCount > 0 || (isLive && streamingText);

  useEffect(() => {
    if (isLive) setExpanded(true);
  }, [isLive]);

  useEffect(() => {
    if (isLive && expanded) logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turn, streamingText, isLive, expanded]);

  return (
    <div className={styles['turn-block']}>
      {hasActivity && (
        <div className={styles['turn-activity']}>
          <button
            type="button"
            className={styles['turn-activity-toggle']}
            onClick={() => setExpanded((p) => !p)}
          >
            <span className={styles['turn-toggle-arrow']}>{expanded ? '▼' : '▶'}</span>
            {isLive && <span className={styles['thinking-spinner']} />}
            <span>{isLive ? `Agent is working… (${stepCount} steps)` : `Agent activity — ${stepCount} steps`}</span>
          </button>

          {expanded && (
            <div className={styles['activity-log']}>
              {turn.reasoning.map((msg, i) => {
                const nextMsg = i < turn.reasoning.length - 1 ? turn.reasoning[i + 1] : turn.tools[0];
                const isLatestReasoning = isLive && !nextMsg;
                return (
                  <div key={msg.id} className={`${styles['log-entry']} ${isLatestReasoning ? styles['log-entry-active'] : ''}`}>
                    <span className={styles['log-icon']}>💭</span>
                    <div className={styles['log-content']}>
                      <div className={styles['log-label']}>Reasoning</div>
                      <div className={styles['log-text']}>{msg.text}</div>
                    </div>
                    <span className={styles['log-time']}>{new Date(msg.ts).toLocaleTimeString()}</span>
                  </div>
                );
              })}
              {turn.tools.map((msg) => {
                const { icon, label } = describeToolCall(msg.toolName, msg.toolInput);
                return (
                  <div key={msg.id} className={styles['log-entry']}>
                    <span className={styles['log-icon']}>{icon}</span>
                    <div className={styles['log-content']}>
                      <span className={styles['log-label']}>{label}</span>
                    </div>
                    <span className={styles['log-time']}>{new Date(msg.ts).toLocaleTimeString()}</span>
                  </div>
                );
              })}
              {isLive && streamingText && (
                <div className={`${styles['log-entry']} ${styles['log-entry-active']}`}>
                  <span className={styles['log-icon']}>💭</span>
                  <div className={styles['log-content']}>
                    <div className={styles['log-label']}>Reasoning</div>
                    <div className={styles['log-text']}>{streamingText}</div>
                  </div>
                </div>
              )}
              <div ref={logEndRef} />
            </div>
          )}
        </div>
      )}

      {turn.finalOutput && (
        <AgentBubble msg={turn.finalOutput} />
      )}
    </div>
  );
};

const UserBubble: React.FC<{ msg: ChatMessage }> = ({ msg }) => (
  <div className={`${styles.message} ${styles['role-user']}`}>
    <div className={styles['user-bubble']}>{msg.text}</div>
    <span className={styles.meta}>{new Date(msg.ts).toLocaleTimeString()}</span>
  </div>
);

const AgentBubble: React.FC<{ msg: ChatMessage }> = ({ msg }) => (
  <div className={`${styles.message} ${styles['role-agent']}`}>
    <div className={styles['agent-header']}>
      <span className={styles['agent-avatar']}>AI</span>
      <span>Agent</span>
      <span className={styles.meta}>{new Date(msg.ts).toLocaleTimeString()}</span>
    </div>
    <div className={styles['agent-bubble']}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.text}</ReactMarkdown>
    </div>
  </div>
);

const SetupProgress: React.FC<{ status: string; error: string | null }> = ({ status, error }) => (
  <div className={styles['setup-overlay']}>
    <div className={styles['setup-card']}>
      {status === 'failed' ? (
        <>
          <div className={styles['setup-icon-error']}>!</div>
          <h2 className={styles['setup-title']}>Setup Failed</h2>
          <p className={styles['setup-detail']}>{error ?? 'An unknown error occurred during setup.'}</p>
        </>
      ) : (
        <>
          <div className={styles['setup-spinner']} />
          <h2 className={styles['setup-title']}>Setting up workspace</h2>
          <p className={styles['setup-detail']}>Cloning repository and preparing your development environment…</p>
        </>
      )}
    </div>
  </div>
);

const ReadyToTest: React.FC<{
  branchName: string;
  sessionId: string;
}> = ({ branchName, sessionId }) => {
  const pushBranch = usePushBranch();
  const [copied, setCopied] = useState(false);
  const [pushed, setPushed] = useState(false);

  const copyBranch = useCallback(() => {
    navigator.clipboard.writeText(branchName);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [branchName]);

  const handlePush = useCallback(async () => {
    try {
      await pushBranch.mutateAsync(sessionId);
      setPushed(true);
    } catch {
      // error is available via pushBranch.error
    }
  }, [pushBranch, sessionId]);

  const checkoutCmd = `git fetch origin && git checkout ${branchName}`;

  const copyCommand = useCallback(() => {
    navigator.clipboard.writeText(checkoutCmd);
  }, [checkoutCmd]);

  return (
    <div className={styles['ready-to-test']}>
      <div className={styles['ready-to-test-header']}>
        <span className={styles['ready-to-test-icon']}>&#10003;</span>
        <span className={styles['ready-to-test-title']}>
          {pushed ? 'Branch Pushed' : 'Ready to Test Locally'}
        </span>
      </div>

      {!pushed ? (
        <div className={styles['ready-to-test-body']}>
          <p className={styles['ready-to-test-desc']}>
            Push the branch to the remote so you can pull it down and test locally.
          </p>
          <button
            type="button"
            className={styles['push-btn']}
            onClick={handlePush}
            disabled={pushBranch.isPending}
          >
            {pushBranch.isPending ? 'Pushing…' : `Push ${branchName}`}
          </button>
          {pushBranch.error && (
            <p className={styles['push-error']}>{pushBranch.error.message}</p>
          )}
        </div>
      ) : (
        <div className={styles['ready-to-test-body']}>
          <p className={styles['ready-to-test-desc']}>
            Run this in your local repo to start testing:
          </p>
          <div className={styles['checkout-cmd']}>
            <code>{checkoutCmd}</code>
            <button
              type="button"
              className={styles['copy-cmd-btn']}
              onClick={copyCommand}
              title="Copy command"
            >
              copy
            </button>
          </div>

          <div className={styles['branch-copy-row']}>
            <span className={styles['branch-label']}>Branch:</span>
            <code className={styles['branch-name-code']}>{branchName}</code>
            <button
              type="button"
              className={styles['copy-branch-btn']}
              onClick={copyBranch}
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

export const DevSessionView: React.FC = () => {
  const location = useLocation();
  const navigate = useNavigate();

  const sessionId = useMemo(() => {
    const parts = location.pathname.split('/');
    return parts[parts.length - 1] || null;
  }, [location.pathname]);

  const { data: session } = useDevSession(sessionId);
  const threadId = session?.chatThreadId ?? null;
  const isSettingUp = !session || session.status === 'setting_up';
  const isFailed = session?.status === 'failed';

  const { data: thread } = useChatThread(threadId);

  const { messages, streamingText, status } = useChatStream(
    threadId,
    { initialMessages: thread?.messages, initialStatus: thread?.status },
  );

  const sendMessage = useSendMessage(threadId ?? '');
  const cancelRun = useCancelRun(threadId ?? '');
  const { data: diff, refetch: refetchDiff } = useDevDiff(threadId);

  const [input, setInput] = useState('');
  const [changesOpen, setChangesOpen] = useState(true);
  const [panelWidth, setPanelWidth] = useState(400);
  const dragging = useRef(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const prevStatusRef = useRef<string | undefined>(status);

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    const startX = e.clientX;
    const startW = panelWidth;

    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const delta = startX - ev.clientX;
      setPanelWidth(Math.max(260, Math.min(startW + delta, 900)));
    };
    const onUp = () => {
      dragging.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [panelWidth]);

  const isRunning = status === 'running';
  const visibleMessages = useMemo(
    () => messages.filter((m) => !(m.role === 'user' && m.text === 'Begin.')),
    [messages],
  );

  const turns = useMemo(() => buildTurns(visibleMessages), [visibleMessages]);

  useEffect(() => {
    if (prevStatusRef.current === 'running' && status !== 'running') {
      refetchDiff();
    }
    prevStatusRef.current = status;
  }, [status, refetchDiff]);

  useEffect(() => {
    if (!isRunning || !threadId) return;
    const interval = window.setInterval(() => refetchDiff(), 10_000);
    return () => window.clearInterval(interval);
  }, [isRunning, threadId, refetchDiff]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingText]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  const doSend = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isRunning || !threadId) return;
    setInput('');
    await sendMessage.mutateAsync({ text: trimmed });
    refetchDiff();
  }, [isRunning, threadId, sendMessage, refetchDiff]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doSend(input);
    }
  };

  return (
    <div className={styles.container}>
      {(isSettingUp || isFailed) && (
        <SetupProgress status={session?.status ?? 'setting_up'} error={session?.setupError ?? null} />
      )}

      <div className={styles['chat-pane']}>
        <button
          className={styles['back-link']}
          onClick={() => navigate('/my-work')}
          type="button"
        >
          ← Back to My Work
        </button>

        <div className={styles.messages}>
          {(() => {
            const elements: React.ReactNode[] = [];
            let turnIdx = 0;

            for (const msg of visibleMessages) {
              if (isActivityMsg(msg)) continue;

              if (msg.role === 'user') {
                elements.push(<UserBubble key={msg.id} msg={msg} />);
                continue;
              }
              if (msg.role === 'system') {
                const cls = msg.text.startsWith('Error:') ? styles['system-error'] : styles['system-msg'];
                elements.push(<div key={msg.id} className={cls}>{msg.text}</div>);
                continue;
              }
              if (msg.role === 'agent') {
                const turn = turns[turnIdx];
                if (turn) {
                  elements.push(
                    <AgentTurnBlock key={`turn-${turnIdx}`} turn={turn} />,
                  );
                  turnIdx++;
                } else {
                  elements.push(<AgentBubble key={msg.id} msg={msg} />);
                }
              }
            }

            if (isRunning) {
              const liveTurn = turns[turnIdx] ?? { reasoning: [], tools: [], finalOutput: null };
              elements.push(
                <AgentTurnBlock
                  key="live-turn"
                  turn={liveTurn}
                  isLive
                  streamingText={streamingText}
                />,
              );
            }

            return elements;
          })()}

          <div ref={messagesEndRef} />
        </div>

        <div className={styles['input-area']}>
          <textarea
            ref={textareaRef}
            className={styles.textarea}
            placeholder={isSettingUp ? 'Setting up workspace…' : isRunning ? 'Agent is working…' : 'Ask the agent to implement changes…'}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isSettingUp || isFailed || isRunning || status === 'closed'}
            rows={1}
          />
          {isRunning ? (
            <button
              className={styles['stop-btn']}
              onClick={() => cancelRun.mutate()}
              type="button"
            >
              ■ Stop
            </button>
          ) : (
            <button
              className={styles['send-btn']}
              onClick={() => doSend(input)}
              disabled={isSettingUp || isFailed || !input.trim() || status === 'closed'}
              type="button"
            >
              Send ↑
            </button>
          )}
        </div>
      </div>

      {changesOpen && (
        <div className={styles['changes-pane']} style={{ width: panelWidth }}>
          <div
            className={styles['resize-handle']}
            onMouseDown={onResizeStart}
            role="separator"
            aria-orientation="vertical"
          />
          <div className={styles['changes-header']}>
            <h3 className={styles['changes-title']}>Changes</h3>
            <div className={styles['changes-header-actions']}>
              {diff?.branch && <span className={styles['branch-badge']}>{diff.branch}</span>}
              <button
                type="button"
                className={styles['collapse-btn']}
                onClick={() => setChangesOpen(false)}
                title="Collapse changes panel"
              >
                ▶
              </button>
            </div>
          </div>

          {!isRunning && sessionId && session?.branchName && diff && diff.changedFiles.length > 0 && (
            <ReadyToTest
              branchName={session.branchName}
              sessionId={sessionId}
            />
          )}

          {diff && diff.changedFiles.length > 0 ? (
            <div className={styles['diff-container']}>
              <DiffViewer diffText={diff.diffText} />
            </div>
          ) : (
            <div className={styles['no-changes']}>No changes yet. The agent will modify files as it works.</div>
          )}
        </div>
      )}

      {!changesOpen && (
        <button
          type="button"
          className={styles['expand-tab']}
          onClick={() => setChangesOpen(true)}
          title="Show changes panel"
        >
          <span className={styles['expand-arrow']}>◀</span>
          Changes {diff && diff.changedFiles.length > 0 && `(${diff.changedFiles.length})`}
        </button>
      )}
    </div>
  );
};
