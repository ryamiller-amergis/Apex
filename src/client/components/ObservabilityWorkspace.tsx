import React, { lazy, Suspense, useCallback, useMemo, useState } from 'react';
import { ErrorBoundary } from 'react-error-boundary';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  OBSERVABILITY_MAX_ROWS,
  OBSERVABILITY_PAGE_SIZE,
  OBSERVABILITY_RAW_RETENTION_DAYS,
  W3C_TRACE_ID_PATTERN,
  type CaptureHealthResponse,
  type JourneyTrailHandoff,
  type TraceEventView,
} from '../../shared/types/observability';
import { useAppShell } from '../hooks/useAppShell';
import { useObservabilityHealth, useObservabilityTrail } from '../hooks/useObservabilityQueries';
import { SessionTimelinePage } from './SessionTimelinePage';
import { ViewErrorFallback } from './ViewErrorFallback';

const InteractiveJourneyMapPage = lazy(() => import('./InteractiveJourneyMapPage'));
import {
  ACTOR_UUID_PATTERN,
  TIME_RANGE_LABELS,
  TIME_RANGE_PRESETS,
  describeEventType,
  emptyFilterDraft,
  formatStoreBytes,
  formatTrailDescription,
  isBufferAtCapacity,
  isRetentionBoundaryReached,
  resolveTimeRange,
  type AppliedWorkspaceFilters,
  type TrailEventFilter,
} from '../observability/workspaceFilters';
import styles from './ObservabilityWorkspace.module.css';

const filterSchema = z
  .object({
    timeRange: z.enum(TIME_RANGE_PRESETS),
    customFrom: z.string(),
    customTo: z.string(),
    actorId: z
      .string()
      .trim()
      .min(1, 'Actor is required — enter a user ID (UUID)')
      .regex(ACTOR_UUID_PATTERN, 'Invalid actor — must be a valid user ID (UUID)'),
    traceId: z
      .string()
      .trim()
      .refine((value) => value.length === 0 || W3C_TRACE_ID_PATTERN.test(value), {
        message: 'Malformed Trace ID — expected 32 hexadecimal characters',
      }),
  })
  .superRefine((value, ctx) => {
    const range = resolveTimeRange(value);
    if ('error' in range) {
      ctx.addIssue({ code: 'custom', path: ['timeRange'], message: range.error });
    }
  });

type FilterFormValues = z.infer<typeof filterSchema>;
type WorkspaceView = 'trail' | 'timeline' | 'journey' | 'health';

function badgeClass(eventType: string): string {
  if (eventType === 'ui_action') return `${styles.badge} ${styles.badgeUi}`;
  if (eventType === 'api_request') return `${styles.badge} ${styles.badgeApi}`;
  if (eventType === 'error') return `${styles.badge} ${styles.badgeError}`;
  return `${styles.badge} ${styles.badgeAgent}`;
}

function toApplied(values: FilterFormValues, eventType: TrailEventFilter): AppliedWorkspaceFilters {
  const range = resolveTimeRange(values);
  if ('error' in range) {
    throw new Error(range.error);
  }
  return {
    from: range.from,
    to: range.to,
    actorId: values.actorId.trim().toLowerCase(),
    traceId: values.traceId.trim() || null,
    eventType: eventType === 'all' ? null : eventType,
  };
}

interface ObservabilityWorkspaceProps {
  project?: string;
}

export const ObservabilityWorkspace: React.FC<ObservabilityWorkspaceProps> = ({ project }) => {
  const { selectedProject } = useAppShell();
  const [activeView, setActiveView] = useState<WorkspaceView>('trail');
  const [eventChip, setEventChip] = useState<TrailEventFilter>('all');
  const [applied, setApplied] = useState<AppliedWorkspaceFilters | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [journeyHandoff, setJourneyHandoff] = useState<JourneyTrailHandoff | null>(null);

  const {
    register,
    handleSubmit,
    control,
    reset,
    setValue,
    formState: { errors },
  } = useForm<FilterFormValues>({
    resolver: zodResolver(filterSchema),
    defaultValues: emptyFilterDraft(),
    mode: 'onSubmit',
  });

  const resolvedProject = project ?? selectedProject;
  const timeRange = useWatch({ control, name: 'timeRange' });
  const trailQuery = useObservabilityTrail(resolvedProject, applied, cursor);
  const healthQuery = useObservabilityHealth(resolvedProject, activeView === 'health');

  const validationCount = Object.keys(errors).length;
  const trailFailed = Boolean(applied && trailQuery.isError);
  const healthFailed = activeView === 'health' && healthQuery.isError;
  const degraded = trailFailed || healthFailed;

  const onApply = useCallback(
    (values: FilterFormValues) => {
      const next = toApplied(values, eventChip);
      setApplied(journeyHandoff ? { ...next, routeTemplate: journeyHandoff.fromRoute } : next);
      setCursor(null);
      setCursorStack([]);
      setPageIndex(0);
    },
    [eventChip, journeyHandoff],
  );

  const onClear = useCallback(() => {
    reset(emptyFilterDraft());
    setEventChip('all');
    setApplied(null);
    setCursor(null);
    setCursorStack([]);
    setPageIndex(0);
    setSelectedSessionId(null);
    setJourneyHandoff(null);
  }, [reset]);

  const applyEventChip = useCallback(
    (chip: TrailEventFilter) => {
      setEventChip(chip);
      if (!applied) return;
      setApplied({ ...applied, eventType: chip === 'all' ? null : chip });
      setCursor(null);
      setCursorStack([]);
      setPageIndex(0);
    },
    [applied],
  );

  const openTrace = useCallback(
    (traceId: string) => {
      setValue('traceId', traceId);
      if (!applied) return;
      setApplied({ ...applied, traceId });
      setCursor(null);
      setCursorStack([]);
      setPageIndex(0);
      setActiveView('trail');
    },
    [applied, setValue],
  );

  const openSession = useCallback((sessionId: string) => {
    setSelectedSessionId(sessionId);
    setActiveView('timeline');
  }, []);

  const openJourneyTrail = useCallback((handoff: JourneyTrailHandoff) => {
    const fromIso = /^\d{4}-\d{2}-\d{2}$/.test(handoff.from) ? `${handoff.from}T00:00:00.000Z` : handoff.from;
    const toIso = /^\d{4}-\d{2}-\d{2}$/.test(handoff.to) ? `${handoff.to}T23:59:59.999Z` : handoff.to;
    setValue('timeRange', 'custom');
    setValue('customFrom', fromIso.slice(0, 16));
    setValue('customTo', toIso.slice(0, 16));
    setJourneyHandoff(handoff);
    setActiveView('trail');
    setApplied((current) => (
      current
        ? {
          ...current,
          from: fromIso,
          to: toIso,
          routeTemplate: handoff.fromRoute,
        }
        : current
    ));
    setCursor(null);
    setCursorStack([]);
    setPageIndex(0);
  }, [setValue]);

  const goNext = useCallback(() => {
    const next = trailQuery.data?.nextCursor;
    if (!next) return;
    setCursorStack((stack) => [...stack, cursor]);
    setCursor(next);
    setPageIndex((index) => index + 1);
  }, [cursor, trailQuery.data?.nextCursor]);

  const goPrev = useCallback(() => {
    setCursorStack((stack) => {
      if (stack.length === 0) return stack;
      const previous = stack[stack.length - 1] ?? null;
      setCursor(previous);
      setPageIndex((index) => Math.max(0, index - 1));
      return stack.slice(0, -1);
    });
  }, []);

  const items = trailQuery.data?.items ?? [];
  const capReached = Boolean(trailQuery.data?.capReached);
  const hasNext = Boolean(trailQuery.data?.nextCursor) && !capReached;
  const pageStart = items.length === 0 ? 0 : pageIndex * OBSERVABILITY_PAGE_SIZE + 1;
  const pageEnd = pageIndex * OBSERVABILITY_PAGE_SIZE + items.length;

  return (
    <section className={styles.workspace} {...{ 'data-testid': 'observability-workspace' }}>
      <div className={styles.header}>
        <div className={styles.titleRow}>
          <div>
            <h2 className={styles.title}>Observability</h2>
            <p className={styles.subtitle}>Unified workspace — shared filters apply across all views</p>
          </div>
          <div className={degraded ? `${styles.status} ${styles.statusDegraded}` : styles.status}>
            <span className={degraded ? `${styles.statusDot} ${styles.statusDotError}` : styles.statusDot} />
            <span>{degraded ? '1 sub-view degraded' : 'All systems operational'}</span>
          </div>
        </div>

        <form
          className={styles.filterForm}
          onSubmit={handleSubmit(onApply)}
          noValidate
          {...{ 'data-testid': 'observability-filter-form' }}
        >
          <div className={styles.filterGroup}>
            <label className={styles.filterLabel} htmlFor="observability-time-range">Time Range</label>
            <select
              id="observability-time-range"
              className={`${styles.filterInput} ${errors.timeRange ? styles.filterInputError : ''}`}
              {...register('timeRange')}
              {...{ 'data-testid': 'observability-time-range' }}
            >
              {TIME_RANGE_PRESETS.map((preset) => (
                <option key={preset} value={preset}>{TIME_RANGE_LABELS[preset]}</option>
              ))}
            </select>
            {errors.timeRange && <span className={styles.fieldError} role="alert">{errors.timeRange.message}</span>}
          </div>

          {timeRange === 'custom' && (
            <>
              <div className={styles.filterGroup}>
                <label className={styles.filterLabel} htmlFor="observability-custom-from">From</label>
                <input
                  id="observability-custom-from"
                  type="datetime-local"
                  className={styles.filterInput}
                  {...register('customFrom')}
                  {...{ 'data-testid': 'observability-custom-from' }}
                />
              </div>
              <div className={styles.filterGroup}>
                <label className={styles.filterLabel} htmlFor="observability-custom-to">To</label>
                <input
                  id="observability-custom-to"
                  type="datetime-local"
                  className={styles.filterInput}
                  {...register('customTo')}
                  {...{ 'data-testid': 'observability-custom-to' }}
                />
              </div>
            </>
          )}

          <div className={styles.filterGroup}>
            <label className={styles.filterLabel} htmlFor="observability-actor">Actor / User ID</label>
            <input
              id="observability-actor"
              className={`${styles.filterInput} ${errors.actorId ? styles.filterInputError : ''}`}
              placeholder="User ID (UUID)"
              autoComplete="off"
              {...register('actorId')}
              {...{ 'data-testid': 'observability-actor' }}
            />
            {errors.actorId && <span className={styles.fieldError} role="alert">{errors.actorId.message}</span>}
          </div>

          <div className={styles.filterGroup}>
            <label className={styles.filterLabel} htmlFor="observability-trace-id">Trace ID</label>
            <input
              id="observability-trace-id"
              className={`${styles.filterInput} ${errors.traceId ? styles.filterInputError : ''}`}
              placeholder="32-character hex trace ID"
              autoComplete="off"
              {...register('traceId')}
              {...{ 'data-testid': 'observability-trace-id' }}
            />
            {errors.traceId && <span className={styles.fieldError} role="alert">{errors.traceId.message}</span>}
          </div>

          <button type="submit" className={styles.primaryButton} {...{ 'data-testid': 'observability-apply-filters' }}>
            Apply Filters
          </button>
          <button type="button" className={styles.secondaryButton} onClick={onClear} {...{ 'data-testid': 'observability-clear-filters' }}>
            Clear
          </button>
          <div className={styles.capBadge} {...{ 'data-testid': 'observability-cap-badge' }}>
            {OBSERVABILITY_MAX_ROWS}-row cap active
          </div>
        </form>

        {validationCount > 0 && (
          <div className={styles.validationBanner} role="alert" {...{ 'data-testid': 'observability-validation-summary' }}>
            {validationCount} validation error{validationCount === 1 ? '' : 's'} — search is blocked. Fix the highlighted fields to proceed. No Trace Event details are returned.
          </div>
        )}

        <div className={styles.tabs} role="tablist" aria-label="Observability views">
          <WorkspaceNav id="trail" label="User Activity Trail" active={activeView === 'trail'} onSelect={setActiveView} />
          <WorkspaceNav id="timeline" label="Timeline" active={activeView === 'timeline'} onSelect={setActiveView} />
          <WorkspaceNav id="journey" label="Journey Map" active={activeView === 'journey'} onSelect={setActiveView} />
          <WorkspaceNav id="health" label="Capture Health" active={activeView === 'health'} onSelect={setActiveView} />
        </div>
      </div>

      {activeView === 'trail' && (
        <div
          className={styles.panel}
          role="tabpanel"
          id="observability-panel-trail"
          aria-labelledby="observability-tab-trail"
          {...{ 'data-testid': 'observability-trail-panel' }}
        >
          <TrailView
            applied={applied}
            eventChip={eventChip}
            items={items}
            isLoading={trailQuery.isLoading}
            isFetching={trailQuery.isFetching}
            isError={trailQuery.isError}
            errorMessage={trailQuery.error?.message ?? 'User Activity Trail service is unavailable'}
            capReached={capReached}
            hasNext={hasNext}
            hasPrev={cursorStack.length > 0}
            pageStart={pageStart}
            pageEnd={pageEnd}
            onChip={applyEventChip}
            onRetry={() => { void trailQuery.refetch(); }}
            onNext={goNext}
            onPrev={goPrev}
            onOpenTrace={openTrace}
            onOpenSession={openSession}
            journeyHandoff={journeyHandoff}
          />
        </div>
      )}

      {activeView === 'timeline' && (
        <div
          className={styles.panel}
          role="tabpanel"
          id="observability-panel-timeline"
          aria-labelledby="observability-tab-timeline"
          {...{ 'data-testid': 'observability-timeline-panel' }}
        >
        {selectedSessionId ? (
          <SessionTimelinePage
            project={resolvedProject}
            sessionId={selectedSessionId}
            onSessionChange={setSelectedSessionId}
          />
        ) : (
          <PlaceholderView
            title="Timeline View"
            testId="observability-timeline-empty"
            detail="Select a session from the User Activity Trail to open the matching Session Timeline."
          />
        )}
        </div>
      )}

      {activeView === 'journey' && (
        <div
          className={styles.panel}
          role="tabpanel"
          id="observability-panel-journey"
          aria-labelledby="observability-tab-journey"
          {...{ 'data-testid': 'observability-journey-panel' }}
        >
          <ErrorBoundary FallbackComponent={ViewErrorFallback}>
            <Suspense fallback={<div className={styles.loading} role="status">Loading Journey Map…</div>}>
              <InteractiveJourneyMapPage
                project={resolvedProject}
                sharedRange={applied ? { from: applied.from, to: applied.to } : undefined}
                onOpenTrail={openJourneyTrail}
              />
            </Suspense>
          </ErrorBoundary>
        </div>
      )}

      {activeView === 'health' && (
        <div
          className={styles.panel}
          role="tabpanel"
          id="observability-panel-health"
          aria-labelledby="observability-tab-health"
          {...{ 'data-testid': 'observability-health-panel' }}
        >
          <HealthView
            data={healthQuery.data}
            isLoading={healthQuery.isLoading}
            isError={healthQuery.isError}
            errorMessage={healthQuery.error?.message ?? 'Health collection endpoint failed'}
            capturedAt={healthQuery.dataUpdatedAt}
            onRetry={() => { void healthQuery.refetch(); }}
          />
        </div>
      )}
    </section>
  );
};

interface WorkspaceNavProps {
  id: WorkspaceView;
  label: string;
  active: boolean;
  onSelect: (id: WorkspaceView) => void;
}

const WorkspaceNav: React.FC<WorkspaceNavProps> = ({ id, label, active, onSelect }) => (
  <button
    type="button"
    role="tab"
    id={`observability-tab-${id}`}
    aria-selected={active}
    aria-controls={`observability-panel-${id}`}
    className={active ? `${styles.tab} ${styles.tabActive}` : styles.tab}
    onClick={() => onSelect(id)}
    {...{ 'data-testid': `observability-tab-${id}` }}
  >
    {label}
  </button>
);

interface PlaceholderViewProps {
  title: string;
  detail: string;
  testId: string;
}

const PlaceholderView: React.FC<PlaceholderViewProps> = ({ title, detail, testId }) => (
  <div className={styles.placeholder} {...{ 'data-testid': testId }}>
    <p className={styles.placeholderTitle}>{title}</p>
    <p className={styles.placeholderText}>{detail}</p>
  </div>
);

interface TrailViewProps {
  applied: AppliedWorkspaceFilters | null;
  eventChip: TrailEventFilter;
  items: TraceEventView[];
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  errorMessage: string;
  capReached: boolean;
  hasNext: boolean;
  hasPrev: boolean;
  pageStart: number;
  pageEnd: number;
  onChip: (chip: TrailEventFilter) => void;
  onRetry: () => void;
  onNext: () => void;
  onPrev: () => void;
  onOpenTrace: (traceId: string) => void;
  onOpenSession: (sessionId: string) => void;
  journeyHandoff: JourneyTrailHandoff | null;
}

const TrailView: React.FC<TrailViewProps> = ({
  applied,
  eventChip,
  items,
  isLoading,
  isFetching,
  isError,
  errorMessage,
  capReached,
  hasNext,
  hasPrev,
  pageStart,
  pageEnd,
  onChip,
  onRetry,
  onNext,
  onPrev,
  onOpenTrace,
  onOpenSession,
  journeyHandoff,
}) => {
  if (isError) {
    return (
      <div>
        <div className={styles.errorCard} role="alert" {...{ 'data-testid': 'observability-trail-error' }}>
          <div>
            <p className={styles.errorTitle}>User Activity Trail service is unavailable</p>
            <p className={styles.errorDetail}>
              {errorMessage}. No results are displayed. Stale data is not shown to avoid misleading investigation context. The error is isolated — other workspace sub-views remain functional.
            </p>
            <button type="button" className={styles.retryButton} onClick={onRetry} {...{ 'data-testid': 'observability-trail-retry' }}>
              Retry
            </button>
          </div>
        </div>
        <div className={styles.intact}>Shared filters are preserved — Timeline, Journey Map, and Capture Health sub-views are unaffected by this error.</div>
      </div>
    );
  }

  if (!applied) {
    return (
      <div className={styles.empty} {...{ 'data-testid': 'observability-trail-empty' }}>
        <p className={styles.emptyTitle}>Search a user activity trail</p>
        <p className={styles.emptyText}>
          {journeyHandoff
            ? `Journey pivot ready: ${journeyHandoff.fromRoute} → ${journeyHandoff.toRoute} (${journeyHandoff.from} to ${journeyHandoff.to}). Enter a user ID and apply filters to search.`
            : 'Enter a user ID and apply shared filters to load chronological UI actions, API calls, and errors.'}
        </p>
      </div>
    );
  }

  if (isLoading || (isFetching && items.length === 0)) {
    return (
      <div className={styles.loading} role="status" {...{ 'data-testid': 'observability-trail-loading' }}>
        Loading User Activity Trail…
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className={styles.empty} {...{ 'data-testid': 'observability-trail-empty' }}>
        <p className={styles.emptyTitle}>No matching Trace Events</p>
        <p className={styles.emptyText}>No events match the current actor, time range, and filters.</p>
      </div>
    );
  }

  return (
    <>
      {journeyHandoff && (
        <div className={styles.intact} {...{ 'data-testid': 'observability-journey-trail-handoff' }}>
          Journey pivot: {journeyHandoff.fromRoute} → {journeyHandoff.toRoute} ({journeyHandoff.from} to {journeyHandoff.to})
        </div>
      )}
      <div className={styles.toolbar}>
        <span className={styles.pageMeta}>Filter events:</span>
        <EventFilterControl chip="all" label="All" active={eventChip === 'all'} onSelect={onChip} />
        <EventFilterControl chip="ui_action" label="UI Actions" active={eventChip === 'ui_action'} onSelect={onChip} />
        <EventFilterControl chip="api_request" label="API Calls" active={eventChip === 'api_request'} onSelect={onChip} />
        <EventFilterControl chip="error" label="Errors" active={eventChip === 'error'} onSelect={onChip} />
        <span className={styles.pageMeta}>
          Showing {pageStart}–{pageEnd}
          {capReached ? ` of ${OBSERVABILITY_MAX_ROWS} (cap reached)` : ''}
        </span>
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table} {...{ 'data-testid': 'observability-trail-table' }}>
          <caption className="sr-only">Chronological user activity trail</caption>
          <thead>
            <tr>
              <th scope="col">Timestamp</th>
              <th scope="col">Event Type</th>
              <th scope="col">Description</th>
              <th scope="col">Actor</th>
              <th scope="col">Trace ID</th>
              <th scope="col">Session</th>
            </tr>
          </thead>
          <tbody>
            {items.map((event) => (
              <tr key={event.id} {...{ 'data-testid': `observability-trail-row-${event.id}` }}>
                <td>
                  <time dateTime={event.occurredAt}>{new Date(event.occurredAt).toISOString().replace('T', ' ').replace('Z', ' UTC')}</time>
                </td>
                <td><span className={badgeClass(event.eventType)}>{describeEventType(event.eventType)}</span></td>
                <td>{formatTrailDescription(event)}</td>
                <td>{event.actorId ?? '—'}</td>
                <td>
                  <button
                    type="button"
                    className={styles.traceLink}
                    onClick={() => onOpenTrace(event.traceId)}
                    {...{ 'data-testid': `observability-trace-link-${event.traceId}` }}
                  >
                    {event.traceId.slice(0, 16)}
                  </button>
                </td>
                <td>
                  {event.sessionId ? (
                    <button
                      type="button"
                      className={styles.sessionLink}
                      onClick={() => onOpenSession(event.sessionId!)}
                      {...{ 'data-testid': `observability-session-link-${event.sessionId}` }}
                    >
                      {event.sessionId.slice(0, 8)}
                    </button>
                  ) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className={styles.pagination}>
        <p className={styles.paginationInfo} {...{ 'data-testid': 'observability-trail-pagination-info' }}>
          {capReached
            ? `Showing ${pageStart}–${pageEnd} of ${OBSERVABILITY_MAX_ROWS} (cap reached) — refine filters to narrow results`
            : `Showing ${pageStart}–${pageEnd} — ${OBSERVABILITY_PAGE_SIZE} rows per page`}
        </p>
        <div className={styles.paginationControls}>
          <button type="button" className={styles.pageButton} disabled={!hasPrev} onClick={onPrev} {...{ 'data-testid': 'observability-trail-prev' }}>
            Prev
          </button>
          <button type="button" className={styles.pageButton} disabled={!hasNext} onClick={onNext} {...{ 'data-testid': 'observability-trail-next' }}>
            Next
          </button>
        </div>
      </div>
    </>
  );
};

interface EventFilterControlProps {
  chip: TrailEventFilter;
  label: string;
  active: boolean;
  onSelect: (chip: TrailEventFilter) => void;
}

const EventFilterControl: React.FC<EventFilterControlProps> = ({ chip, label, active, onSelect }) => (
  <button
    type="button"
    className={active ? `${styles.chip} ${styles.chipActive}` : styles.chip}
    aria-pressed={active}
    onClick={() => onSelect(chip)}
    {...{ 'data-testid': `observability-trail-chip-${chip}` }}
  >
    {label}
  </button>
);

interface HealthViewProps {
  data: CaptureHealthResponse | undefined;
  isLoading: boolean;
  isError: boolean;
  errorMessage: string;
  capturedAt: number;
  onRetry: () => void;
}

const HealthView: React.FC<HealthViewProps> = ({ data, isLoading, isError, errorMessage, capturedAt, onRetry }) => {
  const health = useMemo(() => data ?? null, [data]);
  const bufferAtCap = health ? isBufferAtCapacity(health.pipeline.bufferDepth, health.pipeline.bufferCapacity) : false;
  const retentionHit = health ? isRetentionBoundaryReached(health.store.oldestRetainedEventAt) : false;
  const bufferPct = health && health.pipeline.bufferCapacity > 0
    ? Math.min(100, Math.round((health.pipeline.bufferDepth / health.pipeline.bufferCapacity) * 100))
    : 0;

  if (isLoading && !health) {
    return (
      <div className={styles.loading} role="status" {...{ 'data-testid': 'observability-health-loading' }}>
        Loading Capture Health…
      </div>
    );
  }

  return (
    <>
      <div className={styles.metaRow}>
        {isError && (
          <span className={styles.staleBadge} {...{ 'data-testid': 'observability-health-stale' }}>
            Stale — collection failed
          </span>
        )}
        {health && !isError && (
          <span className={styles.metaText}>
            Last refreshed: {new Date(capturedAt || health.capturedAt).toISOString().replace('T', ' ').replace('.000Z', ' UTC')}
          </span>
        )}
        <button type="button" className={styles.refreshButton} onClick={onRetry} {...{ 'data-testid': 'observability-health-refresh' }}>
          {isError ? 'Retry' : 'Refresh'}
        </button>
      </div>

      {isError && (
        <div className={styles.errorBanner} role="alert" {...{ 'data-testid': 'observability-health-error' }}>
          <div>
            <p className={styles.errorTitle}>Health collection endpoint failed</p>
            <p className={styles.errorDetail}>
              {errorMessage}. Capture itself is unaffected — this is a monitoring endpoint failure only. Trail, Timeline, and Journey Map views remain available.
            </p>
            <button type="button" className={styles.retryButton} onClick={onRetry} {...{ 'data-testid': 'observability-health-retry' }}>
              Retry collection
            </button>
          </div>
        </div>
      )}

      {health && !isError && (
        <div className={styles.statusBar}>
          <span className={bufferAtCap || retentionHit ? `${styles.statusDot} ${styles.statusDotWarn}` : styles.statusDot} />
          {bufferAtCap || retentionHit
            ? 'Capture operating with boundary warnings'
            : 'Capture operating normally — no active incidents'}
        </div>
      )}

      {health && !isError && bufferAtCap && (
        <div className={styles.warnBanner} role="status" {...{ 'data-testid': 'observability-health-buffer-warning' }}>
          <div>
            <strong>Buffer depth at capacity ({health.pipeline.bufferDepth.toLocaleString()} / {health.pipeline.bufferCapacity.toLocaleString()})</strong>
            <div>New events may be dropped. Consider disabling observability-capture before drop escalation affects Apex.</div>
          </div>
        </div>
      )}

      {health && !isError && retentionHit && (
        <div className={styles.warnBanner} role="status" {...{ 'data-testid': 'observability-health-retention-warning' }}>
          <div>
            <strong>Oldest retained event has reached the {OBSERVABILITY_RAW_RETENTION_DAYS}-day boundary</strong>
            <div>Raw Trace Events older than {OBSERVABILITY_RAW_RETENTION_DAYS} days are eligible for purge.</div>
          </div>
        </div>
      )}

      {health && (
        <div className={isError ? `${styles.grid} ${styles.staleGrid}` : styles.grid} {...{ 'data-testid': 'observability-health-grid' }}>
          <HealthMetric
            testId="observability-health-dropped"
            label="Dropped Events"
            value={String(health.pipeline.droppedEvents)}
            sub={`Rate: ${health.pipeline.droppedEventsPerSecond} / sec`}
          />
          <HealthMetric
            testId="observability-health-buffer"
            label="Buffer Depth"
            value={health.pipeline.bufferDepth.toLocaleString()}
            sub={`Cap: ${health.pipeline.bufferCapacity.toLocaleString()} — ${bufferPct}% full`}
            warn={bufferAtCap}
            progress={bufferPct}
          />
          <HealthMetric
            testId="observability-health-throughput"
            label="Throughput"
            value={String(health.pipeline.ingestedEventsPerSecond)}
            sub="events / sec (ingest)"
          />
          <HealthMetric
            testId="observability-health-flush"
            label="Flush Failures"
            value={String(health.pipeline.flushErrorCount)}
            sub={health.pipeline.latestFlushError?.occurredAt
              ? `Latest: ${health.pipeline.latestFlushError.occurredAt}`
              : 'No recent flush error'}
          />
          <HealthMetric
            testId="observability-health-store"
            label="Approx. Store Size"
            value={formatStoreBytes(health.store.approximateStoreBytes)}
            sub="across retained Trace Events"
          />
          <HealthMetric
            testId="observability-health-oldest"
            label="Oldest Retained Event"
            value={health.store.oldestRetainedEventAt ?? 'None'}
            sub={retentionHit ? `${OBSERVABILITY_RAW_RETENTION_DAYS}-day boundary reached` : `Within ${OBSERVABILITY_RAW_RETENTION_DAYS}-day retention`}
            warn={retentionHit}
          />
        </div>
      )}

      {isError && (
        <div className={styles.intact}>Capture pipeline is not affected. This error is limited to health monitoring only.</div>
      )}
    </>
  );
};

interface HealthMetricProps {
  testId: string;
  label: string;
  value: string;
  sub: string;
  warn?: boolean;
  progress?: number;
}

const HealthMetric: React.FC<HealthMetricProps> = ({ testId, label, value, sub, warn = false, progress }) => (
  <article className={warn ? `${styles.card} ${styles.cardWarn}` : styles.card} {...{ 'data-testid': testId }}>
    <div className={styles.cardLabel}>{label}</div>
    <div className={warn ? `${styles.cardValue} ${styles.cardValueWarn}` : styles.cardValue}>{value}</div>
    <div className={styles.cardSub}>{sub}</div>
    {progress != null && (
      <div className={styles.progress}>
        <div
          className={`${styles.progressFill} ${progress >= 100 ? styles.progressCritical : progress >= 80 ? styles.progressWarn : ''}`}
          style={{ width: `${progress}%` }}
        />
      </div>
    )}
  </article>
);

export default ObservabilityWorkspace;
