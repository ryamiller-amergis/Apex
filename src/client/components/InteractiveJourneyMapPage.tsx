import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  JOURNEY_TABLE_PAGE_SIZE,
  OBSERVABILITY_MAX_ROWS,
  OBSERVABILITY_VIEWER_FLAG,
  type JourneyDatePreset,
  type JourneyEdge,
  type JourneyMapFilters,
  type JourneyMapResponse,
  type JourneyMinTransitions,
  type JourneyTrailHandoff,
} from '../../shared/types/observability';
import { useFeatureFlag } from '../hooks/useFeatureFlags';
import { useJourneyMap } from '../hooks/useJourneyMap';
import {
  defaultJourneyFilters,
  edgeStableKey,
  isRangeWithinCoverage,
  journeyCoverageWindow,
  layoutJourneyGraph,
  rangeForPreset,
  routeStableKey,
  selectCanvasEdges,
  toUtcDay,
} from '../observability/journeyGraph';
import styles from './InteractiveJourneyMapPage.module.css';

const toolbarSchema = z
  .object({
    preset: z.enum(['7d', '30d', 'custom']),
    customFrom: z.string(),
    customTo: z.string(),
    minTransitions: z.enum(['1', '10', '50', '100']),
  })
  .superRefine((value, ctx) => {
    if (value.preset !== 'custom') return;
    if (!value.customFrom || !value.customTo) {
      ctx.addIssue({ code: 'custom', path: ['customFrom'], message: 'Custom range requires start and end dates' });
      return;
    }
    if (value.customFrom > value.customTo) {
      ctx.addIssue({ code: 'custom', path: ['customFrom'], message: 'Start date must be on or before end date' });
    }
  });

type ToolbarValues = z.infer<typeof toolbarSchema>;

function toMinTransitions(value: ToolbarValues['minTransitions']): JourneyMinTransitions {
  return Number(value) as JourneyMinTransitions;
}

interface InteractiveJourneyMapPageProps {
  project: string;
  sharedRange?: { from: string; to: string };
  onOpenTrail?: (handoff: JourneyTrailHandoff) => void;
}

function filtersFromToolbar(values: ToolbarValues, nowMs = Date.now()): JourneyMapFilters {
  if (values.preset === 'custom') {
    return {
      from: toUtcDay(values.customFrom),
      to: toUtcDay(values.customTo),
      minTransitions: toMinTransitions(values.minTransitions),
    };
  }
  const range = rangeForPreset(values.preset, nowMs);
  return { ...range, minTransitions: toMinTransitions(values.minTransitions) };
}

function initialToolbar(sharedRange: InteractiveJourneyMapPageProps['sharedRange'], nowMs = Date.now()): ToolbarValues {
  const coverage = journeyCoverageWindow(nowMs);
  const defaults = defaultJourneyFilters(nowMs);
  if (
    sharedRange
    && isRangeWithinCoverage(sharedRange.from, sharedRange.to, coverage.availableFrom, coverage.availableTo)
  ) {
    return {
      preset: 'custom',
      customFrom: toUtcDay(sharedRange.from),
      customTo: toUtcDay(sharedRange.to),
      minTransitions: String(defaults.minTransitions) as ToolbarValues['minTransitions'],
    };
  }
  return {
    preset: '30d',
    customFrom: defaults.from,
    customTo: defaults.to,
    minTransitions: String(defaults.minTransitions) as ToolbarValues['minTransitions'],
  };
}

export const InteractiveJourneyMapPage: React.FC<InteractiveJourneyMapPageProps> = ({
  project,
  sharedRange,
  onOpenTrail,
}) => {
  const viewerEnabled = useFeatureFlag(OBSERVABILITY_VIEWER_FLAG, project);
  const coverage = useMemo(() => journeyCoverageWindow(), []);
  const [toolbarSeed] = useState(() => initialToolbar(sharedRange));
  const {
    register,
    control,
    reset,
    formState: { errors },
  } = useForm<ToolbarValues>({
    resolver: zodResolver(toolbarSchema),
    defaultValues: toolbarSeed,
    mode: 'onChange',
  });
  const preset = useWatch({ control, name: 'preset' });
  const customFrom = useWatch({ control, name: 'customFrom' });
  const customTo = useWatch({ control, name: 'customTo' });
  const minTransitions = useWatch({ control, name: 'minTransitions' });
  const headingRef = useRef<HTMLHeadingElement>(null);
  const applied = useMemo(() => {
    const values: ToolbarValues = {
      preset: (preset ?? '30d') as JourneyDatePreset,
      customFrom: customFrom ?? '',
      customTo: customTo ?? '',
      minTransitions: (minTransitions ?? '50') as ToolbarValues['minTransitions'],
    };
    const parsed = toolbarSchema.safeParse(values);
    if (!parsed.success) return filtersFromToolbar(toolbarSeed);
    const next = filtersFromToolbar(parsed.data);
    if (!isRangeWithinCoverage(next.from, next.to, coverage.availableFrom, coverage.availableTo)) {
      return filtersFromToolbar(toolbarSeed);
    }
    return next;
  }, [preset, customFrom, customTo, minTransitions, coverage.availableFrom, coverage.availableTo, toolbarSeed]);
  const query = useJourneyMap(project, applied, viewerEnabled);

  const onReset = useCallback(() => {
    reset(initialToolbar(undefined));
  }, [reset]);

  const onRefresh = useCallback(() => {
    void Promise.resolve(query.refetch()).finally(() => headingRef.current?.focus());
  }, [query]);

  const current = query.isError ? undefined : query.data;

  // @feature-flag:observability-viewer start winner=enabled
  if (!viewerEnabled) {
    // @feature-flag:observability-viewer disabled-start
    return null;
    // @feature-flag:observability-viewer disabled-end
  }

  // @feature-flag:observability-viewer enabled-start
  return (
    <section className={styles.page} {...{ 'data-testid': 'journey-map-page' }}>
      <form
        className={styles.toolbar}
        onSubmit={(event) => event.preventDefault()}
        noValidate
        {...{ 'data-testid': 'journey-map-toolbar' }}
      >
        <div className={styles.titleGroup}>
          <h3 className={styles.title} ref={headingRef} tabIndex={-1} id="journey-map-heading">
            Apex Route Journey Map
            <span className={styles.beta}>Beta</span>
          </h3>
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="journey-map-date-range">Date range</label>
          <select
            id="journey-map-date-range"
            className={styles.select}
            disabled={query.isLoading}
            {...register('preset')}
            {...{ 'data-testid': 'journey-map-date-range' }}
          >
            <option value="7d">Last 7 days</option>
            <option value="30d">Last 30 days</option>
            <option value="custom">Custom range</option>
          </select>
        </div>
        {preset === 'custom' && (
          <>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="journey-map-custom-from">From</label>
              <input
                id="journey-map-custom-from"
                type="date"
                className={styles.input}
                min={coverage.availableFrom}
                max={coverage.availableTo}
                {...register('customFrom')}
                {...{ 'data-testid': 'journey-map-custom-from' }}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="journey-map-custom-to">To</label>
              <input
                id="journey-map-custom-to"
                type="date"
                className={styles.input}
                min={coverage.availableFrom}
                max={coverage.availableTo}
                {...register('customTo')}
                {...{ 'data-testid': 'journey-map-custom-to' }}
              />
            </div>
          </>
        )}
        <div className={styles.field}>
          <label className={styles.label} htmlFor="journey-map-min-transitions">Minimum transitions</label>
          <select
            id="journey-map-min-transitions"
            className={styles.select}
            disabled={query.isLoading}
            {...register('minTransitions')}
            {...{ 'data-testid': 'journey-map-min-transitions' }}
          >
            <option value="1">All transitions</option>
            <option value="10">10+</option>
            <option value="50">50+</option>
            <option value="100">100+</option>
          </select>
        </div>
        <button type="button" className={styles.button} onClick={onReset} {...{ 'data-testid': 'journey-map-reset' }}>
          Reset
        </button>
        <button type="button" className={styles.buttonPrimary} onClick={onRefresh} {...{ 'data-testid': 'journey-map-refresh' }}>
          Refresh
        </button>
        {errors.customFrom && <span className={styles.fieldError} role="alert">{errors.customFrom.message}</span>}
      </form>

      {query.isError ? (
        <JourneyErrorState
          message={query.error?.message ?? 'Journey rollup query failed'}
          onRetry={onRefresh}
        />
      ) : query.isLoading || (!current && query.isFetching) ? (
        <div className={styles.loading} role="status" {...{ 'data-testid': 'journey-map-loading' }}>
          Loading Journey Map…
        </div>
      ) : current ? (
        <JourneyResult
          key={`${applied.from}|${applied.to}|${applied.minTransitions}`}
          result={current}
          canOpenTrail={Boolean(onOpenTrail)}
          onOpenTrail={onOpenTrail}
        />
      ) : null}
    </section>
  );
  // @feature-flag:observability-viewer enabled-end
  // @feature-flag:observability-viewer end
};

interface JourneyErrorStateProps {
  message: string;
  onRetry: () => void;
}

const JourneyErrorState: React.FC<JourneyErrorStateProps> = ({ message, onRetry }) => (
  <div>
    <div className={styles.errorBanner} role="alert" {...{ 'data-testid': 'journey-map-error' }}>
      <h4 className={styles.errorTitle}>Journey Map is unavailable</h4>
      <p className={styles.errorText}>
        {message}. The previous graph and transition list were removed so stale aggregate data is not shown as current.
      </p>
      <button type="button" className={styles.buttonPrimary} onClick={onRetry} {...{ 'data-testid': 'journey-map-retry' }}>
        Retry
      </button>
    </div>
    <div className={styles.placeholder}>Graph unavailable — retry to load current rollups</div>
  </div>
);

interface JourneyResultProps {
  result: JourneyMapResponse;
  canOpenTrail: boolean;
  onOpenTrail?: (handoff: JourneyTrailHandoff) => void;
}

const JourneyResult: React.FC<JourneyResultProps> = ({
  result,
  canOpenTrail,
  onOpenTrail,
}) => {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [tablePage, setTablePage] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [trailOpen, setTrailOpen] = useState(false);
  const canvasEdges = useMemo(() => selectCanvasEdges(result.edges), [result.edges]);
  const layout = useMemo(
    () => layoutJourneyGraph(result.nodes, canvasEdges),
    [result.nodes, canvasEdges],
  );
  const selected = result.edges.find((edge) => edgeStableKey(edge.fromRoute, edge.toRoute) === selectedKey) ?? null;
  const empty = result.edges.length === 0;
  const related = selected
    ? result.edges
      .filter((edge) =>
        edge.fromRoute === selected.fromRoute
        && edgeStableKey(edge.fromRoute, edge.toRoute) !== edgeStableKey(selected.fromRoute, selected.toRoute),
      )
      .slice(0, 5)
    : [];
  const onSelectEdge = (edge: JourneyEdge) => {
    setSelectedKey(edgeStableKey(edge.fromRoute, edge.toRoute));
  };

  return (
    <>
      <div className={styles.summary} {...{ 'data-testid': 'journey-map-summary' }}>
        <span><strong>{result.nodes.length}</strong> route nodes</span>
        <span><strong>{result.edges.length}</strong> transitions</span>
        <span><strong>{result.nodes.reduce((sum, node) => sum + node.distinctActorCount, 0)}</strong> distinct-actor measures</span>
        <span>Range {result.range.from} → {result.range.to}</span>
        <span>Rollup through {result.rollupThrough.replace('T', ' ').replace('.999Z', ' UTC')}</span>
        <span>Machine-driven transitions excluded</span>
        {result.truncated && (
          <span role="status">Query reached the {OBSERVABILITY_MAX_ROWS}-row cap</span>
        )}
        {result.edges.length > canvasEdges.length && (
          <span role="status">
            Canvas shows {canvasEdges.length} of {result.edges.length} transitions; the table lists all returned rows
          </span>
        )}
      </div>

      {empty ? (
        <div className={styles.empty} {...{ 'data-testid': 'journey-map-empty' }}>
          <h4 className={styles.emptyTitle}>No transitions in this range</h4>
          <p className={styles.emptyText}>
            Broaden the date range or lower the minimum-transition threshold. Concrete identifiers never appear in Journey results.
          </p>
        </div>
      ) : (
        <div className={styles.body}>
          <JourneyGraph
            layout={layout}
            selectedKey={selected ? edgeStableKey(selected.fromRoute, selected.toRoute) : null}
            zoom={zoom}
            onSelectEdge={onSelectEdge}
            onClearSelection={() => setSelectedKey(null)}
            onZoom={setZoom}
          />
          <aside className={styles.side} {...{ 'data-testid': 'journey-map-edge-detail' }}>
            <div className={styles.sideHeader}>Selected transition</div>
            <div className={styles.sideBody}>
              {selected ? (
                <>
                  <div className={styles.edgeCard}>
                    <div className={styles.route}>From <code>{selected.fromRoute}</code></div>
                    <div className={styles.route}>To <code>{selected.toRoute}</code></div>
                    <div className={styles.metrics}>
                      <div className={styles.metric}>
                        <span className={styles.metricValue}>{selected.transitionCount}</span>
                        <span className={styles.metricLabel}>Transitions</span>
                      </div>
                      <div className={styles.metric}>
                        <span className={styles.metricValue}>{selected.distinctActorCount}</span>
                        <span className={styles.metricLabel}>Distinct actors</span>
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    className={styles.buttonPrimary}
                    disabled={!canOpenTrail}
                    onClick={() => setTrailOpen(true)}
                    {...{ 'data-testid': 'journey-map-pivot' }}
                  >
                    Pivot to Activity Trail
                  </button>
                  {!canOpenTrail && (
                    <p className={styles.prompt}>
                      Trail pivot is unavailable until the workspace adapter is connected.
                    </p>
                  )}
                  {related.length > 0 && (
                    <>
                      <div className={styles.sectionLabel}>Top related routes</div>
                      {related.map((edge) => (
                        <div key={edgeStableKey(edge.fromRoute, edge.toRoute)} className={styles.related}>
                          <code>{edge.toRoute}</code>
                          <span>{edge.transitionCount}</span>
                        </div>
                      ))}
                    </>
                  )}
                </>
              ) : (
                <p className={styles.prompt}>Select an edge to inspect aggregate counts and pivot to a filtered trail.</p>
              )}
            </div>
          </aside>
        </div>
      )}

      <JourneyTransitionTable
        edges={result.edges}
        selectedKey={selected ? edgeStableKey(selected.fromRoute, selected.toRoute) : null}
        page={tablePage}
        truncated={result.truncated}
        canvasCount={canvasEdges.length}
        onSelect={onSelectEdge}
        onPage={setTablePage}
      />

      {trailOpen && selected && (
        <TrailPreview
          edge={selected}
          range={result.range}
          onClose={() => setTrailOpen(false)}
          onConfirm={() => {
            if (!selected || !onOpenTrail) return;
            onOpenTrail({
              fromRoute: selected.fromRoute,
              toRoute: selected.toRoute,
              from: result.range.from,
              to: result.range.to,
            });
            setTrailOpen(false);
          }}
        />
      )}
    </>
  );
};

interface JourneyGraphProps {
  layout: ReturnType<typeof layoutJourneyGraph>;
  selectedKey: string | null;
  zoom: number;
  onSelectEdge: (edge: JourneyEdge) => void;
  onClearSelection: () => void;
  onZoom: (zoom: number) => void;
}

const JourneyGraph: React.FC<JourneyGraphProps> = ({
  layout,
  selectedKey,
  zoom,
  onSelectEdge,
  onClearSelection,
  onZoom,
}) => {
  const items = useMemo(
    () => [
      ...layout.nodes.map((node) => ({ kind: 'node' as const, key: routeStableKey(node.routeTemplate), node })),
      ...layout.edges.map((edge) => ({ kind: 'edge' as const, key: edgeStableKey(edge.fromRoute, edge.toRoute), edge })),
    ],
    [layout],
  );

  const onGraphKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      onClearSelection();
      document.getElementById('journey-map-heading')?.focus();
      return;
    }
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowDown' && event.key !== 'ArrowLeft' && event.key !== 'ArrowUp') {
      return;
    }
    event.preventDefault();
    const currentIndex = items.findIndex((item) => {
      const active = document.activeElement?.getAttribute('data-testid');
      if (item.kind === 'node') return active === `journey-map-node-${item.key}`;
      return active === `journey-map-edge-${item.key}`;
    });
    const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
    const next = items[(currentIndex + delta + items.length) % items.length];
    const testId = next.kind === 'node' ? `journey-map-node-${next.key}` : `journey-map-edge-${next.key}`;
    document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.focus();
  };

  return (
    <div
      className={styles.graphArea}
      role="group"
      aria-label="Journey graph"
      onKeyDown={onGraphKeyDown}
      {...{ 'data-testid': 'journey-map-graph-area' }}
    >
      <svg
        className={styles.graphSvg}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="img"
        aria-labelledby="journey-map-heading"
        aria-describedby="journey-map-graph-desc"
        style={{ transform: `scale(${zoom})` }}
        {...{ 'data-testid': 'journey-map-graph' }}
      >
        <title>Apex route journey map</title>
        <desc id="journey-map-graph-desc">
          Directed aggregate transitions between normalized route templates. Use the transition table for the complete accessible equivalent.
        </desc>
        <defs>
          <marker id="journey-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
          </marker>
        </defs>
        {layout.edges.map((edge) => {
          const key = edgeStableKey(edge.fromRoute, edge.toRoute);
          const selected = selectedKey === key;
          return (
            <g
              key={key}
              className={selected ? styles.edgeSelected : undefined}
              role="button"
              tabIndex={0}
              aria-pressed={selected}
              aria-label={`${edge.fromRoute} to ${edge.toRoute}, ${edge.transitionCount} transitions, ${edge.distinctActorCount} distinct actors`}
              onClick={() => onSelectEdge(edge)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelectEdge(edge);
                }
              }}
              {...{ 'data-testid': `journey-map-edge-${key}` }}
            >
              <path d={edge.path} className={styles.edgeHit} />
              <path d={edge.path} className={styles.edgeLine} markerEnd="url(#journey-arrow)" />
              <text x={edge.labelX} y={edge.labelY} className={styles.edgeLabel} textAnchor="middle">{edge.transitionCount}</text>
            </g>
          );
        })}
        {layout.nodes.map((node) => {
          const key = routeStableKey(node.routeTemplate);
          return (
            <g
              key={key}
              className={styles.node}
              role="button"
              tabIndex={0}
              aria-label={`${node.routeTemplate}, ${node.transitionCount} transitions, ${node.distinctActorCount} distinct actors`}
              {...{ 'data-testid': `journey-map-node-${key}` }}
            >
              <circle className={styles.nodeCircle} cx={node.x} cy={node.y} r={node.r} />
              <text className={styles.nodeLabel} x={node.x} y={node.y + node.r + 14} textAnchor="middle">{node.routeTemplate}</text>
            </g>
          );
        })}
      </svg>
      <div className={styles.legend}>
        <div className={styles.legendTitle}>Legend</div>
        <div>Node size encodes transition volume</div>
        <div>Edge labels are aggregate transition counts</div>
      </div>
      <div className={styles.zoom}>
        <button type="button" className={styles.iconButton} aria-label="Zoom in" onClick={() => onZoom(Math.min(2, zoom + 0.2))} {...{ 'data-testid': 'journey-map-zoom-in' }}>+</button>
        <button type="button" className={styles.iconButton} aria-label="Zoom out" onClick={() => onZoom(Math.max(0.5, zoom - 0.2))} {...{ 'data-testid': 'journey-map-zoom-out' }}>−</button>
        <button type="button" className={styles.iconButton} aria-label="Fit to screen" onClick={() => onZoom(1)} {...{ 'data-testid': 'journey-map-fit' }}>Fit</button>
      </div>
    </div>
  );
};

interface JourneyTransitionTableProps {
  edges: JourneyEdge[];
  selectedKey: string | null;
  page: number;
  truncated: boolean;
  canvasCount: number;
  onSelect: (edge: JourneyEdge) => void;
  onPage: (page: number) => void;
}

const JourneyTransitionTable: React.FC<JourneyTransitionTableProps> = ({
  edges,
  selectedKey,
  page,
  truncated,
  canvasCount,
  onSelect,
  onPage,
}) => {
  const pageCount = Math.max(1, Math.ceil(edges.length / JOURNEY_TABLE_PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const rows = edges.slice(safePage * JOURNEY_TABLE_PAGE_SIZE, (safePage + 1) * JOURNEY_TABLE_PAGE_SIZE);
  const start = edges.length === 0 ? 0 : safePage * JOURNEY_TABLE_PAGE_SIZE + 1;
  const end = safePage * JOURNEY_TABLE_PAGE_SIZE + rows.length;

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table} {...{ 'data-testid': 'journey-map-transition-table' }}>
        <caption className={styles.srOnly}>
          Complete keyboard-operable equivalent of Journey Map relationships.
          {truncated ? ` Result set reached the ${OBSERVABILITY_MAX_ROWS}-row query cap.` : ''}
          {edges.length > canvasCount ? ` Canvas limited to ${canvasCount} edges; table lists ${edges.length}.` : ''}
        </caption>
        <thead>
          <tr>
            <th scope="col">From</th>
            <th scope="col">To</th>
            <th scope="col">Transitions</th>
            <th scope="col">Distinct actors</th>
            <th scope="col">Last seen</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={5}>No transitions match the current filters. Lower the threshold or broaden the date range.</td>
            </tr>
          ) : rows.map((edge) => {
            const key = edgeStableKey(edge.fromRoute, edge.toRoute);
            return (
              <tr key={key} className={selectedKey === key ? styles.rowSelected : undefined}>
                <td><code>{edge.fromRoute}</code></td>
                <td><code>{edge.toRoute}</code></td>
                <td>{edge.transitionCount}</td>
                <td>{edge.distinctActorCount}</td>
                <td>
                  <button
                    type="button"
                    className={styles.button}
                    onClick={() => onSelect(edge)}
                    {...{ 'data-testid': `journey-map-table-select-${key}` }}
                  >
                    {edge.lastSeen}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className={styles.pagination}>
        <p>
          Showing {start}–{end} of {edges.length}
          {truncated ? ` (cap ${OBSERVABILITY_MAX_ROWS})` : ''}
        </p>
        <div>
          <button type="button" className={styles.pageButton} disabled={safePage === 0} onClick={() => onPage(safePage - 1)} {...{ 'data-testid': 'journey-map-table-prev' }}>
            Prev
          </button>
          <button type="button" className={styles.pageButton} disabled={safePage >= pageCount - 1} onClick={() => onPage(safePage + 1)} {...{ 'data-testid': 'journey-map-table-next' }}>
            Next
          </button>
        </div>
      </div>
    </div>
  );
};

interface TrailPreviewProps {
  edge: JourneyEdge;
  range: { from: string; to: string };
  onClose: () => void;
  onConfirm: () => void;
}

const TrailPreview: React.FC<TrailPreviewProps> = ({ edge, range, onClose, onConfirm }) => {
  const closeRef = useRef<HTMLButtonElement>(null);
  const previous = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previous.current = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous.current?.focus();
    };
  }, [onClose]);

  return (
    <div
      className={styles.backdrop}
      role="presentation"
      {...{ 'data-testid': 'journey-map-trail-backdrop' }}
    >
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="journey-map-trail-title"
        {...{ 'data-testid': 'journey-map-trail-dialog' }}
      >
        <div className={styles.dialogHeader}>
          <h4 id="journey-map-trail-title">Open filtered Activity Trail</h4>
          <button type="button" className={styles.iconButton} ref={closeRef} aria-label="Close" onClick={onClose} {...{ 'data-testid': 'journey-map-trail-close' }}>
            ×
          </button>
        </div>
        <div className={styles.dialogBody}>
          <div className={styles.chipRow}>
            <span className={styles.chip}>From {edge.fromRoute}</span>
            <span className={styles.chip}>To {edge.toRoute}</span>
            <span className={styles.chip}>{range.from} → {range.to}</span>
            <span className={styles.chip}>{edge.transitionCount} transitions</span>
          </div>
          <p className={styles.prompt}>
            The Trail opens with this normalized route pair and date range. No actor identifiers are taken from the Journey Map.
          </p>
        </div>
        <div className={styles.dialogFooter}>
          <button type="button" className={styles.button} onClick={onClose} {...{ 'data-testid': 'journey-map-trail-cancel' }}>
            Close
          </button>
          <button type="button" className={styles.buttonPrimary} onClick={onConfirm} {...{ 'data-testid': 'journey-map-open-trail' }}>
            Open Full Trail
          </button>
        </div>
      </div>
    </div>
  );
};

export default InteractiveJourneyMapPage;
