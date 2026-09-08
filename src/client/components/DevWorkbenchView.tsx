import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppShell } from '../hooks/useAppShell';
import {
  useActiveSessions,
  useAssignedWorkItems,
  useCloseDevSession,
  useCompleteFeature,
  useCloudAgentActivityStream,
  useCloudAgentRun,
  useDevSession,
  useCancelCloudAgentRun,
  useStartCloudAgentRun,
  useStartLocalFeature,
} from '../hooks/useDevWorkbench';
import { useFeatureFlag } from '../hooks/useFeatureFlags';
import { MY_WORK_CLOUD_AGENT_FLAG } from '../../shared/types/featureFlags';
import { useApexBacklogFeatures } from '../hooks/useApexBacklog';
import { useAssignedBoardItems } from '../hooks/useApexWorkItems';
import type { ApexWorkItem } from '../../shared/types/apexWorkItem';
import { STATUS_META } from '../../shared/types/apexWorkItem';
import type {
  AssignedWorkItem,
  BacklogFeatureItem,
  ActiveDevSession,
  ApexBacklogGroup,
  CloudAgentActivityEvent,
  CloudAgentRunSummary,
} from '../../shared/types/devWorkbench';
import { isAppNativeRequirementsProject } from '../../shared/types/devWorkbench';
import {
  computeFeatureWorkStatus,
  formatMyWorkStatusLabel,
  rollupWorkStatus,
  type MyWorkStatus,
} from '../../shared/utils/myWorkStatus';
import StartLocalDevModal, { type StartLocalDevTarget } from './StartLocalDevModal';
import FeatureContextModal from './FeatureContextModal';
import { LeftoverWorkList } from './LeftoverWorkList';
import { CurrentRunChecksSummary } from './CurrentRunChecksSummary';
import styles from './DevWorkbenchView.module.css';

const BoardAssignedSection: React.FC<{ project: string }> = ({ project }) => {
  const navigate = useNavigate();
  const { data: boardItems, isLoading, error } = useAssignedBoardItems(project);

  return (
    <section
      className={styles.section}
      aria-labelledby="board-assigned-heading"
      {...{ 'data-testid': 'my-work-board-assigned-section' }}
    >
      <div className={styles['section-header']}>
        <h2 id="board-assigned-heading">Work Board assignments</h2>
        <p>Items you own on the Work Board</p>
      </div>
      {isLoading && <div className={styles.loading}>Loading board items…</div>}
      {error && <div className={styles.error}>Failed to load board items: {error.message}</div>}
      {!isLoading && !error && (!boardItems || boardItems.length === 0) && (
        <div className={styles['section-empty']} {...{ 'data-testid': 'my-work-board-assigned-empty' }}>
          No Work Board items assigned to you.
        </div>
      )}
      {!!boardItems?.length && (
        <div className={styles.list} {...{ 'data-testid': 'my-work-board-assigned-list' }}>
          {boardItems.map((item: ApexWorkItem) => (
            <div key={item.id} className={styles.item}>
              <div className={styles['item-info']}>
                <span className={styles['item-title']}>{item.title}</span>
                <div className={styles['item-meta']}>
                  <span className={styles['item-id']}>APX-{item.itemNumber}</span>
                  <span className={styles.badge}>{item.type}</span>
                  <span className={styles.badge}>
                    {STATUS_META[item.status]?.label ?? item.status}
                  </span>
                </div>
              </div>
              <div className={styles['item-actions']}>
                <button
                  type="button"
                  className={styles['view-context-btn']}
                  onClick={() => navigate(`/work-board?item=${encodeURIComponent(item.id)}`)}
                  {...{ 'data-testid': `my-work-board-item-link-${item.itemNumber}` }}
                >
                  Open on board
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
};

const TIMED_OUT_REASONS = new Set(['queue_ttl', 'cloud_agent_timeout']);

function cloudRunStatusText(run: CloudAgentRunSummary): string {
  switch (run.status) {
    case 'queued':
      return 'Queued';
    case 'dispatched':
      return 'Starting';
    case 'running':
      return 'Running';
    case 'completed':
      // A run without a PR is still terminal; CurrentRunChecksSummary owns that copy.
      return run.finishedWithoutPr ? 'Finished' : 'Completed';
    case 'failed':
      return run.terminalReason && TIMED_OUT_REASONS.has(run.terminalReason)
        ? 'Timed out'
        : 'Failed';
    case 'cancelled':
      return 'Cancelled';
  }
}

/**
 * Host-agnostic PR lifecycle label for the row (PBI-007 AC-0 / AC-2). Returns
 * null when there is nothing to say, so `none` renders no text at all. The label
 * carries the meaning on its own — no color-only status (accessibility NFR).
 */
function prStatusText(run: CloudAgentRunSummary): string | null {
  if (!run.prUrl) return null;
  switch (run.prStatus) {
    case 'open':
      return 'Open';
    case 'merged':
      return 'Merged';
    case 'none':
      return null;
  }
}

interface CloudRunDrawerProps {
  item: AssignedWorkItem;
  run: CloudAgentRunSummary;
  sessionId: string | null;
  isLive: boolean;
  onClose: () => void;
}

/** Copies text without relying on clipboard permission being granted. */
function copyToClipboard(value: string): void {
  navigator.clipboard?.writeText(value).catch(() => {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'absolute';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  });
}

const CopyableId: React.FC<{
  label: string;
  value: string;
  testId: string;
}> = ({ label, value, testId }) => {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
  }, []);

  const handleCopy = () => {
    copyToClipboard(value);
    setCopied(true);
    if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    resetTimerRef.current = window.setTimeout(() => {
      setCopied(false);
      resetTimerRef.current = null;
    }, 2000);
  };

  return (
    <div className={styles['copyable-cell']}>
      <span>{label}</span>
      {copied ? (
        <span className={styles['copied-flag']} role="status">
          Copied
        </span>
      ) : null}
      <div className={styles['copyable-id']}>
        <code title={value}>{value}</code>
        <button
          type="button"
          className={styles['copy-id-btn']}
          onClick={handleCopy}
          aria-label={copied ? `${label} copied` : `Copy ${label}`}
          title={copied ? 'Copied' : `Copy ${label}`}
          data-copied={copied ? 'true' : undefined}
          {...{ 'data-testid': testId }}
        >
          {copied ? (
            <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M20 6 9 17l-5-5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
              <rect
                x="9"
                y="9"
                width="11"
                height="11"
                rx="2"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              />
              <path
                d="M5 15V5a2 2 0 0 1 2-2h8"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
};

function activityTitle(event: CloudAgentActivityEvent): string {
  if (event.kind !== 'tool' || !event.detail) return event.title;
  return `${event.title} · ${event.detail}`;
}

const CloudRunDrawer: React.FC<CloudRunDrawerProps> = ({
  item,
  run,
  sessionId,
  isLive,
  onClose,
}) => {
  const activity = useCloudAgentActivityStream(
    sessionId,
    run.runId,
    run.status !== 'queued',
  );
  const activityRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    const element = activityRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [activity.events]);

  return (
    <>
      <button
        type="button"
        className={styles['run-drawer-backdrop']}
        aria-label="Close cloud run details"
        onClick={onClose}
      />
      <aside
        className={styles['run-drawer']}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`cloud-run-drawer-title-${item.id}`}
        {...{ 'data-testid': `my-work-cloud-run-drawer-${item.id}` }}
      >
        <header className={styles['run-drawer-header']}>
          <div>
            <span className={styles['run-drawer-eyebrow']}>Cloud agent run</span>
            <h2 id={`cloud-run-drawer-title-${item.id}`}>{item.title}</h2>
            <span className={styles['run-drawer-work-item']}>Work item #{item.id}</span>
          </div>
          <button
            type="button"
            className={styles['run-drawer-close']}
            aria-label="Close cloud run details"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className={styles['run-drawer-body']}>
          <section className={styles['run-overview']} aria-label="Run overview">
            <div>
              <span>Status</span>
              <strong className={styles['run-overview-status']} data-status={run.status}>
                <i aria-hidden="true" />
                {cloudRunStatusText(run)}
              </strong>
              {run.status === 'failed' && run.lastError ? (
                <p
                  className={styles['run-failure-detail']}
                  role="alert"
                  data-testid={`my-work-cloud-run-error-${item.id}`}
                >
                  {run.lastError}
                </p>
              ) : null}
            </div>
            <CopyableId
              label="Run ID"
              value={run.runId}
              testId={`my-work-copy-run-id-${item.id}`}
            />
            {sessionId ? (
              <CopyableId
                label="Session"
                value={sessionId}
                testId={`my-work-copy-session-id-${item.id}`}
              />
            ) : null}
          </section>

          <section className={styles['run-activity']} aria-labelledby={`cloud-run-activity-${item.id}`}>
            <div className={styles['run-activity-heading']}>
              <div>
                <h3 id={`cloud-run-activity-${item.id}`}>Activity</h3>
                <p>Live agent updates and tool activity.</p>
              </div>
              {isLive ? (
                <span className={styles['live-indicator']}>
                  {activity.isConnected ? 'Live' : 'Connecting'}
                </span>
              ) : null}
            </div>
            <div
              ref={activityRef}
              className={styles['run-activity-stream']}
              aria-live="polite"
              data-testid={`my-work-cloud-run-activity-${item.id}`}
            >
              {activity.events.length > 0 ? activity.events.map((event) => (
                <div
                  key={event.id}
                  className={styles['run-activity-event']}
                  data-kind={event.kind}
                  data-status={event.status}
                >
                  <i aria-hidden="true" />
                  <div>
                    <strong>{activityTitle(event)}</strong>
                    {event.kind !== 'tool' && event.detail ? <span>{event.detail}</span> : null}
                  </div>
                </div>
              )) : (
                <div className={styles['run-activity-event']}>
                  <i aria-hidden="true" />
                  <div>
                    <strong>{cloudRunStatusText(run)}</strong>
                    <span>
                      {run.status === 'failed' && run.lastError
                        ? run.lastError
                        : run.status === 'queued'
                          ? 'Waiting for the cloud agent to start.'
                          : 'Connecting to the cloud agent activity stream…'}
                    </span>
                  </div>
                </div>
              )}
              {activity.error ? (
                <p className={styles['run-activity-error']} role="status">
                  {activity.error}
                </p>
              ) : null}
            </div>
          </section>

          {run.prUrl ? (
            <a
              className={styles['run-drawer-pr']}
              href={run.prUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open pull request <span aria-hidden="true">↗</span>
            </a>
          ) : null}
        </div>
      </aside>
    </>
  );
};

const CloudAgentEnabledRowAction: React.FC<{
  item: AssignedWorkItem;
  project: string;
  activeSession?: ActiveDevSession;
}> = ({ item, project, activeSession }) => {
  const startCloud = useStartCloudAgentRun();
  const cancelCloud = useCancelCloudAgentRun();
  const [startedSessionId, setStartedSessionId] = useState<string | null>(null);
  const [optimisticRun, setOptimisticRun] = useState<CloudAgentRunSummary | null>(null);
  const [cancelledRunId, setCancelledRunId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [reasonPinned, setReasonPinned] = useState(false);
  const reasonRef = useRef<HTMLSpanElement | null>(null);
  const sessionId = startedSessionId ?? activeSession?.id ?? null;
  const { data: polledRun } = useCloudAgentRun(sessionId);
  const { data: sessionDetail } = useDevSession(sessionId);
  const serverRun = polledRun ?? activeSession?.cloudAgentRun ?? null;
  const leftoverWork = sessionDetail
    ? sessionDetail.leftoverWork
    : sessionId === activeSession?.id
      ? activeSession.leftoverWork
      : null;
  const latestRun =
    optimisticRun && serverRun?.runId !== optimisticRun.runId
      ? optimisticRun
      : serverRun ?? optimisticRun;
  const currentRun =
    latestRun && cancelledRunId === latestRun.runId
      ? { ...latestRun, status: 'cancelled' as const }
      : latestRun;
  const eligibility = item.cloudAgentEligibility ?? {
    allowed: false,
    reason: 'Cloud Development is not available.',
  };
  const reasonId = `my-work-start-cloud-dev-reason-${item.id}`;
  const isLive =
    currentRun?.status === 'queued' ||
    currentRun?.status === 'dispatched' ||
    currentRun?.status === 'running';

  useEffect(() => {
    if (!reasonPinned) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (!reasonRef.current?.contains(event.target as Node)) setReasonPinned(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setReasonPinned(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [reasonPinned]);

  const handleStartOrResume = async () => {
    setActionError(null);
    try {
      const result = await startCloud.mutateAsync({ workItemId: item.id, project });
      setStartedSessionId(result.sessionId);
      setCancelledRunId(null);
      setOptimisticRun({
        runId: result.runId,
        status: 'queued',
        prUrl: null,
        prStatus: 'none',
        finishedWithoutPr: false,
        terminalReason: null,
        checkResults: null,
        failingChecks: [],
        lastError: null,
      });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to start Cloud Development.');
    }
  };

  const handleCancel = async () => {
    if (!sessionId || !currentRun) return;
    setActionError(null);
    try {
      await cancelCloud.mutateAsync(sessionId);
      setCancelledRunId(currentRun.runId);
      setOptimisticRun(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to cancel Cloud Development.');
    }
  };

  if (!currentRun) {
    return (
      <>
        {!eligibility.allowed && eligibility.reason ? (
          // Own line above the row's buttons so it never changes their height.
          <div className={styles['cloud-reason-row']}>
            <span
              ref={reasonRef}
              className={styles['cloud-reason']}
              data-pinned={reasonPinned ? 'true' : undefined}
            >
              <button
                type="button"
                className={styles['cloud-reason-trigger']}
                aria-expanded={reasonPinned}
                aria-controls={reasonId}
                onClick={() => setReasonPinned((pinned) => !pinned)}
                {...{ 'data-testid': `my-work-cloud-reason-toggle-${item.id}` }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
                  <path
                    d="M12 11v5M12 7.5v.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
                Why can&apos;t I start this?
              </button>
              <span
                id={reasonId}
                role="tooltip"
                className={styles['cloud-reason-popover']}
                {...{ 'data-testid': reasonId }}
              >
                {eligibility.reason}
              </span>
            </span>
          </div>
        ) : null}
        <div className={styles['cloud-slot']}>
          <button
            className={styles['cloud-dev-btn']}
            type="button"
            disabled={!eligibility.allowed || startCloud.isPending}
            title={eligibility.allowed ? 'Start a Cloud Agent on this work item' : eligibility.reason}
            aria-describedby={eligibility.allowed ? undefined : reasonId}
            onClick={() => void handleStartOrResume()}
            {...{ 'data-testid': 'my-work-start-cloud-dev-btn' }}
          >
            <span className={styles['cloud-button-icon']} aria-hidden="true">✦</span>
            {startCloud.isPending ? 'Starting cloud agent…' : 'Start cloud agent'}
          </button>
          {actionError ? (
            <span className={styles['cloud-run-error']} role="alert">
              {actionError}
            </span>
          ) : null}
        </div>
      </>
    );
  }

  const prStatusLabel = prStatusText(currentRun);

  return (
    <>
      <div className={styles['cloud-slot']}>
        <div className={styles['cloud-run-control']} data-status={currentRun.status}>
          <button
            type="button"
            className={styles['cloud-run-summary']}
            onClick={() => setDrawerOpen(true)}
            aria-label={`View cloud agent run details: ${cloudRunStatusText(currentRun)}`}
          >
            <span className={styles['cloud-status-dot']} aria-hidden="true" />
            <span className={styles['cloud-run-copy']} aria-live="polite">
              <span className={styles['cloud-run-label']}>Cloud agent</span>
              <strong
                className={styles['cloud-run-status']}
                {...{ 'data-testid': `my-work-cloud-run-status-${item.id}` }}
              >
                {cloudRunStatusText(currentRun)}
              </strong>
            </span>
            <span className={styles['cloud-details-chevron']} aria-hidden="true">›</span>
          </button>
          <div className={styles['cloud-run-actions']}>
            {currentRun.status === 'completed' && currentRun.prUrl ? (
              <a
                className={styles['cloud-pr-link']}
                href={currentRun.prUrl}
                target="_blank"
                rel="noreferrer"
                {...{ 'data-testid': `my-work-cloud-run-pr-${item.id}` }}
              >
                View PR
              </a>
            ) : null}
            {prStatusLabel ? (
              <span className={styles['cloud-pr-status']} {...{ 'data-testid': 'my-work-row-pr-status' }}>
                {prStatusLabel}
              </span>
            ) : null}
            <CurrentRunChecksSummary
              prUrl={currentRun.prUrl}
              finishedWithoutPr={currentRun.finishedWithoutPr}
              failingChecks={currentRun.failingChecks}
            />
            {sessionId ? <LeftoverWorkList sessionId={sessionId} summary={leftoverWork} /> : null}
            {currentRun.status === 'failed' && currentRun.lastError ? (
              <span
                className={styles['cloud-run-failure-detail']}
                role="alert"
                title={currentRun.lastError}
                data-testid={`my-work-cloud-run-error-${item.id}`}
              >
                {currentRun.lastError}
              </span>
            ) : null}
            {isLive ? (
              <button
                className={styles['cloud-cancel-btn']}
                type="button"
                disabled={cancelCloud.isPending}
                onClick={() => void handleCancel()}
                {...{ 'data-testid': `my-work-cancel-cloud-run-${item.id}` }}
              >
                {cancelCloud.isPending ? 'Cancelling…' : 'Cancel'}
              </button>
            ) : (
              <button
                className={styles['cloud-resume-btn']}
                type="button"
                disabled={startCloud.isPending}
                onClick={() => void handleStartOrResume()}
                {...{ 'data-testid': `my-work-resume-cloud-run-${item.id}` }}
              >
                <span aria-hidden="true">↻</span>
                {startCloud.isPending ? 'Resuming…' : 'Resume run'}
              </button>
            )}
          </div>
        </div>
        {actionError ? (
          <span className={styles['cloud-run-error']} role="alert">
            {actionError}
          </span>
        ) : null}
      </div>
      {drawerOpen ? (
        <CloudRunDrawer
          item={item}
          run={currentRun}
          sessionId={sessionId}
          isLive={isLive}
          onClose={() => setDrawerOpen(false)}
        />
      ) : null}
    </>
  );
};

const CloudAgentRowAction: React.FC<{
  item: AssignedWorkItem;
  project: string;
  activeSession?: ActiveDevSession;
}> = ({ item, project, activeSession }) => {
  const flagOn = useFeatureFlag(MY_WORK_CLOUD_AGENT_FLAG, project);

  // @feature-flag:my-work-cloud-agent start winner=enabled
  return flagOn ? (
    // @feature-flag:my-work-cloud-agent enabled-start
    <>
      <CloudAgentEnabledRowAction
        item={item}
        project={project}
        activeSession={activeSession}
      />
    </>
    // @feature-flag:my-work-cloud-agent enabled-end
  ) : (
    // @feature-flag:my-work-cloud-agent disabled-start
    null
    // @feature-flag:my-work-cloud-agent disabled-end
  );
  // @feature-flag:my-work-cloud-agent end
};

export type ApexStatusFilter = 'all' | MyWorkStatus;

export const APEX_STATUS_FILTERS: { id: ApexStatusFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'ready', label: 'Ready' },
  { id: 'in_progress', label: 'In Progress' },
  { id: 'complete', label: 'Complete' },
];

/** Keep a PRD/Epic group when filtering by feature status. */
export function filterApexBacklogByStatus(
  groups: ApexBacklogGroup[],
  sessions: ActiveDevSession[],
  filter: ApexStatusFilter,
  /** Feature keys (`prdId:featureId`) treated as Complete before sessions refetch. */
  locallyCompleted: ReadonlySet<string> = new Set(),
): ApexBacklogGroup[] {
  if (filter === 'all' && locallyCompleted.size === 0) return groups;

  return groups
    .map((group) => {
      const epics = group.epics
        .map((epic) => {
          const features = epic.features.filter((feature) => {
            const key = `${feature.prdId}:${feature.featureId}`;
            const readiness = computeFeatureWorkStatus(feature, sessions, sessions);
            const state: MyWorkStatus =
              readiness.state === 'complete' || locallyCompleted.has(key)
                ? 'complete'
                : readiness.state;
            return filter === 'all' || state === filter;
          });
          return { ...epic, features };
        })
        .filter((epic) => epic.features.length > 0);
      return { ...group, epics };
    })
    .filter((group) => group.epics.length > 0);
}

/**
 * Filter Apex backlog by a case-insensitive title query against PRD, Epic,
 * and Feature titles (also matches feature ids like FEAT-001).
 *
 * - PRD title match → keep all epics/features under that PRD
 * - Epic title match → keep all features under that epic
 * - Otherwise → keep only features whose title or id matches
 */
export function filterApexBacklogBySearch(
  groups: ApexBacklogGroup[],
  searchQuery: string,
): ApexBacklogGroup[] {
  const q = searchQuery.trim().toLowerCase();
  if (!q) return groups;

  return groups
    .map((group) => {
      const prdMatches = group.prdTitle.toLowerCase().includes(q);
      const epics = group.epics
        .map((epic) => {
          const epicMatches = epic.epicTitle.toLowerCase().includes(q);
          const features =
            prdMatches || epicMatches
              ? epic.features
              : epic.features.filter(
                  (feature) =>
                    feature.featureTitle.toLowerCase().includes(q) ||
                    feature.featureId.toLowerCase().includes(q),
                );
          return { ...epic, features };
        })
        .filter((epic) => epic.features.length > 0);
      return { ...group, epics };
    })
    .filter((group) => group.epics.length > 0);
}

function featureCompleteKey(prdId: string, featureId: string): string {
  return `${prdId}:${featureId}`;
}

function formatStatusAt(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function statusBadgeClass(state: MyWorkStatus): string {
  switch (state) {
    case 'ready':
      return styles['ready-badge'];
    case 'in_progress':
      return styles['active-badge'];
    case 'complete':
      return styles['completed-badge'];
  }
}

const WorkStatusBadge: React.FC<{
  state: MyWorkStatus;
  statusAt: string | null;
  'data-testid'?: string;
}> = ({ state, statusAt, 'data-testid': testId }) => {
  const formatted = formatStatusAt(statusAt);
  return (
    <span
      className={styles['status-with-time']}
      {...(testId ? { 'data-testid': testId } : {})}
    >
      <span className={statusBadgeClass(state)}>{formatMyWorkStatusLabel(state)}</span>
      {formatted && <span className={styles['status-timestamp']}>{formatted}</span>}
    </span>
  );
};

const ApexBacklogView: React.FC<{
  project: string;
  activeSessions: ActiveDevSession[];
}> = ({ project, activeSessions }) => {
  const { data: backlogGroups, isLoading, error } = useApexBacklogFeatures(project);
  const closeSession = useCloseDevSession();
  const completeFeature = useCompleteFeature();
  const startLocalFeature = useStartLocalFeature();
  const [closingId, setClosingId] = useState<string | null>(null);
  const [completingFeature, setCompletingFeature] = useState<string | null>(null);
  const [openPrds, setOpenPrds] = useState<Set<string>>(() => new Set());
  const [openEpics, setOpenEpics] = useState<Set<string>>(() => new Set());
  const [localDevTarget, setLocalDevTarget] = useState<StartLocalDevTarget | null>(null);
  const [selectedContextFeature, setSelectedContextFeature] = useState<BacklogFeatureItem | null>(null);
  const [statusFilter, setStatusFilter] = useState<ApexStatusFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [locallyCompleted, setLocallyCompleted] = useState<Set<string>>(() => new Set());

  const allSessions = useMemo(() => activeSessions ?? [], [activeSessions]);

  const filteredGroups = useMemo(() => {
    const byStatus = filterApexBacklogByStatus(
      backlogGroups ?? [],
      allSessions,
      statusFilter,
      locallyCompleted,
    );
    return filterApexBacklogBySearch(byStatus, searchQuery);
  }, [backlogGroups, allSessions, statusFilter, locallyCompleted, searchQuery]);

  // Expand matching PRDs/Epics while searching so hits are visible.
  useEffect(() => {
    if (!searchQuery.trim()) return;
    const prdKeys = new Set(filteredGroups.map((g) => g.prdId));
    const epicKeys = new Set<string>();
    filteredGroups.forEach((g) => g.epics.forEach((_e, i) => epicKeys.add(`${g.prdId}-${i}`)));
    setOpenPrds(prdKeys);
    setOpenEpics(epicKeys);
  }, [searchQuery, filteredGroups]);

  const togglePrd = (prdId: string) => {
    setOpenPrds(prev => {
      const next = new Set(prev);
      if (next.has(prdId)) next.delete(prdId); else next.add(prdId);
      return next;
    });
  };

  const toggleEpic = (key: string) => {
    setOpenEpics(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const handleClearProgress = async (sessionId: string) => {
    setClosingId(sessionId);
    try {
      await closeSession.mutateAsync(sessionId);
    } finally {
      setClosingId(null);
    }
  };

  const handleComplete = async (feature: BacklogFeatureItem) => {
    setCompletingFeature(feature.featureId);
    try {
      await completeFeature.mutateAsync({ prdId: feature.prdId, featureId: feature.featureId, project });
      setLocallyCompleted(prev => {
        const next = new Set(prev);
        next.add(featureCompleteKey(feature.prdId, feature.featureId));
        return next;
      });
    } finally {
      setCompletingFeature(null);
    }
  };

  const handleStartLocal = async (feature: BacklogFeatureItem) => {
    try {
      await startLocalFeature.mutateAsync({
        prdId: feature.prdId,
        featureId: feature.featureId,
        project,
      });
    } catch {
      // Still open the modal so the user can download the pack even if status
      // persistence fails; the badge will refresh on the next sessions poll.
    }
    setLocalDevTarget({
      kind: 'apex',
      project,
      prdId: feature.prdId,
      featureId: feature.featureId,
      title: feature.featureTitle,
    });
  };

  if (isLoading) {
    return <div className={styles.loading}>Loading Apex backlog features...</div>;
  }

  if (error) {
    return <div className={styles.error}>Failed to load backlog: {error.message}</div>;
  }

  if (!backlogGroups || backlogGroups.length === 0) {
    return (
      <div className={styles.empty} {...{ 'data-testid': 'my-work-empty' }}>
        No approved PRDs with backlog features found for Apex.
      </div>
    );
  }

  return (
    <div className={styles['apex-backlog']} {...{ 'data-testid': 'my-work-apex-backlog' }}>
      {startLocalFeature.error && (
        <div className={styles.error}>{startLocalFeature.error.message}</div>
      )}

      <div className={styles['filters-row']}>
        <div
          className={styles.filters}
          role="toolbar"
          aria-label="Filter features by status"
          {...{ 'data-testid': 'my-work-status-filters' }}
        >
          {APEX_STATUS_FILTERS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              className={`${styles['filter-pill']}${statusFilter === id ? ` ${styles['filter-pill-active']}` : ''}`}
              aria-pressed={statusFilter === id}
              onClick={() => setStatusFilter(id)}
              {...{ 'data-testid': `my-work-status-filter-${id}` }}
            >
              {label}
            </button>
          ))}
        </div>
        <div className={styles['search-wrap']}>
          <svg
            className={styles['search-icon']}
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="6.5" cy="6.5" r="4.5" />
            <line x1="10" y1="10" x2="14" y2="14" />
          </svg>
          <input
            className={styles['search-input']}
            type="search"
            placeholder="Search PRDs, epics, features…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            aria-label="Search PRDs, epics, and features"
            {...{ 'data-testid': 'my-work-search-input' }}
          />
        </div>
      </div>

      {filteredGroups.length === 0 ? (
        <div className={styles.empty} {...{ 'data-testid': 'my-work-empty' }}>
          {searchQuery.trim()
            ? 'No PRDs, epics, or features match this search.'
            : 'No features match this filter.'}
        </div>
      ) : (
        filteredGroups.map(group => {
          const featureStatuses = group.epics.flatMap(epic =>
            epic.features.map(feature => {
              const key = featureCompleteKey(feature.prdId, feature.featureId);
              const readiness = computeFeatureWorkStatus(feature, allSessions, allSessions);
              if (readiness.state === 'complete' || locallyCompleted.has(key)) {
                return {
                  ...readiness,
                  state: 'complete' as const,
                  statusAt: readiness.statusAt ?? new Date().toISOString(),
                };
              }
              return readiness;
            }),
          );
          const prdStatus = rollupWorkStatus(featureStatuses);

          return (
            <div key={group.prdId} className={styles['prd-group']}>
              <button
                className={styles['prd-header']}
                onClick={() => togglePrd(group.prdId)}
                type="button"
                aria-expanded={openPrds.has(group.prdId)}
                {...{ 'data-testid': `my-work-prd-toggle-${group.prdId}` }}
              >
                <span className={styles['toggle-icon']}>{openPrds.has(group.prdId) ? '▼' : '▶'}</span>
                <span className={styles['prd-label']}>PRD:</span>
                <span className={styles['prd-title']}>{group.prdTitle}</span>
                <WorkStatusBadge
                  state={prdStatus.state}
                  statusAt={prdStatus.statusAt}
                  {...{ 'data-testid': `my-work-prd-status-${group.prdId}` }}
                />
              </button>

              {openPrds.has(group.prdId) && group.epics.map((epic, epicIdx) => {
                const epicKey = `${group.prdId}-${epicIdx}`;
                const epicFeatureStatuses = epic.features.map(feature => {
                  const key = featureCompleteKey(feature.prdId, feature.featureId);
                  const readiness = computeFeatureWorkStatus(feature, allSessions, allSessions);
                  if (readiness.state === 'complete' || locallyCompleted.has(key)) {
                    return {
                      ...readiness,
                      state: 'complete' as const,
                      statusAt: readiness.statusAt ?? new Date().toISOString(),
                    };
                  }
                  return readiness;
                });
                const epicStatus = rollupWorkStatus(epicFeatureStatuses);

                return (
                  <div key={epicKey} className={styles['epic-group']}>
                    <button
                      className={styles['epic-header']}
                      onClick={() => toggleEpic(epicKey)}
                      type="button"
                      aria-expanded={openEpics.has(epicKey)}
                      {...{ 'data-testid': `my-work-epic-toggle-${epicKey}` }}
                    >
                      <span className={styles['toggle-icon']}>{openEpics.has(epicKey) ? '▼' : '▶'}</span>
                      <span className={styles['epic-label']}>Epic:</span>
                      <span className={styles['epic-title']}>{epic.epicTitle}</span>
                      <WorkStatusBadge
                        state={epicStatus.state}
                        statusAt={epicStatus.statusAt}
                        {...{ 'data-testid': `my-work-epic-status-${epicKey}` }}
                      />
                    </button>

                    {openEpics.has(epicKey) && (
                      <div className={styles['feature-list']} {...{ 'data-testid': 'my-work-feature-list' }}>
                        {epic.features.map(feature => {
                          const key = featureCompleteKey(feature.prdId, feature.featureId);
                          const readiness = computeFeatureWorkStatus(feature, allSessions, allSessions);
                          const isComplete =
                            readiness.state === 'complete' || locallyCompleted.has(key);
                          const isInProgress = !isComplete && readiness.state === 'in_progress';
                          const isBlocked = !!readiness.blockedBy;

                          return (
                            <div key={feature.featureId} className={styles['feature-item']}>
                              <div className={styles['feature-info']}>
                                <div className={styles['feature-title-row']}>
                                  <span className={styles['feature-id']}>{feature.featureId}</span>
                                  <span className={styles['feature-title']}>{feature.featureTitle}</span>
                                </div>
                                <div className={styles['feature-meta']}>
                                  <span className={styles.badge}>{feature.featurePriority}</span>
                                  <span className={styles['item-count']}>{feature.pbiCount} PBIs, {feature.tbiCount} TBIs</span>
                                  {feature.designDocStatus && (
                                    <span className={styles.badge}>Design: {feature.designDocStatus}</span>
                                  )}
                                  <WorkStatusBadge
                                    state={isComplete ? 'complete' : readiness.state}
                                    statusAt={
                                      isComplete
                                        ? (readiness.statusAt ?? new Date().toISOString())
                                        : readiness.statusAt
                                    }
                                    {...{ 'data-testid': `my-work-feature-status-${feature.featureId}` }}
                                  />
                                  {isBlocked && !isComplete && (
                                    <span className={styles['blocked-badge']}>Blocked by {readiness.blockedBy}</span>
                                  )}
                                  {readiness.hasPr && !isComplete && (
                                    <span className={styles['active-badge']}>In PR</span>
                                  )}
                                </div>
                              </div>
                              <div className={styles['item-actions']}>
                                <button
                                  className={styles['view-context-btn']}
                                  onClick={() => setSelectedContextFeature(feature)}
                                  type="button"
                                  title="Inspect PRD, backlog, design artifacts, and prototype"
                                  {...{ 'data-testid': 'my-work-view-context-btn' }}
                                >
                                  View Context
                                </button>
                                {isComplete ? (
                                  <span className={styles['completed-label']}>Done</span>
                                ) : (
                                  <>
                                    {isInProgress && readiness.sessionId && (
                                      <button
                                        className={styles['close-btn']}
                                        onClick={() => handleClearProgress(readiness.sessionId!)}
                                        disabled={closingId === readiness.sessionId}
                                        type="button"
                                        title="Clear in-progress status for this feature"
                                        {...{ 'data-testid': `my-work-clear-progress-${feature.featureId}` }}
                                      >
                                        {closingId === readiness.sessionId ? 'Closing...' : 'Clear Progress'}
                                      </button>
                                    )}
                                    <button
                                      className={styles['complete-btn']}
                                      onClick={() => handleComplete(feature)}
                                      disabled={completingFeature !== null}
                                      type="button"
                                      title="Mark this feature as complete to unblock dependent features"
                                      {...{ 'data-testid': 'my-work-mark-complete-btn' }}
                                    >
                                      {completingFeature === feature.featureId ? 'Completing...' : 'Mark Complete'}
                                    </button>
                                    <button
                                      className={styles['local-dev-btn']}
                                      onClick={() => handleStartLocal(feature)}
                                      disabled={startLocalFeature.isPending}
                                      type="button"
                                      title="Mark In Progress, download a context pack, and open Cursor or VS Code locally"
                                      {...{ 'data-testid': 'my-work-start-local-dev-btn' }}
                                    >
                                      <span className={styles['cloud-button-icon']} aria-hidden="true">
                                        <svg width="13" height="13" viewBox="0 0 24 24">
                                          <rect x="3" y="4" width="18" height="13" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
                                          <path d="M8 21h8M12 17v4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                                        </svg>
                                      </span>
                                      Start Local Development
                                    </button>
                                  </>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })
      )}

      {localDevTarget && (
        // data-testid-exempt — StartLocalDevModal root already sets data-testid
        <StartLocalDevModal
          target={localDevTarget}
          onClose={() => setLocalDevTarget(null)}
        />
      )}

      {selectedContextFeature && (
        // data-testid-exempt — FeatureContextModal root already sets data-testid
        <FeatureContextModal
          project={project}
          feature={selectedContextFeature}
          onClose={() => setSelectedContextFeature(null)}
        />
      )}
    </div>
  );
};

export const DevWorkbenchView: React.FC = () => {
  const navigate = useNavigate();
  const { selectedProject, usesBoardWorkItems } = useAppShell();
  const usesAppNativeRequirements = isAppNativeRequirementsProject(selectedProject);
  const showBoardAssigned = usesBoardWorkItems;

  const { data: workItems, isLoading, error } = useAssignedWorkItems(
    usesAppNativeRequirements || showBoardAssigned ? null : (selectedProject || null),
  );
  const { data: activeSessions } = useActiveSessions(selectedProject || null);
  const closeSession = useCloseDevSession();
  const [closingId, setClosingId] = useState<string | null>(null);
  const [localDevTarget, setLocalDevTarget] = useState<StartLocalDevTarget | null>(null);

  const { legacySessionByWorkItem, cloudSessionByWorkItem } = useMemo(() => {
    const legacy = new Map<number, ActiveDevSession>();
    const cloud = new Map<number, ActiveDevSession>();
    if (activeSessions) {
      for (const s of activeSessions) {
        if (s.status !== 'closed' && s.status !== 'failed' && s.workItemId) {
          if (s.cloudAgentRun && !cloud.has(s.workItemId)) {
            cloud.set(s.workItemId, s);
          }
          if (
            (!s.cloudAgentRun || s.chatThreadId || s.branchName)
            && !legacy.has(s.workItemId)
          ) {
            legacy.set(s.workItemId, s);
          }
        }
      }
    }
    return {
      legacySessionByWorkItem: legacy,
      cloudSessionByWorkItem: cloud,
    };
  }, [activeSessions]);

  const sortedWorkItems = useMemo(() => {
    if (!workItems) return [];
    return [...workItems].sort((a, b) => {
      const aActive =
        legacySessionByWorkItem.has(a.id) || cloudSessionByWorkItem.has(a.id) ? 0 : 1;
      const bActive =
        legacySessionByWorkItem.has(b.id) || cloudSessionByWorkItem.has(b.id) ? 0 : 1;
      return aActive - bActive;
    });
  }, [workItems, legacySessionByWorkItem, cloudSessionByWorkItem]);

  const handleResume = (sessionId: string) => {
    navigate(`/my-work/session/${sessionId}`);
  };

  const handleClose = async (sessionId: string) => {
    setClosingId(sessionId);
    try {
      await closeSession.mutateAsync(sessionId);
    } finally {
      setClosingId(null);
    }
  };

  if ((usesAppNativeRequirements || showBoardAssigned) && selectedProject) {
    return (
      <div className={styles.container} {...{ 'data-testid': 'my-work-page' }}>
        <div className={styles.header} {...{ 'data-testid': 'my-work-header' }}>
          <h1 className={styles.title}>My Work</h1>
          <p className={styles.subtitle}>
            {usesAppNativeRequirements
              ? 'Approved PRD features and Work Board assignments'
              : 'Work Board items assigned to you'}
          </p>
        </div>
        {showBoardAssigned && <BoardAssignedSection project={selectedProject} />}
        {usesAppNativeRequirements && (
          <section
            className={styles.section}
            aria-labelledby="feature-backlog-heading"
            {...{ 'data-testid': 'my-work-feature-backlog-section' }}
          >
            <div className={styles['section-header']}>
              <h2 id="feature-backlog-heading">Feature Backlog</h2>
              <p>Approved PRD features</p>
            </div>
            <ApexBacklogView project={selectedProject} activeSessions={activeSessions ?? []} />
          </section>
        )}
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className={styles.container} {...{ 'data-testid': 'my-work-page' }}>
        <div className={styles.loading}>Loading assigned work items...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.container} {...{ 'data-testid': 'my-work-page' }}>
        <div className={styles.error}>Failed to load work items: {error.message}</div>
      </div>
    );
  }

  return (
    <div className={styles.container} {...{ 'data-testid': 'my-work-page' }}>
      <div className={styles.header} {...{ 'data-testid': 'my-work-header' }}>
        <h1 className={styles.title}>My Work</h1>
        <p className={styles.subtitle}>Work items assigned to you — start a development session to begin coding</p>
      </div>

      {!workItems || workItems.length === 0 ? (
        <div className={styles.empty} {...{ 'data-testid': 'my-work-empty' }}>
          No active work items assigned to you.
        </div>
      ) : (
        <div className={styles.list} {...{ 'data-testid': 'my-work-work-items-list' }}>
          {sortedWorkItems.map((item) => {
            const active = legacySessionByWorkItem.get(item.id);
            const cloudSession = cloudSessionByWorkItem.get(item.id);
            return (
              <div key={item.id} className={styles.item}>
                <div className={styles['item-info']}>
                  <span className={styles['item-title']}>{item.title}</span>
                  <div className={styles['item-meta']}>
                    <span className={styles['item-id']}>#{item.id}</span>
                    <span className={styles.badge}>{item.workItemType}</span>
                    <span className={styles.badge}>{item.state}</span>
                    {active && <span className={styles['active-badge']}>Active Session</span>}
                  </div>
                </div>
                <div className={styles['item-actions']}>
                  {active ? (
                    <>
                      <button
                        className={styles['resume-btn']}
                        onClick={() => handleResume(active.id)}
                        type="button"
                        {...{ 'data-testid': 'my-work-resume-session-btn' }}
                      >
                        Resume Session
                      </button>
                      <button
                        className={styles['close-btn']}
                        onClick={() => handleClose(active.id)}
                        disabled={closingId === active.id}
                        type="button"
                        {...{ 'data-testid': `my-work-close-session-${item.id}` }}
                      >
                        {closingId === active.id ? 'Closing...' : 'Close Session'}
                      </button>
                    </>
                  ) : null}
                  <button
                    className={styles['local-dev-btn']}
                    onClick={() =>
                      setLocalDevTarget({
                        kind: 'ado',
                        project: selectedProject!,
                        workItemId: item.id,
                        title: item.title,
                      })
                    }
                    type="button"
                    title="Download a context pack and open Cursor or VS Code locally"
                    {...{ 'data-testid': 'my-work-start-local-dev-btn' }}
                  >
                    <span className={styles['cloud-button-icon']} aria-hidden="true">
                      <svg width="13" height="13" viewBox="0 0 24 24">
                        <rect x="3" y="4" width="18" height="13" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
                        <path d="M8 21h8M12 17v4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                      </svg>
                    </span>
                    Start Local Development
                  </button>
                  <CloudAgentRowAction
                    item={item}
                    project={selectedProject!}
                    activeSession={cloudSession}
                  />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {localDevTarget && (
        // data-testid-exempt — StartLocalDevModal root already sets data-testid
        <StartLocalDevModal
          target={localDevTarget}
          onClose={() => setLocalDevTarget(null)}
        />
      )}
    </div>
  );
};
