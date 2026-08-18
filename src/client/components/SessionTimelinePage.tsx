import React, { useCallback, useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import type {
  SessionTimelineEntry,
  SessionTimelineResponse,
  SessionTimelineSource,
} from '../../shared/types/observability';
import { useSessionTimeline } from '../hooks/useSessionTimeline';
import styles from './SessionTimelinePage.module.css';

const KEYWORD_MAX = 100;
const lookupSchema = z.object({
  sessionId: z
    .string()
    .trim()
    .min(1, 'Session ID is required')
    .max(128, 'Session ID is too long')
    .regex(/^[A-Za-z0-9._:-]+$/, 'Enter a valid session ID'),
});
type LookupValues = z.infer<typeof lookupSchema>;
type SourceFilter = 'all' | SessionTimelineSource;

const WARNING_HEALTH = new Set(['progress_stale', 'long_running']);
const ERROR_HEALTH = new Set(['progress_timeout', 'worker_lost', 'hard_timeout', 'never_claimed']);

interface SessionTimelinePageProps {
  project: string;
  sessionId: string | null;
  onSessionChange: (sessionId: string) => void;
}

function formatTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toISOString().replace('T', ' ').replace('Z', ' UTC');
}

function matchesKeyword(entry: SessionTimelineEntry, keyword: string): boolean {
  if (!keyword) return true;
  const haystack = [
    entry.title,
    entry.safeDetail,
    entry.source,
    entry.eventType,
    ...entry.details.map((detail) => `${detail.label} ${detail.value}`),
    entry.source === 'agent' ? entry.toolName : undefined,
    entry.source === 'trace' ? entry.routeTemplate : undefined,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(keyword.toLowerCase());
}

function flattenPages(pages: SessionTimelineResponse[] | undefined): SessionTimelineEntry[] {
  return pages?.flatMap((page) => page.entries) ?? [];
}

export const SessionTimelinePage: React.FC<SessionTimelinePageProps> = ({
  project,
  sessionId,
  onSessionChange,
}) => {
  const [keyword, setKeyword] = useState('');
  const [source, setSource] = useState<SourceFilter>('all');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const query = useSessionTimeline(project, sessionId);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LookupValues>({
    resolver: zodResolver(lookupSchema),
    defaultValues: { sessionId: sessionId ?? '' },
  });

  const firstPage = query.data?.pages[0];
  const lastPage = query.data?.pages[query.data.pages.length - 1];
  const entries = useMemo(() => flattenPages(query.data?.pages), [query.data?.pages]);
  const filtered = useMemo(
    () =>
      entries.filter((entry) => {
        if (source !== 'all' && entry.source !== source) return false;
        return matchesKeyword(entry, keyword.trim().slice(0, KEYWORD_MAX));
      }),
    [entries, keyword, source],
  );

  const onLookup = useCallback(
    (values: LookupValues) => {
      onSessionChange(values.sessionId.trim().toLowerCase());
    },
    [onSessionChange],
  );

  const errorStatus = typeof query.error === 'object' && query.error && 'status' in query.error
    ? Number((query.error as { status: number }).status)
    : null;
  const errorMessage = query.error instanceof Error ? query.error.message : 'The session timeline could not be loaded.';
  if (errorStatus === 403) {
    return (
      <div className={styles.page} {...{ 'data-testid': 'session-timeline-page' }}>
        <div className={styles.errorBox} {...{ 'data-testid': 'session-timeline-forbidden' }}>
          <h1 className={styles.errorTitle}>Access denied</h1>
          <p className={styles.errorText}>This timeline is available only to Super Admins.</p>
        </div>
      </div>
    );
  }

  if (errorStatus === 404) {
    return (
      <div className={styles.page} {...{ 'data-testid': 'session-timeline-page' }}>
        <div className={styles.empty} {...{ 'data-testid': 'session-timeline-not-found' }}>
          <h1 className={styles.emptyTitle}>Session not found</h1>
          <p className={styles.emptyText}>
            No timeline is available for this identifier. Confirm the session ID and try again.
          </p>
          <form className={styles.lookup} onSubmit={handleSubmit(onLookup)} {...{ 'data-testid': 'session-timeline-lookup-form' }}>
            <label className={styles.lookupLabel} htmlFor="session-timeline-session-id">
              Session ID
            </label>
            <input
              id="session-timeline-session-id"
              className={styles.keyword}
              {...register('sessionId')}
              {...{ 'data-testid': 'session-timeline-session-id' }}
            />
            {errors.sessionId ? <p className={styles.errorText}>{errors.sessionId.message}</p> : null}
            <button type="submit" className={styles.buttonPrimary} {...{ 'data-testid': 'session-timeline-lookup' }}>
              Look up session
            </button>
          </form>
        </div>
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className={styles.page} {...{ 'data-testid': 'session-timeline-page' }}>
        <div className={styles.errorBox} role="alert" {...{ 'data-testid': 'session-timeline-error' }}>
          <h1 className={styles.errorTitle}>Unable to load timeline</h1>
          <p className={styles.errorText}>{errorMessage}</p>
          <div className={styles.actions}>
            <button type="button" className={styles.button} onClick={() => { void query.refetch(); }} {...{ 'data-testid': 'session-timeline-retry' }}>
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (query.isLoading || !firstPage) {
    return (
      <div className={styles.page} {...{ 'data-testid': 'session-timeline-page' }}>
        <div className={styles.loading} {...{ 'data-testid': 'session-timeline-loading' }}>
          Loading session timeline…
        </div>
      </div>
    );
  }

  const verdictClass = !firstPage.verdict.health
    ? styles.verdictWarn
    : ERROR_HEALTH.has(firstPage.verdict.health)
      ? styles.verdictError
      : WARNING_HEALTH.has(firstPage.verdict.health)
        ? styles.verdictWarn
        : styles.verdictHealthy;
  const hangEntry = filtered.find((entry) => entry.id === firstPage.verdict.hangPointEventId);

  return (
    <div className={styles.page} {...{ 'data-testid': 'session-timeline-page' }}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Session Timeline</h1>
          <p className={styles.subtitle}>Interview & Agent Lifecycle History</p>
        </div>
        <div className={styles.meta}>
          <span className={styles.chip}>Session: {firstPage.session.sessionId}</span>
          {firstPage.session.interviewId ? (
            <span className={styles.chip}>Interview: {firstPage.session.interviewId}</span>
          ) : null}
          {firstPage.session.runIds[0] ? (
            <span className={styles.chip}>Agent Run: {firstPage.session.runIds[0]}</span>
          ) : null}
          <span className={firstPage.partial ? styles.chipError : styles.chipSuccess}>
            {firstPage.partial ? 'Incomplete' : firstPage.verdict.label}
          </span>
          <button
            type="button"
            className={styles.button}
            onClick={() => { void query.refetch(); }}
            {...{ 'data-testid': 'session-timeline-refresh' }}
          >
            Refresh
          </button>
        </div>
      </header>

      <div className={verdictClass} role="status" {...{ 'data-testid': 'session-timeline-verdict' }}>
        <div className={styles.verdictTitle}>Health verdict: {firstPage.verdict.label}</div>
        <div className={styles.verdictDetail}>
          {firstPage.verdict.detail}
          {hangEntry ? ` Hang point at ${formatTime(hangEntry.occurredAt)}${hangEntry.source === 'agent' && hangEntry.toolName ? ` — ${hangEntry.toolName}` : ''}.` : ''}
        </div>
      </div>

      {firstPage.partial ? (
        <div className={styles.partial} role="alert" {...{ 'data-testid': 'session-timeline-partial' }}>
          <span className={styles.incomplete}>Incomplete timeline</span>
          {' '}
          {firstPage.sourceStatus.agent.state === 'failed' ? firstPage.sourceStatus.agent.message : null}
          {' '}
          {firstPage.sourceStatus.trace.state === 'failed' ? firstPage.sourceStatus.trace.message : null}
        </div>
      ) : null}

      <div className={styles.legend}>
        <span className={styles.legendItem}><span className={`${styles.legendDot} ${styles.dotAgent}`} /> Agent lifecycle</span>
        <span className={styles.legendItem}><span className={`${styles.legendDot} ${styles.dotTrace}`} /> Trace Event</span>
        <span className={styles.legendItem}><span className={`${styles.legendDot} ${styles.dotError}`} /> Error Trace</span>
        <span className={styles.legendItem}><span className={`${styles.legendDot} ${styles.dotSuccess}`} /> Success milestone</span>
      </div>

      <div className={styles.filters} {...{ 'data-testid': 'session-timeline-filters' }}>
        <input
          className={styles.keyword}
          value={keyword}
          maxLength={KEYWORD_MAX}
          placeholder="Filter events by keyword…"
          onChange={(event) => setKeyword(event.target.value.slice(0, KEYWORD_MAX))}
          aria-label="Filter timeline events"
          {...{ 'data-testid': 'session-timeline-keyword' }}
        />
        <div className={styles.sourceToggle} role="group" aria-label="Timeline sources">
          {(['all', 'agent', 'trace'] as SourceFilter[]).map((id) => (
            <button
              key={id}
              type="button"
              className={source === id ? styles.sourceBtnPressed : styles.sourceBtn}
              aria-pressed={source === id}
              onClick={() => setSource(id)}
              {...{ 'data-testid': `session-timeline-source-${id}` }}
            >
              {id === 'all' ? 'All Sources' : id === 'agent' ? 'Agent' : 'Trace'}
            </button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className={styles.empty} {...{ 'data-testid': 'session-timeline-empty' }}>
          <p className={styles.emptyTitle}>
            {entries.length === 0 ? 'No lifecycle events found' : 'No events match these filters'}
          </p>
        </div>
      ) : (
        <ol className={styles.list} {...{ 'data-testid': 'session-timeline-list' }}>
          {filtered.map((entry) => (
            <SessionTimelineEntryCard
              key={entry.id}
              entry={entry}
              hang={entry.id === firstPage.verdict.hangPointEventId}
              expanded={Boolean(expanded[entry.id])}
              onToggle={() => setExpanded((current) => ({ ...current, [entry.id]: !current[entry.id] }))}
              {...{ 'data-testid': `session-timeline-card-${entry.id}` }}
            />
          ))}
        </ol>
      )}

      {lastPage?.page.capReached ? (
        <p className={styles.cap} {...{ 'data-testid': 'session-timeline-cap' }}>
          500-row query cap reached. Refine filters or open a narrower session window.
        </p>
      ) : null}
      {lastPage?.page.nextCursor ? (
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.button}
            onClick={() => { void query.fetchNextPage(); }}
            {...{ 'data-testid': 'session-timeline-load-more' }}
          >
            Load more
          </button>
        </div>
      ) : null}
      <p className={styles.note}>
        Ordering is deterministic by time, then agent before trace, then sequence and event ID.
      </p>
    </div>
  );
};

interface SessionTimelineEntryCardProps {
  entry: SessionTimelineEntry;
  hang: boolean;
  expanded: boolean;
  onToggle: () => void;
}

const SessionTimelineEntryCard: React.FC<SessionTimelineEntryCardProps> = ({
  entry,
  hang,
  expanded,
  onToggle,
}) => {
  const isError = entry.status === 'failed' || (entry.source === 'trace' && entry.eventType === 'error');
  const cardClass = hang ? styles.cardHang : isError ? styles.cardError : styles.card;
  return (
    <li className={styles.entry} {...{ 'data-testid': `session-timeline-entry-${entry.id}` }}>
      <time className={styles.time} dateTime={entry.occurredAt}>{formatTime(entry.occurredAt)}</time>
      <div className={styles.dotWrap}>
        <span className={`${styles.dot} ${isError ? styles.dotError : entry.source === 'agent' ? styles.dotAgent : styles.dotTrace}`} />
      </div>
      <article className={cardClass}>
        <div className={styles.cardHeader}>
          <span className={styles.cardTitle}>
            {entry.title}
            {hang ? <span className={styles.hangLabel} {...{ 'data-testid': 'session-timeline-hang-point' }}>Hang point</span> : null}
          </span>
          <span className={styles.badge}>{entry.source === 'agent' ? 'Agent' : isError ? 'Error Trace' : 'Trace'}</span>
        </div>
        {entry.safeDetail ? <p className={styles.cardBody}>{entry.safeDetail}</p> : null}
        <button
          type="button"
          className={styles.expandBtn}
          aria-expanded={expanded}
          onClick={onToggle}
          {...{ 'data-testid': `session-timeline-expand-${entry.id}` }}
        >
          {expanded ? 'Hide detail' : 'Show detail'}
        </button>
        {expanded ? (
          <dl className={styles.detailList} {...{ 'data-testid': `session-timeline-detail-${entry.id}` }}>
            {entry.details.map((detail) => (
              <div key={detail.label}>
                <dt>{detail.label}</dt>
                <dd>{detail.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </article>
    </li>
  );
};
