import React, { useState, useMemo, useEffect } from 'react';
import { WorkItem, AIWorkItemHealthSummary } from '../types/workitem';
import { WorkItemHealthSection } from './WorkItemHealthSection';
import './AIAnalysis.css';
import './DevStats.css';

interface AIAnalysisProps {
  workItems: WorkItem[];
  project: string;
  areaPath: string;
  onSelectItem?: (item: WorkItem) => void;
}

const SESSION_INIT_KEY = 'aiAnalysisSessionInitialized';
const DATA_KEY = 'aiAnalysisHealthData';
const LOADING_KEY = 'aiAnalysisLoadingState';
const FILTER_KEY = 'aiAnalysisFilters';

function checkAndClearOnRefresh(): boolean {
  const initialized = sessionStorage.getItem(SESSION_INIT_KEY);
  if (!initialized) {
    sessionStorage.removeItem(DATA_KEY);
    sessionStorage.removeItem(LOADING_KEY);
    sessionStorage.removeItem(FILTER_KEY);
    sessionStorage.setItem(SESSION_INIT_KEY, 'true');
    return true;
  }
  return false;
}

function buildDateRange(timeFrame: string, customFrom: string, customTo: string) {
  const toDate = new Date().toISOString().split('T')[0];
  if (timeFrame === 'custom') {
    return { from: customFrom, to: customTo };
  }
  const from = new Date();
  from.setDate(from.getDate() - parseInt(timeFrame, 10));
  return { from: from.toISOString().split('T')[0], to: toDate };
}

export const AIAnalysis: React.FC<AIAnalysisProps> = ({
  project,
  areaPath,
  onSelectItem,
  workItems,
}) => {
  const [isPageRefresh] = useState(() => checkAndClearOnRefresh());
  const [showHealthInfo, setShowHealthInfo] = useState(false);

  // ── Filter state ─────────────────────────────────────────────────────────────
  const [timeFrame, setTimeFrame] = useState<string>(() => {
    if (isPageRefresh) return '30';
    const saved = sessionStorage.getItem(FILTER_KEY);
    return saved ? JSON.parse(saved).timeFrame ?? '30' : '30';
  });
  const [customFrom, setCustomFrom] = useState<string>(() => {
    if (isPageRefresh) return '';
    const saved = sessionStorage.getItem(FILTER_KEY);
    return saved ? JSON.parse(saved).customFrom ?? '' : '';
  });
  const [customTo, setCustomTo] = useState<string>(() => {
    if (isPageRefresh) return '';
    const saved = sessionStorage.getItem(FILTER_KEY);
    return saved ? JSON.parse(saved).customTo ?? '' : '';
  });

  // ── Section 1: Work Item Health ───────────────────────────────────────────────
  const [healthSummary, setHealthSummary] = useState<AIWorkItemHealthSummary | null>(() => {
    if (isPageRefresh) return null;
    const saved = sessionStorage.getItem(DATA_KEY);
    return saved ? JSON.parse(saved).summary : null;
  });
  const [loading, setLoading] = useState(() => {
    if (isPageRefresh) return false;
    const saved = sessionStorage.getItem(LOADING_KEY);
    return saved ? JSON.parse(saved).loading : false;
  });
  const [hasLoaded, setHasLoaded] = useState(() => {
    if (isPageRefresh) return false;
    const saved = sessionStorage.getItem(DATA_KEY);
    return saved ? JSON.parse(saved).hasLoaded : false;
  });
  const [error, setError] = useState<string | null>(null);

  // ── Date range computed value ─────────────────────────────────────────────────
  const dateRange = useMemo(
    () => buildDateRange(timeFrame, customFrom, customTo),
    [timeFrame, customFrom, customTo]
  );

  // ── Persist filters ───────────────────────────────────────────────────────────
  useEffect(() => {
    sessionStorage.setItem(FILTER_KEY, JSON.stringify({ timeFrame, customFrom, customTo }));
  }, [timeFrame, customFrom, customTo]);

  // ── Persist health data ───────────────────────────────────────────────────────
  useEffect(() => {
    sessionStorage.setItem(DATA_KEY, JSON.stringify({ summary: healthSummary, hasLoaded }));
  }, [healthSummary, hasLoaded]);

  // ── Fetch handler ─────────────────────────────────────────────────────────────
  const handleLoad = async () => {
    if (!dateRange.from || !dateRange.to) return;

    setLoading(true);
    setError(null);
    sessionStorage.setItem(LOADING_KEY, JSON.stringify({ loading: true }));

    try {
      const params = new URLSearchParams({
        from: dateRange.from,
        to: dateRange.to,
        project,
        areaPath,
      });

      const response = await fetch(`/api/ai-work-item-health?${params.toString()}`, {
        credentials: 'include',
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${response.status}`);
      }

      const data: AIWorkItemHealthSummary = await response.json();
      setHealthSummary(data);
      setHasLoaded(true);
    } catch (err: any) {
      setError(err.message ?? 'Failed to fetch AI analysis data');
    } finally {
      setLoading(false);
      sessionStorage.setItem(LOADING_KEY, JSON.stringify({ loading: false }));
    }
  };

  // ── Resolve a work item for the details panel ─────────────────────────────────
  const handleSelectWorkItemById = (id: number) => {
    const match = workItems.find((wi) => wi.id === id);
    if (match && onSelectItem) onSelectItem(match);
  };

  const canLoad = timeFrame !== 'custom' || (customFrom !== '' && customTo !== '');

  return (
    <div className="ai-analysis-container">
      <h2>AI Analysis</h2>

      {/* ── Shared filters (Sections 1 & 2) ──────────────────────────────────── */}
      <div className="ai-analysis-filters">
        <div className="ai-analysis-filter-row">
          <div className="ai-analysis-filter-group">
            <label htmlFor="ai-timeframe">Time Frame</label>
            <select
              id="ai-timeframe"
              className="ai-analysis-select"
              value={timeFrame}
              onChange={(e) => setTimeFrame(e.target.value)}
            >
              <option value="7">Last 7 Days</option>
              <option value="14">Last 14 Days</option>
              <option value="30">Last 30 Days</option>
              <option value="60">Last 60 Days</option>
              <option value="90">Last 90 Days</option>
              <option value="180">Last 6 Months</option>
              <option value="custom">Custom Range</option>
            </select>
          </div>

          {timeFrame === 'custom' && (
            <>
              <div className="ai-analysis-filter-group">
                <label htmlFor="ai-from-date">From</label>
                <input
                  id="ai-from-date"
                  type="date"
                  className="ai-analysis-date-input"
                  value={customFrom}
                  onChange={(e) => setCustomFrom(e.target.value)}
                />
              </div>
              <div className="ai-analysis-filter-group">
                <label htmlFor="ai-to-date">To</label>
                <input
                  id="ai-to-date"
                  type="date"
                  className="ai-analysis-date-input"
                  value={customTo}
                  onChange={(e) => setCustomTo(e.target.value)}
                />
              </div>
            </>
          )}

          <button
            className="ai-analysis-load-btn"
            onClick={handleLoad}
            disabled={loading || !canLoad}
          >
            {loading ? 'Loading…' : 'Load Data'}
          </button>
        </div>
      </div>

      {/* ── Loading / error notification ──────────────────────────────────────── */}
      {loading && (
        <div className="ai-analysis-notification loading">
          <div className="ai-notification-spinner" />
          <span className="ai-notification-text">
            Fetching ai-code work items — this may take a moment…
          </span>
        </div>
      )}
      {error && (
        <div className="ai-analysis-notification error">
          <span className="ai-notification-text">Error: {error}</span>
        </div>
      )}

      {/* ── Section 1: Work Item Health ──────────────────────────────────────── */}
      <div className="ai-analysis-section">
        <div className="ai-analysis-section-header">
          <h3>
            Work Item Health
            <div
              className="info-icon"
              onClick={() => setShowHealthInfo(!showHealthInfo)}
              role="button"
              aria-label="Show information about this section"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
                <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
                <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533L8.93 6.588zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z"/>
              </svg>
            </div>
          </h3>
          <span className="ai-section-badge active">Active</span>
        </div>

        {showHealthInfo && (
          <div className="info-tooltip">
            <button
              className="info-close"
              onClick={() => setShowHealthInfo(false)}
              aria-label="Close information"
            >
              ×
            </button>
            <p>
              <strong>What this section shows:</strong><br />
              Health of work items tagged <strong>ai-code</strong> within the selected time frame.
            </p>
            <p>
              <strong>Metrics tracked:</strong><br />
              • <strong>Dev Time:</strong> Average days from In Progress → In Pull Request<br />
              • <strong>Bugs to UAT:</strong> Average linked bugs before UAT Ready for Test<br />
              • <strong>PR Modifications:</strong> Average re-submission rounds after initial PR<br />
              • <strong>Full Cycle Time:</strong> Average days from In Progress → UAT Ready for Test<br />
              • <strong>Rework Rate:</strong> Percentage of items with backward state regressions<br />
              • <strong>First-Pass Success:</strong> Items reaching UAT with zero bugs and no regressions
            </p>
            <p>
              <strong>Aggregate Score:</strong><br />
              A weighted composite of the six dimensions above (Dev Time 20%, Bug Count 25%,
              PR Mods 15%, Cycle Time 15%, Rework 10%, First-Pass 15%).
            </p>
          </div>
        )}

        {!hasLoaded && !loading ? (
          <div className="ai-placeholder-card">
            <span className="ai-placeholder-icon">📊</span>
            <p>
              Select a time frame and click <strong>Load Data</strong> to analyze{' '}
              <strong>ai-code</strong> tagged work items.
            </p>
          </div>
        ) : loading && !healthSummary ? (
          <div className="ai-placeholder-card">
            <span className="ai-placeholder-icon">⏳</span>
            <p>Fetching revision history and bug data for ai-code items…</p>
          </div>
        ) : healthSummary ? (
          <WorkItemHealthSection
            summary={healthSummary}
            onSelectItem={handleSelectWorkItemById}
          />
        ) : null}
      </div>

      {/* ── Section 2: AI Health (coming soon) ───────────────────────────────── */}
      <div className="ai-analysis-section">
        <div className="ai-analysis-section-header">
          <h3>AI Health</h3>
          <span className="ai-section-badge coming-soon">Coming Soon</span>
        </div>
        <div className="ai-placeholder-card">
          <span className="ai-placeholder-icon">🤖</span>
          <p>
            <strong>AI Health</strong> will capture the efficiency and quality of AI workers
            within the orchestration pipeline — cycle throughput, token efficiency, task
            completion rates, and model performance over time.
          </p>
        </div>
      </div>

      {/* ── Section 3: Manual vs AI Agentic (coming soon) ────────────────────── */}
      <div className="ai-analysis-section">
        <div className="ai-analysis-section-header">
          <h3>Manual vs AI Agentic</h3>
          <span className="ai-section-badge coming-soon">Coming Soon</span>
        </div>
        <div className="ai-placeholder-card">
          <span className="ai-placeholder-icon">⚖️</span>
          <p>
            <strong>Manual vs AI Agentic</strong> will compare quality and efficiency of
            work completed by human developers versus AI agents — including cycle time,
            defect rates, rework frequency, and delivery predictability. This section will
            have its own independent time frame selector.
          </p>
        </div>
      </div>
    </div>
  );
};
