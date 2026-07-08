import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useLocation, useNavigate } from 'react-router-dom';
import { useChatThread, useSendMessage, useCancelRun } from '../hooks/useChatThreads';
import { useChatStream } from '../hooks/useChatStream';
import {
  useDevSession,
  useDevDiff,
  usePushBranch,
  useCreatePr,
  useSessionConflicts,
  useResolveConflict,
  useCompleteMerge,
  useAbortMerge,
} from '../hooks/useDevWorkbench';
import type { ChatMessage } from '../../shared/types/chat';
import type { ConflictedFile } from '../../shared/types/devWorkbench';
import { parseAgentMessage, type ChoiceBlock } from '../utils/parseAgentMessage';
import { parseAgentTodos } from '../utils/parseAgentTodos';
import { AgentChecklist } from './AgentChecklist';
import { ThinkingIcon, ReasoningIcon } from './icons/AgentIcons';
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

function useElapsed(ts: number | null, active: boolean): string {
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    if (!active || !ts) return;
    const id = window.setInterval(() => forceUpdate((n) => n + 1), 5_000);
    return () => window.clearInterval(id);
  }, [active, ts]);
  if (!ts) return '';
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 10) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s ago`;
}

const WORKING_WORDS = [
  'Working', 'Shimmering', 'Thinking', 'Crunching',
  'Compacting', 'Wrangling', 'Conjuring', 'Noodling',
];

function useRotatingWord(active: boolean): string {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setI((n) => (n + 1) % WORKING_WORDS.length), 3_000);
    return () => window.clearInterval(id);
  }, [active]);
  return WORKING_WORDS[i];
}

const AgentTurnBlock: React.FC<{
  turn: AgentTurn;
  isLive?: boolean;
  streamingText?: string;
  onSend?: (text: string) => void;
  isRunning?: boolean;
  interactive?: boolean;
}> = ({ turn, isLive, streamingText, onSend, isRunning, interactive }) => {
  const [expanded, setExpanded] = useState(isLive ? true : false);
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const word = useRotatingWord(!!isLive);

  const stepCount = turn.reasoning.length + turn.tools.length;
  const hasActivity = stepCount > 0 || (isLive && streamingText);

  const lastActivityTs = useMemo(() => {
    const allMsgs = [...turn.reasoning, ...turn.tools];
    if (allMsgs.length === 0) return null;
    return Math.max(...allMsgs.map((m) => new Date(m.ts).getTime()));
  }, [turn]);

  const elapsed = useElapsed(lastActivityTs, !!isLive);

  useEffect(() => {
    if (isLive) setExpanded(true);
  }, [isLive]);

  useEffect(() => {
    if (isLive && expanded) logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turn, streamingText, isLive, expanded]);

  const totalLiveEntries = turn.reasoning.length + turn.tools.length + (isLive && streamingText ? 1 : 0);

  return (
    <div className={styles['turn-block']}>
      {hasActivity && (
        <div className={`${styles['turn-activity']} ${isLive ? styles['turn-activity-live'] : ''}`}>
          <button
            type="button"
            className={styles['turn-activity-toggle']}
            onClick={() => setExpanded((p) => !p)}
          >
            <span className={styles['turn-toggle-arrow']}>{expanded ? '▼' : '▶'}</span>
            {isLive ? (
              <>
                <span className={styles.shimmer}>{word}…</span>
                <span className={styles['elapsed-hint']}>
                  · {stepCount} step{stepCount !== 1 ? 's' : ''}{elapsed ? ` · ${elapsed}` : ''}
                </span>
              </>
            ) : (
              <span>{`Agent activity — ${stepCount} step${stepCount !== 1 ? 's' : ''}`}</span>
            )}
          </button>

          {expanded && (
            <div className={styles['activity-log']}>
              {turn.reasoning.map((msg, i) => {
                const entryIdx = i;
                const isActiveEntry = isLive && entryIdx === totalLiveEntries - 1;
                const isPastEntry = isLive && entryIdx < totalLiveEntries - 1;
                const isThinking = msg.toolName === '_thinking';
                return (
                  <div
                    key={msg.id}
                    className={[
                      styles['log-entry'],
                      isActiveEntry ? styles['log-entry-active'] : '',
                    ].filter(Boolean).join(' ')}
                  >
                    <span className={styles['log-icon']} role="img" aria-label={isThinking ? 'Thinking' : 'Reasoning'}>
                      {isThinking ? <ThinkingIcon /> : <ReasoningIcon />}
                    </span>
                    <div className={styles['log-content']}>
                      <div className={styles['log-label']}>{isThinking ? 'Thinking' : 'Reasoning'}</div>
                      <div className={styles['log-text']}>{msg.text}</div>
                    </div>
                    {isLive && (
                      <span className={[
                        styles['log-status'],
                        isPastEntry ? styles['log-status-completed'] : isActiveEntry ? styles['log-status-running'] : '',
                      ].filter(Boolean).join(' ')}>
                        {isPastEntry ? '✓' : isActiveEntry ? '●' : ''}
                      </span>
                    )}
                    <span className={styles['log-time']}>{new Date(msg.ts).toLocaleTimeString()}</span>
                  </div>
                );
              })}
              {turn.tools.map((msg, i) => {
                const { icon, label } = describeToolCall(msg.toolName, msg.toolInput);
                const entryIdx = turn.reasoning.length + i;
                const isActiveEntry = isLive && entryIdx === totalLiveEntries - 1 && !streamingText;
                const isPastEntry = isLive && (entryIdx < totalLiveEntries - 1 || !!streamingText);
                return (
                  <div
                    key={msg.id}
                    className={[
                      styles['log-entry'],
                      isActiveEntry ? styles['log-entry-active'] : '',
                    ].filter(Boolean).join(' ')}
                  >
                    <span className={styles['log-icon']}>{icon}</span>
                    <div className={styles['log-content']}>
                      <span className={styles['log-label']}>{label}</span>
                    </div>
                    {isLive && (
                      <span className={[
                        styles['log-status'],
                        isPastEntry ? styles['log-status-completed'] : isActiveEntry ? styles['log-status-running'] : '',
                      ].filter(Boolean).join(' ')}>
                        {isPastEntry ? '✓' : isActiveEntry ? '●' : ''}
                      </span>
                    )}
                    <span className={styles['log-time']}>{new Date(msg.ts).toLocaleTimeString()}</span>
                  </div>
                );
              })}
              {isLive && streamingText && (
                <div className={`${styles['log-entry']} ${styles['log-entry-active']}`}>
                  <span className={styles['log-icon']} role="img" aria-label="Reasoning">
                    <ReasoningIcon />
                  </span>
                  <div className={styles['log-content']}>
                    <div className={styles['log-label']}>Reasoning</div>
                    <div className={styles['log-text']}>{streamingText}</div>
                  </div>
                  <span className={`${styles['log-status']} ${styles['log-status-running']}`}>●</span>
                </div>
              )}
              <div ref={logEndRef} />
            </div>
          )}
        </div>
      )}

      {turn.finalOutput && (
        <AgentBubble
          msg={turn.finalOutput}
          onSend={onSend}
          isRunning={isRunning}
          interactive={interactive}
        />
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

const ChoiceBlockUI: React.FC<{
  block: ChoiceBlock;
  questionNumber: number;
  selection: string | null;
  freeform: string;
  locked: boolean;
  onSelect: (letter: string) => void;
  onFreeform: (text: string) => void;
}> = ({ block, questionNumber, selection, freeform, locked, onSelect, onFreeform }) => {
  const showFreeform = selection === 'other';

  return (
    <div className={`${styles['choice-block']} ${locked ? styles['choice-block-locked'] : ''}`}>
      {block.question && (
        <div className={styles['choice-question']}>
          <span className={styles['choice-qnum']}>Q{questionNumber}</span>
          <div className={styles['choice-question-text']}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{block.question}</ReactMarkdown>
          </div>
        </div>
      )}
      <div className={styles['choice-options']}>
        {block.options.map((opt) => {
          const isSelected = selection === opt.letter;
          return (
            <button
              key={opt.letter}
              className={`${styles['choice-option']} ${isSelected ? styles['choice-option-selected'] : ''}`}
              onClick={() => !locked && onSelect(opt.letter)}
              disabled={locked}
              type="button"
            >
              <span className={styles['choice-option-letter']}>{opt.letter.toUpperCase()}</span>
              <span className={styles['choice-option-text']}>{opt.text}</span>
            </button>
          );
        })}
        <button
          className={`${styles['choice-option']} ${selection === 'other' ? styles['choice-option-selected'] : ''}`}
          onClick={() => !locked && onSelect('other')}
          disabled={locked}
          type="button"
        >
          <span className={styles['choice-option-letter']}>✎</span>
          <span className={styles['choice-option-text']}>Other / free-form</span>
        </button>
      </div>
      {showFreeform && !locked && (
        <textarea
          className={styles['choice-freeform']}
          placeholder="Type your answer here…"
          value={freeform}
          onChange={(e) => onFreeform(e.target.value)}
          rows={2}
        />
      )}
      {locked && freeform && (
        <div className={styles['choice-freeform-locked']}>{freeform}</div>
      )}
    </div>
  );
};

interface QuestionState {
  selected: string | null;
  freeform: string;
}

const AgentBubble: React.FC<{
  msg: ChatMessage;
  onSend?: (text: string) => void;
  isRunning?: boolean;
  interactive?: boolean;
}> = ({ msg, onSend, isRunning = false, interactive = false }) => {
  const parts = parseAgentMessage(msg.text);
  const choiceBlocks = parts.filter((p): p is ChoiceBlock => p.type === 'choices');

  const [selections, setSelections] = useState<Record<string, QuestionState>>(() => {
    const init: Record<string, QuestionState> = {};
    for (const b of choiceBlocks) init[b.id] = { selected: null, freeform: '' };
    return init;
  });
  const [sent, setSent] = useState(false);

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
    if (!allAnswered || sent || !onSend) return;
    const lines: string[] = [];
    let qNum = 1;
    for (const block of choiceBlocks) {
      const s = selections[block.id];
      if (!s) continue;
      if (s.selected === 'other') {
        lines.push(`Q${qNum}: ${s.freeform.trim()}`);
      } else if (s.selected) {
        const opt = block.options.find((o) => o.letter === s.selected);
        lines.push(`Q${qNum}: ${s.selected.toUpperCase()} — ${opt?.text ?? s.selected}`);
        if (s.freeform.trim()) lines.push(`  Additional notes: ${s.freeform.trim()}`);
      }
      qNum++;
    }
    onSend(lines.join('\n'));
    setSent(true);
  };

  const locked = sent || !interactive;
  let questionCounter = 0;

  return (
    <div className={`${styles.message} ${styles['role-agent']}`}>
      <div className={styles['agent-header']}>
        <span className={styles['agent-avatar']}>AI</span>
        <span>Agent</span>
        <span className={styles.meta}>{new Date(msg.ts).toLocaleTimeString()}</span>
      </div>
      <div className={styles['agent-bubble']}>
        {parts.map((part) => {
          if (part.type === 'markdown') {
            return (
              <div key={part.id}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{part.content}</ReactMarkdown>
              </div>
            );
          }
          questionCounter++;
          const s = selections[part.id] ?? { selected: null, freeform: '' };
          return (
            <ChoiceBlockUI
              key={part.id}
              block={part}
              questionNumber={questionCounter}
              selection={s.selected}
              freeform={s.freeform}
              locked={locked}
              onSelect={(letter) => handleSelect(part.id, letter)}
              onFreeform={(text) => handleFreeform(part.id, text)}
            />
          );
        })}

        {choiceBlocks.length > 0 && interactive && !sent && (
          <button
            className={styles['choice-send-btn']}
            onClick={handleSubmit}
            disabled={!allAnswered || isRunning}
            type="button"
          >
            {isRunning ? 'Agent is thinking…' : 'Submit answers ↑'}
          </button>
        )}
        {sent && choiceBlocks.length > 0 && (
          <div className={styles['choice-sent-label']}>✓ Answers sent</div>
        )}
      </div>
    </div>
  );
};

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

interface ReadyToTestProps {
  branchName: string;
  sessionId: string;
  branchPushed: boolean;
  existingPrUrl?: string | null;
}

const ReadyToTest: React.FC<ReadyToTestProps> = ({ branchName, sessionId, branchPushed, existingPrUrl }) => {
  const pushBranch = usePushBranch();
  const createPr = useCreatePr(sessionId);
  const [copied, setCopied] = useState(false);

  const copyBranch = useCallback(() => {
    navigator.clipboard.writeText(branchName);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [branchName]);

  const handlePush = useCallback(async () => {
    try {
      await pushBranch.mutateAsync(sessionId);
    } catch {
      // error surfaced via pushBranch.error
    }
  }, [pushBranch, sessionId]);

  const handleCreatePr = useCallback(async () => {
    try {
      await createPr.mutateAsync();
    } catch {
      // error surfaced via createPr.error
    }
  }, [createPr]);

  // State 3: PR exists
  if (existingPrUrl) {
    return (
      <div className={styles['ready-to-test']}>
        <div className={styles['ready-to-test-header']}>
          <span className={styles['ready-to-test-icon']}>&#10003;</span>
          <span className={styles['ready-to-test-title']}>Pull Request Opened</span>
        </div>
        <div className={styles['ready-to-test-body']}>
          <a
            href={existingPrUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={styles['pr-link']}
          >
            View Pull Request →
          </a>
          <div className={styles['branch-copy-row']}>
            <span className={styles['branch-label']}>Branch:</span>
            <code className={styles['branch-name-code']}>{branchName}</code>
            <button type="button" className={styles['copy-branch-btn']} onClick={copyBranch}>
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // State 2: Branch pushed, no PR yet
  if (branchPushed) {
    return (
      <div className={styles['ready-to-test']}>
        <div className={styles['ready-to-test-header']}>
          <span className={styles['ready-to-test-icon']}>&#10003;</span>
          <span className={styles['ready-to-test-title']}>Branch Pushed</span>
        </div>
        <div className={styles['ready-to-test-body']}>
          <p className={styles['ready-to-test-desc']}>
            Branch pushed successfully. Open a pull request when you are ready for review.
          </p>
          <button
            type="button"
            className={styles['create-pr-btn']}
            onClick={handleCreatePr}
            disabled={createPr.isPending}
          >
            {createPr.isPending ? 'Creating PR…' : 'Create Pull Request'}
          </button>
          {createPr.error && (
            <p className={styles['push-error']}>{createPr.error.message}</p>
          )}
          <div className={styles['branch-copy-row']}>
            <span className={styles['branch-label']}>Branch:</span>
            <code className={styles['branch-name-code']}>{branchName}</code>
            <button type="button" className={styles['copy-branch-btn']} onClick={copyBranch}>
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // State 1: Not yet pushed
  return (
    <div className={styles['ready-to-test']}>
      <div className={styles['ready-to-test-header']}>
        <span className={styles['ready-to-test-icon']}>&#10003;</span>
        <span className={styles['ready-to-test-title']}>Ready to Push</span>
      </div>
      <div className={styles['ready-to-test-body']}>
        <p className={styles['ready-to-test-desc']}>
          Push the branch and merge the latest base branch. Then create a pull request when ready.
        </p>
        <button
          type="button"
          className={styles['push-btn']}
          onClick={handlePush}
          disabled={pushBranch.isPending}
        >
          {pushBranch.isPending ? 'Pushing…' : 'Push Branch'}
        </button>
        {pushBranch.error && (
          <p className={styles['push-error']}>{pushBranch.error.message}</p>
        )}
        <div className={styles['branch-copy-row']}>
          <span className={styles['branch-label']}>Branch:</span>
          <code className={styles['branch-name-code']}>{branchName}</code>
          <button type="button" className={styles['copy-branch-btn']} onClick={copyBranch}>
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
      </div>
    </div>
  );
};

// ── MergeResolver ─────────────────────────────────────────────────────────────

interface FileEditorState {
  content: string;
  resolved: boolean;
}

const MergeResolver: React.FC<{ sessionId: string }> = ({ sessionId }) => {
  const { data: conflictsData, isLoading } = useSessionConflicts(sessionId);
  const resolveConflict = useResolveConflict(sessionId);
  const completeMerge = useCompleteMerge(sessionId);
  const abortMerge = useAbortMerge(sessionId);

  const [editors, setEditors] = useState<Record<string, FileEditorState>>({});

  useEffect(() => {
    if (!conflictsData) return;
    setEditors((prev) => {
      const next: Record<string, FileEditorState> = { ...prev };
      for (const f of conflictsData.files) {
        if (!next[f.path]) {
          next[f.path] = { content: f.content, resolved: false };
        }
      }
      return next;
    });
  }, [conflictsData]);

  const handleMarkResolved = useCallback(async (filePath: string) => {
    const editor = editors[filePath];
    if (!editor) return;
    try {
      await resolveConflict.mutateAsync({ path: filePath, content: editor.content });
      setEditors((prev) => ({ ...prev, [filePath]: { ...prev[filePath], resolved: true } }));
    } catch {
      // error surfaced via resolveConflict.error
    }
  }, [editors, resolveConflict]);

  const allResolved = conflictsData
    ? conflictsData.files.every((f) => editors[f.path]?.resolved)
    : false;

  const handleComplete = useCallback(async () => {
    try {
      await completeMerge.mutateAsync();
      // Session query is invalidated by useCompleteMerge — ReadyToTest detects branchPushed and shows "Create PR".
    } catch {
      // surfaced via completeMerge.error
    }
  }, [completeMerge]);

  if (isLoading) {
    return <div className={styles['merge-resolver']}>Loading conflicts…</div>;
  }

  const files: ConflictedFile[] = conflictsData?.files ?? [];

  return (
    <div className={styles['merge-resolver']}>
      <div className={styles['merge-resolver-header']}>
        <span className={styles['merge-conflict-icon']}>⚠</span>
        <span className={styles['merge-resolver-title']}>Merge Conflicts</span>
      </div>
      <p className={styles['merge-resolver-desc']}>
        The base branch has diverged. Resolve each conflict below, then complete the merge to push.
      </p>

      {files.map((f) => {
        const editor = editors[f.path];
        return (
          <div key={f.path} className={styles['conflict-file']}>
            <div className={styles['conflict-file-header']}>
              <code className={styles['conflict-file-path']}>{f.path}</code>
              {editor?.resolved && (
                <span className={styles['conflict-resolved-badge']}>Resolved</span>
              )}
            </div>
            <textarea
              className={styles['conflict-editor']}
              value={editor?.content ?? f.content}
              onChange={(e) =>
                setEditors((prev) => ({
                  ...prev,
                  [f.path]: { ...prev[f.path], content: e.target.value, resolved: false },
                }))
              }
              rows={12}
              spellCheck={false}
            />
            <div className={styles['conflict-file-actions']}>
              <button
                type="button"
                className={styles['resolve-btn']}
                onClick={() => void handleMarkResolved(f.path)}
                disabled={resolveConflict.isPending || editor?.resolved}
              >
                {resolveConflict.isPending ? 'Saving…' : editor?.resolved ? 'Saved' : 'Mark as Resolved'}
              </button>
            </div>
          </div>
        );
      })}

      {completeMerge.error && (
        <p className={styles['push-error']}>{completeMerge.error.message}</p>
      )}

      <div className={styles['merge-resolver-footer']}>
        <button
          type="button"
          className={styles['push-btn']}
          onClick={() => void handleComplete()}
          disabled={!allResolved || completeMerge.isPending}
        >
          {completeMerge.isPending ? 'Completing merge…' : 'Complete merge & push'}
        </button>
        <button
          type="button"
          className={styles['close-btn']}
          onClick={() => abortMerge.mutate()}
          disabled={abortMerge.isPending}
        >
          {abortMerge.isPending ? 'Aborting…' : 'Abort merge'}
        </button>
      </div>
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
  const isConflict = session?.status === 'conflict';

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

  const checklist = useMemo(
    () => parseAgentTodos(visibleMessages),
    [visibleMessages],
  );

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

        {!isSettingUp && !isFailed && (
          <div className={styles['checklist-sticky']}>
            <AgentChecklist checklist={checklist} isRunning={isRunning} />
          </div>
        )}

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
                  const isLastTurn = turnIdx === turns.length - 1;
                  elements.push(
                    <AgentTurnBlock
                      key={`turn-${turnIdx}`}
                      turn={turn}
                      onSend={doSend}
                      isRunning={isRunning}
                      interactive={isLastTurn && !isRunning}
                    />,
                  );
                  turnIdx++;
                } else {
                  elements.push(
                    <AgentBubble
                      key={msg.id}
                      msg={msg}
                      onSend={doSend}
                      isRunning={isRunning}
                      interactive={!isRunning}
                    />,
                  );
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

            {/* Show remaining turns that had no final output (e.g. agent was stopped) */}
            if (!isRunning && turnIdx < turns.length) {
              for (let t = turnIdx; t < turns.length; t++) {
                const orphanedTurn = turns[t];
                if (orphanedTurn.reasoning.length > 0 || orphanedTurn.tools.length > 0) {
                  elements.push(
                    <AgentTurnBlock
                      key={`orphan-turn-${t}`}
                      turn={orphanedTurn}
                    />,
                  );
                }
              }
            }

            if (!isRunning && !isSettingUp && elements.length === 0 && messages.length > 0) {
              elements.push(
                <div key="orphaned-notice" className={styles['system-msg']}>
                  The agent performed work in this session but the response was not captured
                  (likely due to a server restart). You can send a follow-up message to continue,
                  or check the Changes panel for any completed work.
                </div>,
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
            placeholder={isSettingUp ? 'Setting up workspace…' : isConflict ? 'Resolve merge conflicts first…' : isRunning ? 'Agent is working…' : 'Ask the agent to implement changes…'}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={isSettingUp || isFailed || isConflict || isRunning || status === 'closed'}
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
              disabled={isSettingUp || isFailed || isConflict || !input.trim() || status === 'closed'}
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

          {isConflict && sessionId && (
            <MergeResolver sessionId={sessionId} />
          )}

          {!isRunning && !isSettingUp && !isFailed && !isConflict && sessionId && session?.branchName && diff && (diff.changedFiles.length > 0 || diff.branchPushed || session?.branchPushed) && (
            <ReadyToTest
              branchName={session.branchName}
              sessionId={sessionId}
              branchPushed={session.branchPushed ?? false}
              existingPrUrl={session.prUrl}
            />
          )}

          {diff && diff.changedFiles.length > 0 ? (
            <div className={styles['diff-container']}>
              <DiffViewer diffText={diff.diffText} />
            </div>
          ) : diff?.branchPushed ? (
            <div className={styles['no-changes']}>Changes were pushed to the remote branch. Diff preview is unavailable but you can still create a PR.</div>
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
