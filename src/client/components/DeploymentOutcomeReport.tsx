import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import type { OutcomeFilters, DeploymentResult } from '../../shared/types/deploymentOutcome';
import {
  useOutcomeReport,
  useFilteredOutcomes,
  useExportOutcomeReport,
  useAvailableReleaseVersions,
} from '../hooks/useDeploymentOutcomes';
import styles from './DeploymentOutcomeReport.module.css';

interface DeploymentOutcomeReportProps {
  onClose: () => void;
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

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
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
}

const DatePickerInput: React.FC<DatePickerInputProps> = ({ value, onChange, placeholder, id }) => {
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
          >
            ×
          </span>
        )}
      </button>

      {open && (
        <div className={styles.calPopover}>
          <div className={styles.calHeader}>
            <button type="button" className={styles.calNavBtn} onClick={prevMonth} title="Previous month">‹</button>
            <span className={styles.calMonthLabel}>{MONTHS_SHORT[viewMonth]} {viewYear}</span>
            <button type="button" className={styles.calNavBtn} onClick={nextMonth} title="Next month">›</button>
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
      >
        {selected.map(v => (
          <span key={v} className={styles.multiChip}>
            {v}
            <button
              type="button"
              className={styles.multiChipRemove}
              onClick={(e) => { e.stopPropagation(); remove(v); }}
              title={`Remove ${v}`}
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

export const DeploymentOutcomeReport: React.FC<DeploymentOutcomeReportProps> = ({ onClose }) => {
  const [filters, setFilters] = useState<OutcomeFilters>({});
  const [draftFilters, setDraftFilters] = useState<OutcomeFilters>({});
  const [currentPage, setCurrentPage] = useState(0);
  const [sortCol, setSortCol] = useState<string>('reportedAt');
  const [sortAsc, setSortAsc] = useState(false);

  const { data: summary, isLoading: summaryLoading, error } = useOutcomeReport(filters);
  const { data: outcomes, isLoading: outcomesLoading } = useFilteredOutcomes(filters);
  const { data: availableVersions = [], isLoading: versionsLoading } = useAvailableReleaseVersions();
  const exportReport = useExportOutcomeReport();

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

  const sortedOutcomes = useMemo(() => {
    if (!outcomes) return [];
    return [...outcomes].sort((a, b) => {
      const aVal = (a as unknown as Record<string, unknown>)[sortCol] ?? '';
      const bVal = (b as unknown as Record<string, unknown>)[sortCol] ?? '';
      if (aVal < bVal) return sortAsc ? -1 : 1;
      if (aVal > bVal) return sortAsc ? 1 : -1;
      return 0;
    });
  }, [outcomes, sortCol, sortAsc]);

  const paginatedOutcomes = useMemo(() => {
    const start = currentPage * PAGE_SIZE;
    return sortedOutcomes.slice(start, start + PAGE_SIZE);
  }, [sortedOutcomes, currentPage]);

  const totalPages = Math.ceil(sortedOutcomes.length / PAGE_SIZE);

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
            <button className={styles.btnExport} onClick={handleExportCsv} aria-label="Export CSV">
              CSV
            </button>
            <button className={styles.btnExport} onClick={handlePrint} aria-label="Export PDF">
              PDF
            </button>
            <button className={styles.btnClose} onClick={onClose} aria-label="Back to Releases">
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
              value={draftFilters.startDate}
              onChange={(d) => setDraftFilters(f => ({ ...f, startDate: d }))}
              placeholder="Pick start date"
            />
          </div>

          <div className={styles.filterGroup}>
            <label htmlFor="filter-end-date">End Date</label>
            <DatePickerInput
              id="filter-end-date"
              value={draftFilters.endDate}
              onChange={(d) => setDraftFilters(f => ({ ...f, endDate: d }))}
              placeholder="Pick end date"
            />
          </div>

          <div className={`${styles.filterGroup} ${styles.filterGroupWide}`}>
            <label>Release Version</label>
            <MultiSelectTypeahead
              selected={draftFilters.releaseVersions ?? []}
              options={availableVersions}
              loading={versionsLoading}
              onChange={(vs) => setDraftFilters(f => ({ ...f, releaseVersions: vs.length ? vs : undefined }))}
              placeholder="Search releases…"
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
            <button className={styles.btnApply} onClick={handleApply}>
              Apply
            </button>
            <button className={styles.btnClear} onClick={handleClear}>
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
                >×</button>
              </span>
            ))}
            {filters.startDate && (
              <span className={styles.activeChip}>
                From {formatDate(filters.startDate)}
                <button className={styles.activeChipRemove} onClick={() => { const u = { ...filters, startDate: undefined }; setFilters(u); setDraftFilters(u); }}>×</button>
              </span>
            )}
            {filters.endDate && (
              <span className={styles.activeChip}>
                To {formatDate(filters.endDate)}
                <button className={styles.activeChipRemove} onClick={() => { const u = { ...filters, endDate: undefined }; setFilters(u); setDraftFilters(u); }}>×</button>
              </span>
            )}
            {filters.result && (
              <span className={styles.activeChip}>
                {filters.result.charAt(0).toUpperCase() + filters.result.slice(1)}
                <button className={styles.activeChipRemove} onClick={() => { const u = { ...filters, result: undefined }; setFilters(u); setDraftFilters(u); }}>×</button>
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
                  <th onClick={() => handleSort('releaseVersion')}>Release Version{sortIcon('releaseVersion')}</th>
                  <th onClick={() => handleSort('result')}>Result{sortIcon('result')}</th>
                  <th onClick={() => handleSort('downtimeMinutes')}>Downtime{sortIcon('downtimeMinutes')}</th>
                  <th onClick={() => handleSort('details')}>Details{sortIcon('details')}</th>
                  <th onClick={() => handleSort('reportedBy')}>Reported By{sortIcon('reportedBy')}</th>
                  <th onClick={() => handleSort('deployedAt')}>Deployed{sortIcon('deployedAt')}</th>
                  <th onClick={() => handleSort('reportedAt')}>Recorded{sortIcon('reportedAt')}</th>
                </tr>
              </thead>
              <tbody>
                {paginatedOutcomes.map((o) => (
                  <tr key={o.id}>
                    <td>{o.releaseVersion}</td>
                    <td>
                      <span className={`${styles.resultBadge} ${getBadgeClass(o.result)}`}>
                        {o.result}
                      </span>
                    </td>
                    <td>{o.downtimeMinutes != null ? formatDowntime(o.downtimeMinutes) : '—'}</td>
                    <td className={styles.detailsCell} title={o.details ?? ''}>
                      {o.details ?? '—'}
                    </td>
                    <td>{o.reportedBy}</td>
                    <td>{o.deployedAt ? formatDate(o.deployedAt) : '—'}</td>
                    <td>{formatDate(o.reportedAt)}</td>
                  </tr>
                ))}
                {paginatedOutcomes.length === 0 && (
                  <tr>
                    <td colSpan={7} style={{ textAlign: 'center', padding: '24px', color: 'var(--text-muted)' }}>
                      No outcomes match the current filters.
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
