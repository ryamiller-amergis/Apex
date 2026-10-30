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

export const LIVE_STATUSES: readonly PlaybookStepRunStatus[] = ['pending', 'running', 'suspended'];

const FAILED_STATUSES: readonly PlaybookStepRunStatus[] = ['failed', 'failed_retryable', 'expired'];

/** The reason a failed step recorded, when it recorded one. */
export function stepFailureReason(step: PlaybookStepRun): string | null {
  if (!FAILED_STATUSES.includes(step.status)) return null;
  const error = step.outputInline?.error;
  return typeof error === 'string' && error.trim() ? error.trim() : null;
}

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

export function StatusIcon({ status, size = 14 }: { status: PlaybookStepRunStatus; size?: number }) {
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

export function duration(fromIso: string | null, toIso: string | null, now: number): string {
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

export function useNow(live: boolean): number {
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

type LogFilter = 'all' | 'message' | 'tool' | 'thinking';

const LOG_FILTERS: ReadonlyArray<{ value: LogFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'message', label: 'Replies' },
  { value: 'tool', label: 'Tools' },
  { value: 'thinking', label: 'Thinking' },
];

const LONG_DETAIL_CHARS = 280;

const LogDetail: React.FC<{ kind: PlaybookStepActivityKind; detail: string }> = ({ kind, detail }) => {
  const long = detail.length > LONG_DETAIL_CHARS || detail.split('\n').length > 5;
  const [open, setOpen] = useState(!long || kind === 'error');
  return (
    <div className={styles.entryDetailWrap}>
      <div className={`${styles.entryDetail} ${open ? '' : styles.entryDetailClamped}`} data-kind={kind}>
        {detail}
      </div>
      {long && kind !== 'error' ? (
        <button
          type="button"
          className={styles.entryMore}
          onClick={() => setOpen((value) => !value)}
          {...{ 'data-testid': 'playbook-step-log-more' }}
        >
          {open ? 'Show less' : 'Show more'}
        </button>
      ) : null}
    </div>
  );
};

export const LogConsole: React.FC<{
  entries: readonly PlaybookStepActivityEntry[];
  live: boolean;
  startedAt: string | null;
  showKindFilters?: boolean;
}> = ({
  entries,
  live,
  startedAt,
  showKindFilters = true,
}) => {
  const ref = useRef<HTMLOListElement>(null);
  const [follow, setFollow] = useState(true);
  const [filter, setFilter] = useState<LogFilter>('all');
  const shown = useMemo(
    () => (filter === 'all' ? entries : entries.filter((entry) => entry.kind === filter || entry.kind === 'error')),
    [entries, filter],
  );
  const counts = useMemo(() => {
    const result: Record<LogFilter, number> = { all: entries.length, message: 0, tool: 0, thinking: 0 };
    for (const entry of entries) {
      if (entry.kind === 'message' || entry.kind === 'tool' || entry.kind === 'thinking') result[entry.kind] += 1;
    }
    return result;
  }, [entries]);
  useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [shown.length, follow]);
  return (
    <div className={styles.console}>
      <div className={styles.consoleBar}>
        {showKindFilters ? (
        <div className={styles.filters} role="group" aria-label="Filter log">
          {LOG_FILTERS.map((item) => (
            <button
              key={item.value}
              type="button"
              className={`${styles.filter} ${filter === item.value ? styles.filterActive : ''}`}
              aria-pressed={filter === item.value}
              onClick={() => setFilter(item.value)}
              {...{ 'data-testid': `playbook-step-log-filter-${item.value}` }}
            >
              {item.label}
              <span className={styles.filterCount}>{counts[item.value]}</span>
            </button>
          ))}
        </div>
        ) : null}
        {live ? (
          <label className={styles.follow}>
            <input
              type="checkbox"
              className={styles.followInput}
              checked={follow}
              onChange={(event) => setFollow(event.target.checked)}
              {...{ 'data-testid': "playbook-step-log-follow" }}
            />
            <span className={styles.followTrack} aria-hidden />
            Follow
          </label>
        ) : null}
      </div>
      <ol
        ref={ref}
        className={styles.timeline}
        onScroll={(event) => {
          const el = event.currentTarget;
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
        }}
        {...{ 'data-testid': "playbook-step-log" }}
      >
        {shown.length === 0 ? (
          <li className={styles.consoleEmpty}>
            {live ? 'Waiting for the first output…' : filter === 'all' ? 'Nothing was logged.' : 'No entries of this kind.'}
          </li>
        ) : null}
        {shown.map((entry) => {
          const Icon = ENTRY_ICONS[entry.kind];
          return (
            <li key={entry.id} className={styles.entry} data-kind={entry.kind}>
              <span className={styles.entryDot} aria-hidden>
                <Icon size={12} />
              </span>
              <div className={styles.entryBody}>
                <div className={styles.entryHead}>
                  <span className={styles.entryTitle}>{entry.title}</span>
                  {entry.at ? (
                    <time className={styles.entryTime} dateTime={entry.at} title={absoluteTime(entry.at)}>
                      {startedAt ? `+${duration(startedAt, entry.at, Date.parse(entry.at))}` : clockTime(entry.at)}
                    </time>
                  ) : null}
                </div>
                {entry.detail ? <LogDetail kind={entry.kind} detail={entry.detail} /> : null}
              </div>
            </li>
          );
        })}
        {live ? (
          <li className={styles.entry} data-kind="live" aria-label="Still running">
            <span className={styles.entryDot} aria-hidden>
              <span className={styles.typing}><i /><i /><i /></span>
            </span>
            <div className={styles.entryBody}>
              <span className={styles.entryLive}>Working</span>
            </div>
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

export const StepLog: React.FC<{
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
  const failure = stepFailureReason(step);

  return (
    <div className={styles.logPane}>
      {failure ? (
        <div className={styles.failure} role="alert" {...{ 'data-testid': 'playbook-step-failure' }}>
          <CircleX size={16} aria-hidden className={styles.failureIcon} />
          <div>
            <p className={styles.failureTitle}>
              {step.status === 'failed_retryable' ? 'This step failed. You can retry it.' : 'This step failed.'}
            </p>
            <p className={styles.failureText}>{failure}</p>
          </div>
        </div>
      ) : null}
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
      <LogConsole
        entries={entries}
        live={live}
        startedAt={step.startedAt}
        showKindFilters={isAgent || isCloud}
      />
    </div>
  );
};

export const StepDetails: React.FC<{
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

      {typeof step.outputInline?.reportMd === 'string' && step.outputInline.reportMd.trim() ? (
        <section className={styles.section}>
          <h3>Report</h3>
          <pre className={styles.report}>{step.outputInline.reportMd}</pre>
        </section>
      ) : null}

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
        {output.data && typeof output.data.reportMd === 'string' && output.data.reportMd.trim()
          && output.data.reportMd !== step.outputInline?.reportMd ? (
          <>
            <h3>Report</h3>
            <pre className={styles.report}>{output.data.reportMd}</pre>
          </>
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
