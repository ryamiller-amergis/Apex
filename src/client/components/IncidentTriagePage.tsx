import React, { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  INCIDENT_TRIAGE_PERMISSIONS,
  INCIDENT_TRIAGE_VERDICTS,
  type IncidentTriageIncident,
  type IncidentTriageVerdict,
} from '../../shared/types/incidentTriage';
import { INCIDENT_TRIAGE_FLAG } from '../../shared/types/featureFlags';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import { useFeatureFlag } from '../hooks/useFeatureFlags';
import { useIncidentTriageIncidents, useRunIncidentTriageSweep } from '../hooks/useIncidentTriage';
import type { IncidentTriageFilters } from '../services/incidentTriageApi';
import {
  INCIDENT_ANALYSIS_STATUS_LABELS,
  INCIDENT_SEVERITY_LABELS,
  INCIDENT_TEAMS_STATUS_LABELS,
  INCIDENT_VERDICT_LABELS,
  formatIncidentTime,
  incidentSeverityTone,
  incidentText,
  incidentVerdictTone,
} from '../utils/incidentTriageDisplay';
import { DataGridFilterSelect, DataGridToolbar, type DataGridFilterOption } from './DataGridToolbar';
import { IncidentTriageBadge } from './IncidentTriageBadge';
import { IncidentTriageDetail } from './IncidentTriageDetail';
import { IncidentTriageSettings } from './IncidentTriageSettings';
import gridStyles from './DataGrid.module.css';
import styles from './IncidentTriagePage.module.css';

type VerdictFilter = '' | IncidentTriageVerdict;

const INCIDENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VERDICT_FILTER_OPTIONS: readonly DataGridFilterOption<VerdictFilter>[] = INCIDENT_TRIAGE_VERDICTS.map(
  (verdict) => ({ label: INCIDENT_VERDICT_LABELS[verdict], value: verdict }),
);

const STATE_FILTER_OPTIONS: readonly DataGridFilterOption[] = [
  'New',
  'In Progress',
  'On Hold',
  'Resolved',
  'Closed',
  'Canceled',
].map((state) => ({ label: state, value: state }));

function verdictCell(incident: IncidentTriageIncident): React.ReactNode {
  const analysis = incident.latestAnalysis;
  const testId = `incident-triage-verdict-${incident.id}`;
  if (!analysis) return <span className={styles.muted}>Not analyzed</span>;
  if (!analysis.verdict) {
    return <IncidentTriageBadge label={INCIDENT_ANALYSIS_STATUS_LABELS[analysis.status]} data-testid={testId} />;
  }
  return (
    <IncidentTriageBadge
      label={INCIDENT_VERDICT_LABELS[analysis.verdict]}
      tone={incidentVerdictTone(analysis.verdict)}
      data-testid={testId}
    />
  );
}

function severityCell(incident: IncidentTriageIncident): React.ReactNode {
  const severity = incident.latestAnalysis?.severity;
  if (!severity) return <span className={styles.muted}>—</span>;
  return (
    <IncidentTriageBadge
      label={INCIDENT_SEVERITY_LABELS[severity]}
      tone={incidentSeverityTone(severity)}
      data-testid={`incident-triage-severity-${incident.id}`}
    />
  );
}

interface IncidentTriageContentProps {
  project: string;
  canRun: boolean;
  canManage: boolean;
}

const IncidentTriageContent: React.FC<IncidentTriageContentProps> = ({ project, canRun, canManage }) => {
  const [verdict, setVerdict] = useState<VerdictFilter>('');
  const [state, setState] = useState('');
  const [search, setSearch] = useState('');
  const [searchParams] = useSearchParams();
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    const linked = searchParams.get('incident');
    return linked && INCIDENT_ID_PATTERN.test(linked) ? linked : null;
  });
  const query = useDebouncedValue(search.trim());
  const filters = useMemo<IncidentTriageFilters>(
    () => ({ verdict: verdict || undefined, state: state || undefined, q: query || undefined }),
    [verdict, state, query],
  );
  const incidentsQuery = useIncidentTriageIncidents(project, filters);
  const sweep = useRunIncidentTriageSweep();

  const incidents = incidentsQuery.data?.incidents ?? [];
  const filtered = Boolean(verdict || state || query);
  const sweepResult = sweep.data;

  return (
    <main className={styles.page} {...{ 'data-testid': 'incident-triage-page' }}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.heading}>Incident Triage</h1>
          <p className={styles.intro}>
            ServiceNow incidents assigned to this project, with the latest analysis for each.
          </p>
        </div>
        {canRun ? (
          <div className={styles.actions}>
            <button
              type="button"
              className={gridStyles.buttonPrimary}
              disabled={sweep.isPending}
              onClick={() => sweep.mutate(project)}
              {...{ 'data-testid': 'incident-triage-sweep-btn' }}
            >
              {sweep.isPending ? 'Checking ServiceNow…' : 'Check ServiceNow now'}
            </button>
          </div>
        ) : null}
      </header>
      {sweepResult ? (
        <p className={styles.sweepResult} role="status" {...{ 'data-testid': 'incident-triage-sweep-result' }}>
          {sweepResult.fetched} fetched, {sweepResult.upserted} saved, {sweepResult.newAnalyses} new{' '}
          {sweepResult.newAnalyses === 1 ? 'analysis' : 'analyses'}.
        </p>
      ) : null}
      {sweep.isError ? (
        <p className={styles.sweepError} role="alert" {...{ 'data-testid': 'incident-triage-sweep-error' }}>
          {sweep.error.message}
        </p>
      ) : null}
      <section className={gridStyles.section} aria-labelledby="incident-triage-list-heading">
        <div className={gridStyles.header}>
          <div>
            <h2 id="incident-triage-list-heading" className={gridStyles.title}>Incidents</h2>
            <p className={gridStyles.hint}>Filter by verdict or state, or search by number or description.</p>
          </div>
        </div>
        <DataGridToolbar
          searchValue={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search incidents"
          searchTestId="incident-triage-search"
        >
          <DataGridFilterSelect
            label="Verdict"
            value={verdict}
            onChange={setVerdict}
            options={VERDICT_FILTER_OPTIONS}
            includeEmptyOption
            emptyOptionLabel="All verdicts"
            data-testid="incident-triage-verdict-filter"
          />
          <DataGridFilterSelect
            label="State"
            value={state}
            onChange={setState}
            options={STATE_FILTER_OPTIONS}
            includeEmptyOption
            emptyOptionLabel="All states"
            data-testid="incident-triage-state-filter"
          />
        </DataGridToolbar>
        {incidentsQuery.isLoading ? <p className={gridStyles.loading}>Loading incidents…</p> : null}
        {incidentsQuery.isError ? (
          <p className={gridStyles.error} role="alert" {...{ 'data-testid': 'incident-triage-error' }}>
            {incidentsQuery.error.message}
          </p>
        ) : null}
        {incidentsQuery.isSuccess && incidents.length === 0 ? (
          <p className={gridStyles.empty} {...{ 'data-testid': 'incident-triage-empty' }}>
            {filtered ? 'No incidents match these filters.' : 'No incidents yet. They appear after the next check of ServiceNow.'}
          </p>
        ) : null}
        {incidents.length > 0 ? (
          <div className={`${gridStyles.tableWrap} ${styles.tableScroll}`}>
            <table className={`${gridStyles.table} ${styles.table}`} {...{ 'data-testid': 'incident-triage-table' }}>
              <thead>
                <tr>
                  <th>Number</th>
                  <th>Opened</th>
                  <th>State</th>
                  <th>Priority</th>
                  <th>Assignment group</th>
                  <th>Verdict</th>
                  <th>Severity</th>
                  <th>Analyzed</th>
                  <th>Teams</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {incidents.map((incident) => {
                  const analysis = incident.latestAnalysis;
                  return (
                    <tr key={incident.id} {...{ 'data-testid': `incident-triage-row-${incident.id}` }}>
                      <td className={styles.numberCell}>
                        {incident.number}
                        {incident.shortDescription ? (
                          <span className={styles.titleLine} title={incident.shortDescription}>
                            {incident.shortDescription}
                          </span>
                        ) : null}
                      </td>
                      <td className={styles.dateCell}>{formatIncidentTime(incident.openedAt)}</td>
                      <td>{incidentText(incident.state)}</td>
                      <td>{incidentText(incident.priority)}</td>
                      <td>{incidentText(incident.assignmentGroupName)}</td>
                      <td>{verdictCell(incident)}</td>
                      <td>{severityCell(incident)}</td>
                      <td className={styles.dateCell}>{formatIncidentTime(analysis?.completedAt)}</td>
                      <td>{analysis ? INCIDENT_TEAMS_STATUS_LABELS[analysis.teamsStatus] : '—'}</td>
                      <td>
                        <div className={gridStyles.rowActions}>
                          <button
                            type="button"
                            className={gridStyles.buttonGhost}
                            onClick={() => setSelectedId(incident.id)}
                            {...{ 'data-testid': `incident-triage-view-${incident.id}` }}
                          >
                            View
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
      {canManage ? <IncidentTriageSettings project={project} /> : null}
      {selectedId ? (
        <IncidentTriageDetail
          project={project}
          incidentId={selectedId}
          canRun={canRun}
          onClose={() => setSelectedId(null)}
        />
      ) : null}
    </main>
  );
};

interface IncidentTriagePageProps {
  project: string;
  can: (key: string) => boolean;
  isSuperAdmin?: boolean;
}

export const IncidentTriagePage: React.FC<IncidentTriagePageProps> = ({ project, can, isSuperAdmin = false }) => {
  const enabled = useFeatureFlag(INCIDENT_TRIAGE_FLAG, project);

  // @feature-flag:servicenow-incident-triage start winner=enabled
  if (!enabled) {
    // @feature-flag:servicenow-incident-triage disabled-start
    return null;
    // @feature-flag:servicenow-incident-triage disabled-end
  }

  // @feature-flag:servicenow-incident-triage enabled-start
  return (
    <IncidentTriageContent
      project={project}
      canRun={isSuperAdmin || can(INCIDENT_TRIAGE_PERMISSIONS.run)}
      canManage={isSuperAdmin || can(INCIDENT_TRIAGE_PERMISSIONS.manage)}
    />
  );
  // @feature-flag:servicenow-incident-triage enabled-end
  // @feature-flag:servicenow-incident-triage end
};
