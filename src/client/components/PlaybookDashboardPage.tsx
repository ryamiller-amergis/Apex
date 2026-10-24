/**
 * One playbook's dashboard: how often it runs, how it does, what it is made of, and how it has
 * changed. Stats come from the project's capped run list, filtered to this playbook.
 */
import React, { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, PenLine, Play } from 'lucide-react';
import type { PlaybookDefinitionDetail } from '../../shared/types/playbook';
import { playbookAuthorGraphsMatch } from '../../shared/utils/playbookGraph';
import { useAppShell } from '../hooks/useAppShell';
import { usePlaybookDefinition } from '../hooks/usePlaybookDefinitions';
import { useProfileCard } from '../hooks/useProfile';
import { usePlaybookVersionGraph } from '../hooks/usePlaybookCanvas';
import { usePlaybookRuns, useStartPlaybookRun } from '../hooks/usePlaybookRuns';
import { PlaybookRunList } from './PlaybookRunList';
import { nodeSubtitle, orderedSteps, stepMeta } from './playbookStepCatalog';
import {
  computeRunStats,
  dailyActivity,
  formatDuration,
  formatSuccessRate,
  type PlaybookActivityDay,
} from './playbookRunStats';
import { absoluteTime, relativeTime } from './playbookStatusFormat';
import styles from './PlaybookDashboardPage.module.css';

const ACTIVITY_DAYS = 14;
const RECENT_RUN_LIMIT = 8;

function dayLabel(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

const ActivityChart: React.FC<{ days: PlaybookActivityDay[] }> = ({ days }) => {
  const peak = Math.max(1, ...days.map((day) => day.total));
  const empty = days.every((day) => day.total === 0);
  return (
    <div className={styles.chart} {...{ 'data-testid': 'playbook-dashboard-activity' }}>
      <div className={styles.chartBars} role="img" aria-label={`Runs per day for the last ${days.length} days`}>
        {days.map((day, index) => (
          <div
            key={day.date}
            className={styles.chartColumn}
            title={`${dayLabel(day.date)}: ${day.total} run${day.total === 1 ? '' : 's'}`}
          >
            <div className={styles.chartStack} style={{ height: `${(day.total / peak) * 100}%` }}>
              {day.failed ? <span className={styles.barFailed} style={{ flexGrow: day.failed }} /> : null}
              {day.other ? <span className={styles.barOther} style={{ flexGrow: day.other }} /> : null}
              {day.completed ? <span className={styles.barCompleted} style={{ flexGrow: day.completed }} /> : null}
            </div>
            <span className={styles.chartLabel}>
              {index % 2 === days.length % 2 ? dayLabel(day.date) : ''}
            </span>
          </div>
        ))}
        {empty ? <p className={styles.chartEmpty}>No runs in the last {days.length} days.</p> : null}
      </div>
      <ul className={styles.legend}>
        <li><span className={styles.barCompleted} /> Completed</li>
        <li><span className={styles.barFailed} /> Failed or expired</li>
        <li><span className={styles.barOther} /> Running, waiting or cancelled</li>
      </ul>
    </div>
  );
};

const FlowOutline: React.FC<{ detail: PlaybookDefinitionDetail }> = ({ detail }) => {
  const steps = orderedSteps(detail.draft.graph);
  if (!steps.length) {
    return <p className={styles.muted}>No steps yet. Open the builder to add the first one.</p>;
  }
  return (
    <ol className={styles.outline} {...{ 'data-testid': 'playbook-dashboard-flow' }}>
      {steps.map((node, index) => {
        const meta = stepMeta(node.stepType);
        const Icon = meta.icon;
        return (
          <li key={node.id} className={styles.outlineStep} {...{ 'data-group': meta.group }}>
            <span className={styles.outlineIndex}>{index + 1}</span>
            <span className={styles.outlineGlyph} aria-hidden>
              <Icon size={14} />
            </span>
            <span className={styles.outlineText}>
              <span className={styles.outlineTitle}>{meta.title}</span>
              <span className={styles.outlineMeta}>{nodeSubtitle(node)}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
};

/** A person's display name, falling back to a shortened id when no profile resolves. */
const UserName: React.FC<{ userId: string }> = ({ userId }) => {
  const card = useProfileCard(userId);
  if (card.data?.displayName) return <>{card.data.displayName}</>;
  if (card.isPending) return <>…</>;
  return <span title={userId}>{userId.length > 16 ? `${userId.slice(0, 8)}…` : userId}</span>;
};

interface HistoryEntry {
  key: string;
  title: string;
  by: string | null;
  note: string | null;
  at: string | null;
  tone: 'draft' | 'published' | 'deprecated' | 'created';
}

function historyEntries(detail: PlaybookDefinitionDetail, hasUnpublishedChanges: boolean): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  if (hasUnpublishedChanges) {
    entries.push({
      key: 'draft',
      title: 'Unpublished changes',
      by: null,
      note: `Draft for version ${detail.draft.nextVersionNumber}`,
      at: detail.draft.updatedAt,
      tone: 'draft',
    });
  }
  for (const version of [...detail.versions].sort((a, b) => b.versionNumber - a.versionNumber)) {
    const current = version.id === detail.currentPublishedVersionId;
    entries.push({
      key: version.id,
      title: `Version ${version.versionNumber} published${current ? ' · current' : ''}`,
      by: version.publishedBy,
      note: version.status === 'deprecated' ? 'now deprecated' : null,
      at: version.publishedAt,
      tone: version.status === 'deprecated' ? 'deprecated' : 'published',
    });
  }
  entries.push({
    key: 'created',
    title: 'Created',
    by: detail.definition.createdBy,
    note: null,
    at: detail.definition.createdAt,
    tone: 'created',
  });
  return entries;
}

interface PlaybookDashboardPageProps {
  project: string;
  definitionId: string;
}

export const PlaybookDashboardPage: React.FC<PlaybookDashboardPageProps> = ({
  project,
  definitionId,
}) => {
  const navigate = useNavigate();
  const { can } = useAppShell();
  const canAuthor = can('playbooks:author');
  const canRun = can('playbooks:run');
  const detail = usePlaybookDefinition(project, definitionId);
  const runs = usePlaybookRuns(project);
  const start = useStartPlaybookRun(project, definitionId);
  const publishedVersionId = detail.data?.currentPublishedVersionId ?? null;
  const publishedGraph = usePlaybookVersionGraph(project, definitionId, publishedVersionId, true);
  const [runError, setRunError] = useState<string | null>(null);

  const definitionRuns = useMemo(
    () => (runs.data?.runs ?? []).filter((run) => run.definitionId === definitionId),
    [runs.data, definitionId],
  );
  const stats = useMemo(() => computeRunStats(definitionRuns), [definitionRuns]);
  const activity = useMemo(() => dailyActivity(definitionRuns, ACTIVITY_DAYS), [definitionRuns]);

  if (detail.isPending) {
    return <p className={styles.pageMessage} {...{ 'data-testid': 'playbook-dashboard-loading' }}>Loading playbook…</p>;
  }
  if (detail.isError || !detail.data) {
    return (
      <div className={styles.pageMessage} {...{ 'data-testid': 'playbook-dashboard-error' }}>
        <p>Could not load this playbook. {detail.error?.message}</p>
        <Link to="/playbooks" {...{ 'data-testid': 'playbook-dashboard-error-back' }}>Back to playbooks</Link>
      </div>
    );
  }

  const data = detail.data;
  const currentVersion = data.versions.find((version) => version.id === publishedVersionId);
  const hasUnpublishedChanges = publishedVersionId
    ? Boolean(publishedGraph.data)
      && !playbookAuthorGraphsMatch(publishedGraph.data!.graph, data.draft.graph)
    : data.draft.graph.nodes.length > 0;
  const truncated = runs.data ? runs.data.total > runs.data.runs.length : false;

  const runNow = async () => {
    setRunError(null);
    try {
      const result = await start.mutateAsync();
      navigate(`/playbooks/runs/${result.runId}`);
    } catch (error) {
      setRunError(error instanceof Error ? error.message : 'Could not start the run.');
    }
  };

  const tiles = [
    { label: 'Total runs', value: String(stats.total), note: truncated ? 'in the latest project runs' : 'all time' },
    { label: 'Success rate', value: formatSuccessRate(stats.successRate), note: `${stats.completed} completed · ${stats.failed} failed` },
    { label: 'Average duration', value: stats.averageDurationMs === null ? '—' : formatDuration(stats.averageDurationMs), note: 'start to finish' },
    { label: 'Running now', value: String(stats.running), note: stats.running ? 'in progress' : 'nothing in flight', tone: stats.running ? 'active' : undefined },
    { label: 'Waiting', value: String(stats.waiting), note: 'on an approval or agent', tone: stats.waiting ? 'waiting' : undefined },
  ];

  return (
    <div className={styles.page} {...{ 'data-testid': 'playbook-dashboard' }}>
      <Link to="/playbooks" className={styles.crumb} {...{ 'data-testid': 'playbook-dashboard-back' }}>
        <ArrowLeft size={14} aria-hidden /> Playbooks
      </Link>

      <header className={styles.header}>
        <div className={styles.headerText}>
          <div className={styles.titleRow}>
            <h1 className={styles.title}>{data.definition.name}</h1>
            {currentVersion ? (
              <span className={styles.versionBadge} {...{ 'data-state': 'published' }}>
                v{currentVersion.versionNumber} live
              </span>
            ) : (
              <span className={styles.versionBadge} {...{ 'data-state': 'draft' }}>Not published</span>
            )}
            {hasUnpublishedChanges && currentVersion ? (
              <span className={styles.changesBadge} {...{ 'data-testid': 'playbook-dashboard-unpublished' }}>
                Unpublished changes
              </span>
            ) : null}
          </div>
          {data.definition.description ? (
            <p className={styles.description}>{data.definition.description}</p>
          ) : null}
          <p className={styles.meta}>
            Created {relativeTime(data.definition.createdAt)} by <UserName userId={data.definition.createdBy} />
            {stats.lastRunAt ? ` · last run ${relativeTime(stats.lastRunAt)}` : ''}
          </p>
        </div>
        <div className={styles.headerActions}>
          {canAuthor ? (
            <Link
              to={`/playbooks/${definitionId}/edit`}
              className={styles.secondaryButton}
              data-testid="playbook-dashboard-edit"
            >
              <PenLine size={15} aria-hidden /> Edit
            </Link>
          ) : null}
          <Link
            to={`/playbooks/definitions/${definitionId}`}
            className={styles.secondaryButton}
            {...{ 'data-testid': 'playbook-open-canvas' }}
          >
            <PenLine size={15} aria-hidden /> {canAuthor ? 'Edit in builder' : 'View in builder'}
          </Link>
          {canRun ? (
            <button
              type="button"
              className={styles.primaryButton}
              disabled={!publishedVersionId || start.isPending}
              title={publishedVersionId ? 'Start a run on the current version' : 'Publish a version first'}
              onClick={() => void runNow()}
              {...{ 'data-testid': 'playbook-dashboard-run' }}
            >
              <Play size={15} aria-hidden /> {start.isPending ? 'Starting…' : 'Run now'}
            </button>
          ) : null}
        </div>
      </header>
      {runError ? <p className={styles.errorBanner} role="alert">{runError}</p> : null}

      <dl className={styles.tiles} {...{ 'data-testid': 'playbook-dashboard-stats' }}>
        {tiles.map((tile) => (
          <div key={tile.label} className={styles.tile} {...(tile.tone ? { 'data-tone': tile.tone } : {})}>
            <dt>{tile.label}</dt>
            <dd>{tile.value}</dd>
            <span>{tile.note}</span>
          </div>
        ))}
      </dl>

      <div className={styles.split}>
        <section className={styles.panel} aria-labelledby="playbook-activity-heading">
          <header className={styles.panelHeader}>
            <h2 id="playbook-activity-heading" className={styles.panelTitle}>Activity</h2>
            <span className={styles.panelNote}>Last {ACTIVITY_DAYS} days</span>
          </header>
          <ActivityChart days={activity} />
        </section>

        <section className={styles.panel} aria-labelledby="playbook-flow-heading">
          <header className={styles.panelHeader}>
            <h2 id="playbook-flow-heading" className={styles.panelTitle}>Steps</h2>
            <span className={styles.panelNote}>{data.draft.graph.nodes.length} in draft</span>
          </header>
          <FlowOutline detail={data} />
        </section>
      </div>

      <div className={styles.split}>
        <section className={styles.panel} aria-labelledby="playbook-runs-heading">
          <header className={styles.panelHeader}>
            <h2 id="playbook-runs-heading" className={styles.panelTitle}>Recent runs</h2>
            <Link to="/playbooks?view=runs" className={styles.panelLink} {...{ 'data-testid': 'playbook-dashboard-all-runs' }}>
              All runs
            </Link>
          </header>
          {runs.isPending ? (
            <p className={styles.muted}>Loading runs…</p>
          ) : definitionRuns.length === 0 ? (
            <p className={styles.muted} {...{ 'data-testid': 'playbook-dashboard-no-runs' }}>
              This playbook has not run yet.
            </p>
          ) : (
            <PlaybookRunList runs={definitionRuns.slice(0, RECENT_RUN_LIMIT)} project={project} />
          )}
        </section>

        <section className={styles.panel} aria-labelledby="playbook-history-heading">
          <header className={styles.panelHeader}>
            <h2 id="playbook-history-heading" className={styles.panelTitle}>History</h2>
          </header>
          <ol className={styles.timeline} {...{ 'data-testid': 'playbook-dashboard-history' }}>
            {historyEntries(data, hasUnpublishedChanges).map((entry) => (
              <li key={entry.key} className={styles.timelineItem} {...{ 'data-tone': entry.tone }}>
                <span className={styles.timelineTitle}>{entry.title}</span>
                <span className={styles.timelineMeta}>
                  {entry.by ? <>by <UserName userId={entry.by} /></> : null}
                  {[entry.by ? '' : null, entry.note, entry.at ? absoluteTime(entry.at) : null]
                    .filter((part) => part !== null)
                    .join(' · ')}
                </span>
              </li>
            ))}
          </ol>
        </section>
      </div>

    </div>
  );
};

export default PlaybookDashboardPage;
