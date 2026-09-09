import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import type { OutcomeFilters, DeploymentResult } from '../../shared/types/deploymentOutcome';
import {
  useOutcomeReport,
  useFilteredOutcomes,
  useExportOutcomeReport,
  useAvailableReleaseVersions,
  useReleaseEpics,
} from '../hooks/useDeploymentOutcomes';
import type { ReleaseEpicSummary } from '../hooks/useDeploymentOutcomes';
import { useAppShell } from '../hooks/useAppShell';
import { OutcomeReportTableRow } from './OutcomeReportTableRow';
import type { OutcomeReportRow } from './OutcomeReportTableRow';
import styles from './DeploymentOutcomeReport.module.css';

interface DeploymentOutcomeReportProps {
  onClose: () => void;
  project?: string;
  areaPath?: string;
}

const RESULTS: DeploymentResult[] = ['success', 'downtime', 'rollback'];
const PAGE_SIZE = 10;
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const DAYS_SHORT = ['Su','Mo','Tu','We','Th','Fr','Sa'];

function formatDowntime(minutes: number): string {
  if (minutes >= 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  return `${minutes} min`;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function formatDate(iso: string): string {
  const opts: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'short', day: 'numeric' };

  // Filter bounds and ADO target dates are calendar days, not instants. Parsing them
  // as UTC and rendering local would show the previous day west of Greenwich.
  if (DATE_ONLY.test(iso)) {
    return new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, opts);
  }

  const date = new Date(iso);
  const isMidnightUtc =
    iso.endsWith('Z') &&
    date.getUTCHours() === 0 &&
    date.getUTCMinutes() === 0 &&
    date.getUTCSeconds() === 0;
  if (isMidnightUtc) {
    return date.toLocaleDateString(undefined, { ...opts, timeZone: 'UTC' });
  }

  return date.toLocaleDateString(undefined, opts);
}

/**
 * A release with no recorded outcome has no result or recorded date, so the outcome
 * filters are applied against the Epic's own target date instead.
 */
function matchesFilters(epic: ReleaseEpicSummary, filters: OutcomeFilters): boolean {
  if (filters.result) return false;

  const versions = filters.releaseVersions ?? (filters.releaseVersion ? [filters.releaseVersion] : []);
  if (versions.length > 0 && !versions.includes(epic.version)) return false;

  const hasDateFilter = Boolean(filters.startDate || filters.endDate);
  if (!hasDateFilter) return true;

  const target = epic.targetDate?.slice(0, 10);
  if (!target) return false;
  if (filters.startDate && target < filters.startDate) return false;
  if (filters.endDate && target > filters.endDate) return false;
  return true;
}

function sortValue(row: OutcomeReportRow, col: string): string | number {
  switch (col) {
    case 'releaseVersion':
      return row.releaseVersion;
    case 'deployedAt':
      return row.deployedAt ?? '';
    case 'reportedAt':
      return row.recordedAt ?? '';
    default: {
      const value = (row.outcome as unknown as Record<string, unknown> | undefined)?.[col];
      return typeof value === 'number' ? value : ((value as string | undefined) ?? '');
    }
  }
}

function formatMonth(monthStr: string): string {
  const [year, month] = monthStr.split('-');
  const date = new Date(Number(year), Number(month) - 1);
  return date.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
}

/* ── DatePickerInput ─────────────────────────────────────────────────────────── */

interface DatePickerInputProps {
  value: string | undefined;
  onChange: (date: string | undefined) => void;
  placeholder: string;
  id?: string;
  testId: string;
}

const DatePickerInput: React.FC<DatePickerInputProps> = ({ value, onChange, placeholder, id, testId }) => {
  const today = new Date();
  const [open, setOpen] = useState(false);
  const [viewYear, setViewYear] = useState(() =>
    value ? parseInt(value.slice(0, 4), 10) : today.getFullYear(),
  );
  const [viewMonth, setViewMonth] = useState(() =>
    value ? parseInt(value.slice(5, 7), 10) - 1 : today.getMonth(),
  );
  const wrapRef = useRef<HTMLDivElement>(null);

  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const prevMonth = () => {
    if (viewMonth === 0) { setViewYear(y => y - 1); setViewMonth(11); }
    else setViewMonth(m => m - 1);
  };
  const nextMonth = () => {
    if (viewMonth === 11) { setViewYear(y => y + 1); setViewMonth(0); }
    else setViewMonth(m => m + 1);
  };

  const firstDayOffset = new Date(viewYear, viewMonth, 1).getDay();
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const cells: (number | null)[] = [
    ...Array(firstDayOffset).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  const handleDayClick = (day: number) => {
    const iso = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    onChange(iso);
    setOpen(false);
  };

  const displayValue = value
    ? new Date(value + 'T00:00:00').toLocaleDateString(undefined, {
        month: 'short', day: 'numeric', year: 'numeric',
      })
    : '';

  return (
    <div className={styles.datePickerWrap} ref={wrapRef}>
      <button
        id={id}
        type="button"
        className={`${styles.datePickerTrigger} ${value ? styles.datePickerTriggerFilled : ''} ${open ? styles.datePickerTriggerOpen : ''}`}
        onClick={() => setOpen(o => !o)}
        {...{ 'data-testid': `${testId}-trigger` }}
      >
        <svg className={styles.datePickerIcon} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="1" y="2" width="14" height="13" rx="2" stroke="currentColor" strokeWidth="1.3"/>
          <path d="M1 6h14" stroke="currentColor" strokeWidth="1.3"/>
          <path d="M5 1v2M11 1v2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
        </svg>
        <span className={styles.datePickerValue}>{displayValue || placeholder}</span>
        {value && (
          <span
            className={styles.datePickerClear}
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); onChange(undefined); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); onChange(undefined); } }}
            title="Clear date"
            {...{ 'data-testid': `${testId}-clear` }}
          >
            ×
          </span>
        )}
      </button>

      {open && (
        <div className={styles.calPopover}>
          <div className={styles.calHeader}>
            <button type="button" className={styles.calNavBtn} onClick={prevMonth} title="Previous month" {...{ 'data-testid': `${testId}-prev-month` }}>‹</button>
            <span className={styles.calMonthLabel}>{MONTHS_SHORT[viewMonth]} {viewYear}</span>
            <button type="button" className={styles.calNavBtn} onClick={nextMonth} title="Next month" {...{ 'data-testid': `${testId}-next-month` }}>›</button>
          </div>

          <div className={styles.calDayNames}>
            {DAYS_SHORT.map(d => (
              <span key={d} className={styles.calDayName}>{d}</span>
            ))}
          </div>

          <div className={styles.calGrid}>
            {cells.map((day, i) => {
              if (day === null) return <span key={`e-${i}`} />;
              const iso = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
              const isSelected = value === iso;
              const isToday = todayIso === iso;
              return (
                <button
                  key={day}
                  type="button"
                  className={[
                    styles.calDay,
                    isSelected ? styles.calDaySelected : '',
                    isToday && !isSelected ? styles.calDayToday : '',
                  ].filter(Boolean).join(' ')}
                  onClick={() => handleDayClick(day)}
                  {...{ 'data-testid': `${testId}-day-${day}` }}
                >
                  {day}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

/* ── MultiSelectTypeahead ─────────────────────────────────────────────────────── */

interface MultiSelectTypeaheadProps {
  selected: string[];
  options: string[];
  loading?: boolean;
  onChange: (values: string[]) => void;
  placeholder: string;
}

const MultiSelectTypeahead: React.FC<MultiSelectTypeaheadProps> = ({
  selected,
  options,
  loading,
  onChange,
  placeholder,
}) => {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(
    () => options.filter(o => !selected.includes(o) && o.toLowerCase().includes(query.toLowerCase())),
    [options, selected, query],
  );

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const add = (v: string) => {
    onChange([...selected, v]);
    setQuery('');
    inputRef.current?.focus();
  };

  const remove = (v: string) => onChange(selected.filter(s => s !== v));

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && !query && selected.length > 0) {
      remove(selected[selected.length - 1]);
    } else if (e.key === 'Escape') {
      setOpen(false);
      setQuery('');
    } else if (e.key === 'Enter' && filtered.length > 0) {
      add(filtered[0]);
    }
  };

  return (
    <div className={styles.multiWrap} ref={wrapRef}>
      <div
        className={`${styles.multiBox} ${open ? styles.multiBoxOpen : ''}`}
        onClick={() => { setOpen(true); inputRef.current?.focus(); }}
        {...{ 'data-testid': 'outcome-report-version-multiselect' }}
      >
        {selected.map(v => (
          <span key={v} className={styles.multiChip}>
            {v}
            <button
              type="button"
              className={styles.multiChipRemove}
              onClick={(e) => { e.stopPropagation(); remove(v); }}
              title={`Remove ${v}`}
              {...{ 'data-testid': `outcome-report-version-remove-${v}` }}
            >
              ×
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          className={styles.multiInput}
          value={query}
          placeholder={selected.length === 0 ? placeholder : ''}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          aria-label={placeholder}
          autoComplete="off"
          {...{ 'data-testid': 'outcome-report-version-search' }}
        />
      </div>

      {open && (
        <div className={styles.multiDropdown}>
          {loading && (
            <div className={styles.multiDropdownEmpty}>Loading versions…</div>
          )}
          {!loading && filtered.length === 0 && (
            <div className={styles.multiDropdownEmpty}>
              {options.length === 0 ? 'No outcomes recorded yet' : 'No matching versions'}
            </div>
          )}
          {!loading && filtered.map(v => (
            <button
              key={v}
              type="button"
              className={styles.multiOption}
              onMouseDown={(e) => { e.preventDefault(); add(v); }}
              {...{ 'data-testid': `outcome-report-version-option-${v}` }}
            >
              {v}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

/* ── Main Report Component ────────────────────────────────────────────────────── */

export const DeploymentOutcomeReport: React.FC<DeploymentOutcomeReportProps> = ({
  onClose,
  project: projectProp,
  areaPath: areaPathProp,
}) => {
  const [filters, setFilters] = useState<OutcomeFilters>({});
  const [draftFilters, setDraftFilters] = useState<OutcomeFilters>({});
  const [currentPage, setCurrentPage] = useState(0);
  const [sortCol, setSortCol] = useState<string>('reportedAt');
  const [sortAsc, setSortAsc] = useState(false);
  const [expandedOutcomeId, setExpandedOutcomeId] = useState<string | null>(null);

  const { selectedProject, selectedAreaPath } = useAppShell();
  const project = projectProp ?? selectedProject;
  const areaPath = areaPathProp ?? selectedAreaPath;

  const { data: summary, isLoading: summaryLoading, error } = useOutcomeReport(filters);
  const { data: outcomes, isLoading: outcomesLoading } = useFilteredOutcomes(filters);
  const { data: availableVersions = [], isLoading: versionsLoading } = useAvailableReleaseVersions();
  const { data: releaseEpics = [] } = useReleaseEpics(project, areaPath);
  const exportReport = useExportOutcomeReport();

  // Releases can be filtered even when nobody recorded an outcome for them.
  const versionOptions = useMemo(() => {
    const all = new Set([...availableVersions, ...releaseEpics.map((e) => e.version)]);
    return [...all].sort().reverse();
  }, [availableVersions, releaseEpics]);

  const isLoading = summaryLoading && outcomesLoading;

  const handleApply = useCallback(() => {
    setFilters({ ...draftFilters });
    setCurrentPage(0);
  }, [draftFilters]);

  const handleClear = useCallback(() => {
    const cleared: OutcomeFilters = {};
    setDraftFilters(cleared);
    setFilters(cleared);
    setCurrentPage(0);
  }, []);

  const handleExportCsv = useCallback(() => {
    exportReport({ ...filters, format: 'csv' });
  }, [exportReport, filters]);

  const handlePrint = useCallback(() => window.print(), []);

  const handleSort = useCallback((col: string) => {
    if (sortCol === col) setSortAsc(a => !a);
    else { setSortCol(col); setSortAsc(true); }
  }, [sortCol]);

  const rows = useMemo<OutcomeReportRow[]>(() => {
    const epicByVersion = new Map(releaseEpics.map((e) => [e.version, e]));

    const outcomeRows: OutcomeReportRow[] = (outcomes ?? []).map((outcome) => {
      const epic = epicByVersion.get(outcome.releaseVersion);
      return {
        key: outcome.id,
        releaseVersion: outcome.releaseVersion,
        epicId: epic?.id,
        outcome,
        deployedAt: outcome.deployedAt ?? epic?.targetDate,
        recordedAt: outcome.reportedAt,
      };
    });

    const covered = new Set(outcomeRows.map((r) => r.releaseVersion));
    const releaseOnlyRows: OutcomeReportRow[] = releaseEpics
      .filter((epic) => !covered.has(epic.version) && matchesFilters(epic, filters))
      .map((epic) => ({
        key: `release:${epic.id}`,
        releaseVersion: epic.version,
        epicId: epic.id,
        releaseStatus: epic.status,
        deployedAt: epic.targetDate,
      }));

    return [...outcomeRows, ...releaseOnlyRows];
  }, [outcomes, releaseEpics, filters]);

  const sortedRows = useMemo(() => {
    return [...rows].sort((a, b) => {
      const aVal = sortValue(a, sortCol);
      const bVal = sortValue(b, sortCol);
      if (aVal < bVal) return sortAsc ? -1 : 1;
      if (aVal > bVal) return sortAsc ? 1 : -1;
      return 0;
    });
  }, [rows, sortCol, sortAsc]);

  const paginatedRows = useMemo(() => {
    const start = currentPage * PAGE_SIZE;
    return sortedRows.slice(start, start + PAGE_SIZE);
  }, [sortedRows, currentPage]);

  const totalPages = Math.ceil(sortedRows.length / PAGE_SIZE);

  if (isLoading) {
    return (
      <div className={styles.page}>
        <div className={styles.loading}>Loading report data…</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.page}>
        <div className={styles.container}>
          <div className={styles.header}>
            <div className={styles.headerLeft}>
              <h1 className={styles.title}>Deployment Outcome Report</h1>
            </div>
          </div>
          <div className={styles.error}>Error loading report: {error.message}</div>
        </div>
      </div>
    );
  }

  const successRate =
    summary && summary.total > 0
      ? ((summary.success / summary.total) * 100).toFixed(1) + '%'
      : '0%';

  const maxMonthTotal = summary
    ? Math.max(...summary.byMonth.map((m) => m.success + m.downtime + m.rollback), 1)
    : 1;

  const sortIcon = (col: string) => {
    if (sortCol !== col) return ' ↕';
    return sortAsc ? ' ↑' : ' ↓';
  };

  return (
    <div className={styles.page}>
      <div className={styles.container}>
        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerLeft}>
            <h1 className={styles.title}>Deployment Outcome Report</h1>
          </div>
          <div className={styles.headerActions}>
            <button className={styles.btnExport} onClick={handleExportCsv} aria-label="Export CSV" {...{ 'data-testid': 'outcome-report-export-csv' }}>
              CSV
            </button>
            <button className={styles.btnExport} onClick={handlePrint} aria-label="Export PDF" {...{ 'data-testid': 'outcome-report-export-pdf' }}>
              PDF
            </button>
            <button className={styles.btnClose} onClick={onClose} aria-label="Back to Releases" {...{ 'data-testid': 'outcome-report-back' }}>
              Back to Releases
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className={styles.filters}>
          <div className={styles.filterGroup}>
            <label htmlFor="filter-start-date">Start Date</label>
            <DatePickerInput
              id="filter-start-date"
              testId="outcome-report-start-date"
              value={draftFilters.startDate}
              onChange={(d) => setDraftFilters(f => ({ ...f, startDate: d }))}
              placeholder="Pick start date"
              {...{ 'data-testid': 'outcome-report-start-date' }}
            />
          </div>

          <div className={styles.filterGroup}>
            <label htmlFor="filter-end-date">End Date</label>
            <DatePickerInput
              id="filter-end-date"
              testId="outcome-report-end-date"
              value={draftFilters.endDate}
              onChange={(d) => setDraftFilters(f => ({ ...f, endDate: d }))}
              placeholder="Pick end date"
              {...{ 'data-testid': 'outcome-report-end-date' }}
            />
          </div>

          <div className={`${styles.filterGroup} ${styles.filterGroupWide}`}>
            <label>Release Version</label>
            <MultiSelectTypeahead
              selected={draftFilters.releaseVersions ?? []}
              options={versionOptions}
              loading={versionsLoading}
              onChange={(vs) => setDraftFilters(f => ({ ...f, releaseVersions: vs.length ? vs : undefined }))}
              placeholder="Search releases…"
              {...{ 'data-testid': 'outcome-report-version-filter' }}
            />
          </div>

          <div className={styles.filterGroup}>
            <label htmlFor="filter-result">Result</label>
            <select
              id="filter-result"
              value={draftFilters.result ?? ''}
              onChange={(e) =>
                setDraftFilters((f) => ({
                  ...f,
                  result: (e.target.value as DeploymentResult) || undefined,
                }))
              }
              {...{ 'data-testid': 'outcome-report-result-filter' }}
            >
              <option value="">All</option>
              {RESULTS.map((r) => (
                <option key={r} value={r}>
                  {r.charAt(0).toUpperCase() + r.slice(1)}
                </option>
              ))}
            </select>
          </div>

          <div className={styles.filterActions}>
            <button className={styles.btnApply} onClick={handleApply} {...{ 'data-testid': 'outcome-report-apply' }}>
              Apply
            </button>
            <button className={styles.btnClear} onClick={handleClear} {...{ 'data-testid': 'outcome-report-clear' }}>
              Clear
            </button>
          </div>
        </div>

        {/* Active filter chips */}
        {(filters.releaseVersions?.length || filters.startDate || filters.endDate || filters.result) && (
          <div className={styles.activeFilters}>
            <span className={styles.activeFiltersLabel}>Filtered by:</span>
            {filters.releaseVersions?.map(v => (
              <span key={v} className={styles.activeChip}>
                {v}
                <button
                  className={styles.activeChipRemove}
                  onClick={() => {
                    const next = (filters.releaseVersions ?? []).filter(x => x !== v);
                    const updated = { ...filters, releaseVersions: next.length ? next : undefined };
                    setFilters(updated);
                    setDraftFilters(updated);
                  }}
                  {...{ 'data-testid': `outcome-report-chip-remove-version-${v}` }}
                >×</button>
              </span>
            ))}
            {filters.startDate && (
              <span className={styles.activeChip}>
                From {formatDate(filters.startDate)}
                <button className={styles.activeChipRemove} onClick={() => { const u = { ...filters, startDate: undefined }; setFilters(u); setDraftFilters(u); }} {...{ 'data-testid': 'outcome-report-chip-remove-start' }}>×</button>
              </span>
            )}
            {filters.endDate && (
              <span className={styles.activeChip}>
                To {formatDate(filters.endDate)}
                <button className={styles.activeChipRemove} onClick={() => { const u = { ...filters, endDate: undefined }; setFilters(u); setDraftFilters(u); }} {...{ 'data-testid': 'outcome-report-chip-remove-end' }}>×</button>
              </span>
            )}
            {filters.result && (
              <span className={styles.activeChip}>
                {filters.result.charAt(0).toUpperCase() + filters.result.slice(1)}
                <button className={styles.activeChipRemove} onClick={() => { const u = { ...filters, result: undefined }; setFilters(u); setDraftFilters(u); }} {...{ 'data-testid': 'outcome-report-chip-remove-result' }}>×</button>
              </span>
            )}
          </div>
        )}

        {/* Summary Cards */}
        {summary && (
          <div className={styles.summaryGrid}>
            <div className={styles.summaryCard}>
              <p className={styles.summaryLabel}>Total Deployments</p>
              <p className={styles.summaryValue}>{summary.total}</p>
            </div>
            <div className={styles.summaryCard}>
              <p className={styles.summaryLabel}>Success Rate</p>
              <p className={styles.summaryValueSuccess}>{successRate}</p>
            </div>
            <div className={styles.summaryCard}>
              <p className={styles.summaryLabel}>Rollbacks</p>
              <p className={styles.summaryValueRollback}>{summary.rollback}</p>
            </div>
            <div className={styles.summaryCard}>
              <p className={styles.summaryLabel}>Avg Downtime</p>
              <p className={styles.summaryValueDowntime}>
                {formatDowntime(summary.avgDowntimeMinutes)}
              </p>
            </div>
          </div>
        )}

        {/* Charts */}
        {summary && (
          <div className={styles.chartsRow}>
            <div className={styles.chartCard}>
              <h3 className={styles.chartTitle}>Outcome Distribution</h3>
              <PieChart
                success={summary.success}
                downtime={summary.downtime}
                rollback={summary.rollback}
              />
            </div>

            <div className={styles.chartCard}>
              <h3 className={styles.chartTitle}>Monthly Trend (by deploy date)</h3>
              <div className={styles.barChartContainer}>
                <div className={styles.barChartArea}>
                  {summary.byMonth.map((m) => (
                    <div key={m.month} className={styles.barGroup}>
                      <div
                        className={`${styles.bar} ${styles.barSuccess}`}
                        style={{ height: `${(m.success / maxMonthTotal) * 100}%` }}
                        title={`Success: ${m.success}`}
                      />
                      <div
                        className={`${styles.bar} ${styles.barDowntime}`}
                        style={{ height: `${(m.downtime / maxMonthTotal) * 100}%` }}
                        title={`Downtime: ${m.downtime}`}
                      />
                      <div
                        className={`${styles.bar} ${styles.barRollback}`}
                        style={{ height: `${(m.rollback / maxMonthTotal) * 100}%` }}
                        title={`Rollback: ${m.rollback}`}
                      />
                    </div>
                  ))}
                </div>
                <div className={styles.barLabels}>
                  {summary.byMonth.map((m) => (
                    <span key={m.month} className={styles.barLabel}>
                      {formatMonth(m.month)}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Data Table */}
        <div className={styles.tableSection}>
          <div className={styles.tableWrapper}>
            <table className={styles.dataTable}>
              <thead>
                <tr>
                  <th />
                  <th onClick={() => handleSort('releaseVersion')} {...{ 'data-testid': 'outcome-report-sort-releaseVersion' }}>Release Version{sortIcon('releaseVersion')}</th>
                  <th onClick={() => handleSort('result')} {...{ 'data-testid': 'outcome-report-sort-result' }}>Result{sortIcon('result')}</th>
                  <th onClick={() => handleSort('downtimeMinutes')} {...{ 'data-testid': 'outcome-report-sort-downtimeMinutes' }}>Downtime{sortIcon('downtimeMinutes')}</th>
                  <th onClick={() => handleSort('details')} {...{ 'data-testid': 'outcome-report-sort-details' }}>Details{sortIcon('details')}</th>
                  <th onClick={() => handleSort('reportedBy')} {...{ 'data-testid': 'outcome-report-sort-reportedBy' }}>Reported By{sortIcon('reportedBy')}</th>
                  <th onClick={() => handleSort('deployedAt')} {...{ 'data-testid': 'outcome-report-sort-deployedAt' }}>Deployed{sortIcon('deployedAt')}</th>
                  <th onClick={() => handleSort('reportedAt')} {...{ 'data-testid': 'outcome-report-sort-reportedAt' }}>Recorded{sortIcon('reportedAt')}</th>
                  <th>Cycle Time</th>
                </tr>
              </thead>
              <tbody>
                {paginatedRows.map((row) => (
                  <OutcomeReportTableRow
                    key={row.key}
                    row={row}
                    project={project}
                    areaPath={areaPath}
                    expanded={expandedOutcomeId === row.key}
                    onToggle={() =>
                      setExpandedOutcomeId((current) => (current === row.key ? null : row.key))
                    }
                    formatDowntime={formatDowntime}
                    formatDate={formatDate}
                    getBadgeClass={getBadgeClass}
                  />
                ))}
                {paginatedRows.length === 0 && (
                  <tr>
                    <td colSpan={9} style={{ textAlign: 'center', padding: '24px', color: 'var(--text-muted)' }}>
                      No releases match the current filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className={styles.pagination}>
              <button
                className={styles.paginationBtn}
                disabled={currentPage === 0}
                onClick={() => setCurrentPage((p) => p - 1)}
                {...{ 'data-testid': 'outcome-report-page-prev' }}
              >
                Previous
              </button>
              <span className={styles.paginationInfo}>
                Page {currentPage + 1} of {totalPages}
              </span>
              <button
                className={styles.paginationBtn}
                disabled={currentPage >= totalPages - 1}
                onClick={() => setCurrentPage((p) => p + 1)}
                {...{ 'data-testid': 'outcome-report-page-next' }}
              >
                Next
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

/* ── Pie Chart (SVG donut ring) ──────────────────────────────────────────────── */

interface PieChartProps { success: number; downtime: number; rollback: number; }

const PieChart: React.FC<PieChartProps> = ({ success, downtime, rollback }) => {
  const total = success + downtime + rollback;
  if (total === 0) {
    return <p style={{ color: 'var(--text-muted)', textAlign: 'center' }}>No data</p>;
  }

  const radius = 60;
  const circ = 2 * Math.PI * radius;
  const successDash = (success / total) * circ;
  const downtimeDash = (downtime / total) * circ;
  const rollbackDash = (rollback / total) * circ;

  return (
    <div className={styles.pieContainer}>
      <svg width="150" height="150" viewBox="0 0 150 150" className={styles.pieSvg}>
        <circle cx="75" cy="75" r={radius} fill="none" stroke="#22c55e" strokeWidth="24"
          strokeDasharray={`${successDash} ${circ - successDash}`} strokeDashoffset={0} />
        <circle cx="75" cy="75" r={radius} fill="none" stroke="#f59e0b" strokeWidth="24"
          strokeDasharray={`${downtimeDash} ${circ - downtimeDash}`} strokeDashoffset={-successDash} />
        <circle cx="75" cy="75" r={radius} fill="none" stroke="#ef4444" strokeWidth="24"
          strokeDasharray={`${rollbackDash} ${circ - rollbackDash}`} strokeDashoffset={-(successDash + downtimeDash)} />
      </svg>
      <div className={styles.legend}>
        <span className={styles.legendItem}>
          <span className={styles.legendDot} style={{ background: '#22c55e' }} />
          Success ({success})
        </span>
        <span className={styles.legendItem}>
          <span className={styles.legendDot} style={{ background: '#f59e0b' }} />
          Downtime ({downtime})
        </span>
        <span className={styles.legendItem}>
          <span className={styles.legendDot} style={{ background: '#ef4444' }} />
          Rollback ({rollback})
        </span>
      </div>
    </div>
  );
};

function getBadgeClass(result: string): string {
  switch (result) {
    case 'success': return styles.badgeSuccess;
    case 'downtime': return styles.badgeDowntime;
    case 'rollback': return styles.badgeRollback;
    default: return '';
  }
}
