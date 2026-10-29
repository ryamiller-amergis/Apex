/**
 * Drill into one step of a run, in the manner of a pipeline job log: the run's steps down the left,
 * and for the selected one a live log (agent tool calls, reasoning, replies, or Cloud Agent
 * activity) plus its resolved input and output.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Brain,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  CircleX,
  Clock,
  Loader2,
  MessageSquare,
  Terminal,
  TriangleAlert,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react';
import type {
  PlaybookStepActivityEntry,
  PlaybookStepActivityKind,
  PlaybookStepRun,
  PlaybookStepRunStatus,
  PlaybookSuspensionDetail,
} from '../../shared/types/playbook';
import type { CloudAgentActivityKind } from '../../shared/types/devWorkbench';
import { usePlaybookStepActivity, usePlaybookStepOutput } from '../hooks/usePlaybookRuns';
import { useCloudAgentActivityStream } from '../hooks/useDevWorkbench';
import { absoluteTime, stepStatusLabel } from './playbookStatusFormat';
import { stepMeta } from './playbookStepCatalog';
import { PlaybookSuspensionDetail as SuspensionDetail } from './PlaybookSuspensionDetail';
import styles from './PlaybookStepDetailDrawer.module.css';

interface PlaybookStepDetailDrawerProps {
  project: string;
  runId: string;
  step: PlaybookStepRun;
  /** Every step in the run. When given, the drawer lists them so you can move between steps. */
  steps?: readonly PlaybookStepRun[];
  onSelectStep?: (stepRunId: string) => void;
  suspension?: PlaybookSuspensionDetail | null;
  onClose: () => void;
  'data-testid'?: string;
}

const LIVE_STATUSES: readonly PlaybookStepRunStatus[] = ['pending', 'running', 'suspended'];

const STATUS_ICONS: Record<PlaybookStepRunStatus, LucideIcon> = {
  pending: CircleDashed,
  running: Loader2,
  suspended: Clock,
  completed: CircleCheck,
  failed: CircleX,
  failed_retryable: TriangleAlert,
  cancelled: CircleSlash,
  expired: CircleSlash,
};

const ENTRY_ICONS: Record<PlaybookStepActivityKind, LucideIcon> = {
  prompt: Terminal,
  tool: Wrench,
  thinking: Brain,
  message: MessageSquare,
  status: CircleDashed,
  error: CircleX,
};

function StatusIcon({ status, size = 14 }: { status: PlaybookStepRunStatus; size?: number }) {
  const Icon = STATUS_ICONS[status];
  return (
    <Icon
      size={size}
      aria-hidden
      className={`${styles.statusIcon} ${status === 'running' ? styles.spin : ''}`}
      data-status={status}
    />
  );
}

function duration(fromIso: string | null, toIso: string | null, now: number): string {
  if (!fromIso) return '';
  const ms = Math.max(0, (toIso ? Date.parse(toIso) : now) - Date.parse(fromIso));
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function clockTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  return now;
}

/** Lines for steps without an agent: when it started, what it waits on, how it ended. */
function lifecycleEntries(step: PlaybookStepRun, suspension: PlaybookSuspensionDetail | null | undefined): PlaybookStepActivityEntry[] {
  const entries: PlaybookStepActivityEntry[] = [];
  entries.push({ id: `${step.id}-created`, kind: 'status', title: 'Queued', at: step.createdAt });
  if (step.startedAt) entries.push({ id: `${step.id}-started`, kind: 'status', title: 'Started', at: step.startedAt });
  if (step.status === 'suspended') {
    entries.push({
      id: `${step.id}-waiting`,
      kind: 'status',
      title: step.stepType === 'approval-gate' ? 'Waiting for an approval decision' : 'Waiting',
      detail: suspension?.stepId === step.stepId && step.expiresAt ? `Deadline ${absoluteTime(step.expiresAt)}` : undefined,
      at: step.updatedAt,
    });
  }
  if (step.completedAt) {
    entries.push({
      id: `${step.id}-finished`,
      kind: step.status === 'completed' ? 'status' : 'error',
      title: stepStatusLabel(step.status),
      at: step.completedAt,
    });
  }
  return entries;
}

const LogConsole: React.FC<{ entries: readonly PlaybookStepActivityEntry[]; live: boolean; startedAt: string | null }> = ({
  entries,
  live,
  startedAt,
}) => {
  const ref = useRef<HTMLOListElement>(null);
  const [follow, setFollow] = useState(true);
  useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [entries.length, follow]);
  return (
    <div className={styles.console}>
      <div className={styles.consoleBar}>
        <span>{entries.length} {entries.length === 1 ? 'line' : 'lines'}</span>
        {live ? (
          <label className={styles.follow}>
            <input
              type="checkbox"
              checked={follow}
              onChange={(event) => setFollow(event.target.checked)}
              {...{ 'data-testid': "playbook-step-log-follow" }}
            />
            Follow
          </label>
        ) : null}
      </div>
      <ol
        ref={ref}
        className={styles.consoleLines}
        onScroll={(event) => {
          const el = event.currentTarget;
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
        }}
        {...{ 'data-testid': "playbook-step-log" }}
      >
        {entries.length === 0 ? (
          <li className={styles.consoleEmpty}>{live ? 'Waiting for the first output…' : 'Nothing was logged.'}</li>
        ) : null}
        {entries.map((entry) => {
          const Icon = ENTRY_ICONS[entry.kind];
          return (
            <li key={entry.id} className={styles.line} data-kind={entry.kind}>
              <span className={styles.lineTime} title={entry.at ? absoluteTime(entry.at) : undefined}>
                {!entry.at ? '' : startedAt ? `+${duration(startedAt, entry.at, Date.parse(entry.at))}` : clockTime(entry.at)}
              </span>
              <Icon size={13} aria-hidden className={styles.lineIcon} />
              <span className={styles.lineBody}>
                <span className={styles.lineTitle}>{entry.title}</span>
                {entry.detail ? <span className={styles.lineDetail}>{entry.detail}</span> : null}
              </span>
            </li>
          );
        })}
        {live ? (
          <li className={styles.cursorLine} aria-hidden>
            <span className={styles.cursorBlink} />
          </li>
        ) : null}
      </ol>
    </div>
  );
};

const AGENT_PHASES = [
  { key: 'queued', label: 'Queued' },
  { key: 'running', label: 'Working' },
  { key: 'done', label: 'Finished' },
] as const;

function agentPhaseIndex(status: string | undefined, stepStatus: PlaybookStepRunStatus): number {
  if (!LIVE_STATUSES.includes(stepStatus)) return 2;
  if (!status || status === 'queued' || status === 'dispatched') return 0;
  if (status === 'running' || status === 'cancelling') return 1;
  return 2;
}

const StepLog: React.FC<{
  project: string;
  runId: string;
  step: PlaybookStepRun;
  suspension?: PlaybookSuspensionDetail | null;
}> = ({ project, runId, step, suspension }) => {
  const live = LIVE_STATUSES.includes(step.status);
  const isAgent = step.stepType === 'cursor-agent';
  const isCloud = step.stepType === 'cloud-agent' && Boolean(step.agentRunId);
  const activity = usePlaybookStepActivity(project, runId, isAgent ? step.id : null, live);
  const cloud = useCloudAgentActivityStream(
    isCloud ? step.resumeToken : null,
    isCloud ? step.agentRunId : null,
    isCloud,
  );

  const entries = useMemo<PlaybookStepActivityEntry[]>(() => {
    if (isAgent) return activity.data?.entries ?? [];
    if (isCloud) {
      const kinds: Record<CloudAgentActivityKind, PlaybookStepActivityKind> = {
        assistant: 'message',
        thinking: 'thinking',
        tool: 'tool',
        status: 'status',
        task: 'status',
      };
      return cloud.events.map((event) => ({
        id: event.id,
        kind: event.status === 'failed' ? 'error' : kinds[event.kind],
        title: event.title,
        detail: event.detail,
        at: '',
      }));
    }
    return lifecycleEntries(step, suspension);
  }, [activity.data?.entries, cloud.events, isAgent, isCloud, step, suspension]);

  const agentRun = activity.data?.agentRun;
  const phase = agentPhaseIndex(agentRun?.status, step.status);

  return (
    <div className={styles.logPane}>
      {isAgent || isCloud ? (
        <ol className={styles.phases} aria-label="Progress">
          {AGENT_PHASES.map((item, index) => (
            <li
              key={item.key}
              className={styles.phase}
              data-state={index < phase ? 'done' : index === phase ? (live ? 'active' : 'done') : 'todo'}
            >
              <span className={styles.phaseDot} />
              {item.label}
            </li>
          ))}
        </ol>
      ) : null}
      {agentRun?.label && live ? (
        <p className={styles.nowDoing}>
          <Loader2 size={13} aria-hidden className={styles.spin} /> {agentRun.label}
        </p>
      ) : null}
      {activity.isError ? <p className={styles.error}>The live log could not be loaded.</p> : null}
      {cloud.error ? <p className={styles.error}>{cloud.error}</p> : null}
      <LogConsole entries={entries} live={live} startedAt={step.startedAt} />
    </div>
  );
};

const StepDetails: React.FC<{
  project: string;
  runId: string;
  step: PlaybookStepRun;
  suspension?: PlaybookSuspensionDetail | null;
}> = ({ project, runId, step, suspension }) => {
  const [loadFullOutput, setLoadFullOutput] = useState(false);
  const output = usePlaybookStepOutput(project, runId, step.id, loadFullOutput);
  const outputUrl = `/api/playbooks/runs/${encodeURIComponent(runId)}`
    + `/steps/${encodeURIComponent(step.id)}`
    + `/output?project=${encodeURIComponent(project)}&part=full`;
  return (
    <>
      <section className={styles.section}>
        <h3>Timing</h3>
        <p>
          {step.startedAt ? `Started ${absoluteTime(step.startedAt)}` : 'Not started'}
          {step.completedAt ? ` · Finished ${absoluteTime(step.completedAt)}` : ''}
        </p>
      </section>

      {step.stepType === 'apex-action' && step.inputInline && typeof step.inputInline.operation === 'string' ? (
        <section className={styles.section}>
          <h3>Operation</h3>
          <p>{step.inputInline.operation}</p>
        </section>
      ) : null}

      <section className={styles.section}>
        <h3>Resolved input</h3>
        <pre className={styles.code}>{JSON.stringify(step.inputInline ?? {}, null, 2)}</pre>
      </section>

      <section className={styles.section}>
        <h3>Output summary</h3>
        <pre className={styles.code}>{JSON.stringify(step.outputInline ?? {}, null, 2)}</pre>
        <p className={styles.muted}>
          {step.outputBlobRef
            ? `${step.outputBlobRef.sizeBytes.toLocaleString()} bytes · ${
                output.data ? 'checksum verified' : 'checksum verified when opened'
              }`
            : 'Stored inline'}
        </p>
        {step.status === 'completed' ? (
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.action}
              onClick={() => setLoadFullOutput(true)}
              disabled={output.isFetching}
              {...{ 'data-testid': "playbook-step-output-preview" }}
            >
              {output.isFetching ? 'Loading…' : 'Preview full output'}
            </button>
            <a
              className={styles.action}
              href={outputUrl}
              download
              {...{ 'data-testid': "playbook-step-output-download" }}
            >
              Download
            </a>
          </div>
        ) : null}
        {output.isError ? (
          <p className={styles.error}>Full output is unavailable or the output feature is disabled.</p>
        ) : null}
        {output.data ? (
          <>
            <h3>Full output</h3>
            <pre className={styles.code}>{JSON.stringify(output.data, null, 2)}</pre>
          </>
        ) : null}
      </section>

      {step.agentRunId ? (
        <section className={styles.section}>
          <h3>Agent run</h3>
          <code>{step.agentRunId}</code>
        </section>
      ) : null}

      {suspension?.stepId === step.stepId ? (
        <section className={styles.section}>
          <SuspensionDetail suspension={suspension} />
        </section>
      ) : null}
    </>
  );
};

export const PlaybookStepDetailDrawer: React.FC<PlaybookStepDetailDrawerProps> = ({
  project,
  runId,
  step,
  steps,
  onSelectStep,
  suspension,
  onClose,
  'data-testid': testId = 'playbook-step-detail',
}) => {
  const [tab, setTab] = useState<'log' | 'details'>('log');
  const live = LIVE_STATUSES.includes(step.status);
  const now = useNow(live || Boolean(steps?.some((candidate) => LIVE_STATUSES.includes(candidate.status))));
  const meta = stepMeta(step.stepType);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose]);

  const ordered = useMemo(
    () => [...(steps ?? [])].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [steps],
  );

  return (
    <div className={styles.backdrop} role="presentation" onMouseDown={onClose}>
      <aside
        className={`${styles.drawer} ${ordered.length && onSelectStep ? styles.drawerWide : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="playbook-step-detail-title"
        onMouseDown={(event) => event.stopPropagation()}
        {...{ 'data-testid': testId }}
      >
        {ordered.length && onSelectStep ? (
          <nav className={styles.stages} aria-label="Run steps">
            <h3 className={styles.stagesTitle}>Steps</h3>
            <ol className={styles.stageList}>
              {ordered.map((candidate) => (
                <li key={candidate.id}>
                  <button
                    type="button"
                    className={`${styles.stage} ${candidate.id === step.id ? styles.stageActive : ''}`}
                    aria-current={candidate.id === step.id}
                    onClick={() => onSelectStep(candidate.id)}
                    {...{ 'data-testid': `playbook-step-detail-stage-${candidate.stepId}` }}
                  >
                    <StatusIcon status={candidate.status} />
                    <span className={styles.stageText}>
                      <span className={styles.stageName}>{stepMeta(candidate.stepType).title}</span>
                      <span className={styles.stageId}>{candidate.stepId}</span>
                    </span>
                    <span className={styles.stageTime}>
                      {duration(candidate.startedAt, candidate.completedAt, now)}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </nav>
        ) : null}

        <div className={styles.main}>
          <header className={styles.header}>
            <div className={styles.headerText}>
              <h2 id="playbook-step-detail-title" className={styles.title}>
                {meta.title} <span className={styles.titleId}>{step.stepId}</span>
              </h2>
              <p className={styles.meta}>
                <span className={styles.statusPill} data-status={step.status}>
                  <StatusIcon status={step.status} size={12} /> {stepStatusLabel(step.status)}
                </span>
                {step.startedAt ? (
                  <span className={styles.elapsed}>
                    <Clock size={12} aria-hidden /> {duration(step.startedAt, step.completedAt, now)}
                  </span>
                ) : null}
              </p>
            </div>
            <button
              type="button"
              className={styles.close}
              onClick={onClose}
              aria-label="Close step detail"
              {...{ 'data-testid': "playbook-step-detail-close" }}
            >
              <X size={16} aria-hidden />
            </button>
          </header>

          <div className={styles.tabs} role="tablist" aria-label="Step detail">
            {([['log', 'Log'], ['details', 'Input and output']] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                className={`${styles.tab} ${tab === value ? styles.tabActive : ''}`}
                onClick={() => setTab(value)}
                {...{ 'data-testid': `playbook-step-detail-tab-${value}` }}
              >
                {label}
              </button>
            ))}
          </div>

          <div className={styles.body}>
            {tab === 'log' ? (
              <StepLog key={step.id} project={project} runId={runId} step={step} suspension={suspension} />
            ) : (
              <StepDetails key={step.id} project={project} runId={runId} step={step} suspension={suspension} />
            )}
          </div>
        </div>
      </aside>
    </div>
  );
};

export default PlaybookStepDetailDrawer;
