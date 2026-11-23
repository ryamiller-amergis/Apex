import React from 'react';
import type {
  IncidentTriageAnalysis,
  IncidentTriageIncident,
  IncidentTriageResult,
} from '../../shared/types/incidentTriage';
import { useDialogFocus } from '../hooks/useDialogFocus';
import {
  isAnalysisInFlight,
  useAnalyzeIncident,
  useIncidentTriageIncident,
} from '../hooks/useIncidentTriage';
import { IncidentTriageApiError } from '../services/incidentTriageApi';
import {
  INCIDENT_ANALYSIS_STATUS_LABELS,
  INCIDENT_CONFIDENCE_LABELS,
  INCIDENT_SEVERITY_LABELS,
  INCIDENT_VERDICT_LABELS,
  formatIncidentTime,
  incidentSeverityTone,
  incidentText,
  incidentVerdictTone,
} from '../utils/incidentTriageDisplay';
import { IncidentTriageBadge } from './IncidentTriageBadge';
import styles from './IncidentTriagePage.module.css';

const ALREADY_RUNNING_MESSAGE = 'Analysis already running';

interface IncidentTriageDetailProps {
  project: string;
  incidentId: string;
  canRun: boolean;
  onClose: () => void;
}

const EvidenceList: React.FC<{ title: string; items: string[]; testId: string }> = ({ title, items, testId }) => (
  <div className={styles.evidence} {...{ 'data-testid': testId }}>
    <h4 className={styles.evidenceTitle}>{title}</h4>
    {items.length > 0 ? (
      <ul className={styles.evidenceList}>
        {items.map((item, index) => (
          <li key={`${index}-${item}`} className={styles.detailText}>{item}</li>
        ))}
      </ul>
    ) : (
      <p className={styles.muted}>None reported</p>
    )}
  </div>
);

const CompletedAnalysis: React.FC<{ analysis: IncidentTriageAnalysis; result: IncidentTriageResult | null }> = ({
  analysis,
  result,
}) => {
  const area = analysis.area ?? result?.area ?? null;
  return (
    <>
      <div className={styles.badgeRow}>
        {analysis.verdict ? (
          <IncidentTriageBadge
            label={INCIDENT_VERDICT_LABELS[analysis.verdict]}
            tone={incidentVerdictTone(analysis.verdict)}
            data-testid="incident-triage-detail-verdict"
          />
        ) : null}
        {analysis.severity ? (
          <IncidentTriageBadge
            label={INCIDENT_SEVERITY_LABELS[analysis.severity]}
            tone={incidentSeverityTone(analysis.severity)}
            data-testid="incident-triage-detail-severity"
          />
        ) : null}
        {result ? (
          <IncidentTriageBadge
            label={INCIDENT_CONFIDENCE_LABELS[result.confidence]}
            data-testid="incident-triage-detail-confidence"
          />
        ) : null}
        {area ? <IncidentTriageBadge label={area} data-testid="incident-triage-detail-area" /> : null}
      </div>
      {result ? (
        <>
          <p className={styles.detailText}>{result.summary}</p>
          <EvidenceList
            title="Code evidence"
            items={result.verification.codeEvidence}
            testId="incident-triage-detail-code-evidence"
          />
          <EvidenceList
            title="Telemetry evidence"
            items={result.verification.telemetryEvidence}
            testId="incident-triage-detail-telemetry-evidence"
          />
          {analysis.verdict === 'bug' && result.suggestedFix ? (
            <div className={styles.evidence} {...{ 'data-testid': 'incident-triage-detail-suggested-fix' }}>
              <h4 className={styles.evidenceTitle}>Suggested fix</h4>
              <p className={styles.detailText}>{result.suggestedFix}</p>
            </div>
          ) : null}
          <div className={styles.evidence} {...{ 'data-testid': 'incident-triage-detail-next-action' }}>
            <h4 className={styles.evidenceTitle}>Next action</h4>
            <p className={styles.detailText}>{result.nextAction}</p>
          </div>
        </>
      ) : (
        <p className={styles.muted}>No analysis details were stored.</p>
      )}
      <p className={styles.detailMeta} {...{ 'data-testid': 'incident-triage-detail-model' }}>
        Model {incidentText(analysis.model)} · Analyzed {formatIncidentTime(analysis.completedAt)}
      </p>
    </>
  );
};

const AnalysisPanel: React.FC<{ analysis: IncidentTriageAnalysis | null; 'data-testid': string }> = ({
  analysis,
  'data-testid': dataTestId,
}) => {
  if (!analysis) {
    return (
      <p className={styles.muted} {...{ 'data-testid': 'incident-triage-detail-not-analyzed' }}>
        Not analyzed yet
      </p>
    );
  }
  return (
    <div className={styles.analysis} {...{ 'data-testid': dataTestId }}>
      {isAnalysisInFlight(analysis) ? (
        <p className={styles.runningRow} role="status" {...{ 'data-testid': 'incident-triage-detail-running' }}>
          <span className={styles.spinner} aria-hidden="true" />
          {INCIDENT_ANALYSIS_STATUS_LABELS[analysis.status]}…
        </p>
      ) : null}
      {analysis.status === 'failed' ? (
        <div className={styles.drawerError} role="alert" {...{ 'data-testid': 'incident-triage-detail-failure' }}>
          <strong>Analysis failed</strong>
          {analysis.failureDetail ? <p className={styles.detailText}>{analysis.failureDetail}</p> : null}
        </div>
      ) : null}
      {analysis.status === 'completed' ? <CompletedAnalysis analysis={analysis} result={analysis.result} /> : null}
    </div>
  );
};

const AnalysisHistory: React.FC<{ analyses: IncidentTriageAnalysis[] }> = ({ analyses }) => {
  if (analyses.length === 0) return null;
  return (
    <section
      className={styles.drawerSection}
      aria-labelledby="incident-triage-detail-history-heading"
      {...{ 'data-testid': 'incident-triage-detail-history' }}
    >
      <h3 id="incident-triage-detail-history-heading" className={styles.drawerSectionTitle}>Earlier analyses</h3>
      <ul className={styles.historyList}>
        {analyses.map((analysis) => (
          <li key={analysis.runId} className={styles.detailMeta}>
            {formatIncidentTime(analysis.completedAt ?? analysis.requestedAt)}
            {' · '}
            {analysis.verdict ? INCIDENT_VERDICT_LABELS[analysis.verdict] : INCIDENT_ANALYSIS_STATUS_LABELS[analysis.status]}
            {analysis.severity ? ` · ${INCIDENT_SEVERITY_LABELS[analysis.severity]}` : ''}
            {analysis.model ? ` · ${analysis.model}` : ''}
          </li>
        ))}
      </ul>
    </section>
  );
};

const IncidentFacts: React.FC<{ incident: IncidentTriageIncident }> = ({ incident }) => (
  <dl className={styles.facts}>
    <dt>State</dt>
    <dd>{incidentText(incident.state)}</dd>
    <dt>Priority</dt>
    <dd>{incidentText(incident.priority)}</dd>
    <dt>Assignment group</dt>
    <dd>{incidentText(incident.assignmentGroupName)}</dd>
    <dt>Opened</dt>
    <dd>{formatIncidentTime(incident.openedAt)}</dd>
    <dt>Resolved</dt>
    <dd>{formatIncidentTime(incident.resolvedAt)}</dd>
  </dl>
);

function reanalyzeMessage(error: Error | null, started: boolean): string | null {
  if (error) {
    return error instanceof IncidentTriageApiError && error.status === 409 ? ALREADY_RUNNING_MESSAGE : error.message;
  }
  return started ? 'Analysis queued.' : null;
}

export const IncidentTriageDetail: React.FC<IncidentTriageDetailProps> = ({
  project,
  incidentId,
  canRun,
  onClose,
}) => {
  const drawerRef = useDialogFocus<HTMLElement>(true, onClose);
  const detailQuery = useIncidentTriageIncident(project, incidentId);
  const analyze = useAnalyzeIncident();
  const incident = detailQuery.data?.incident;
  const latest = incident?.latestAnalysis ?? null;
  const earlier = (detailQuery.data?.analyses ?? []).filter((analysis) => analysis.runId !== latest?.runId);
  const message = reanalyzeMessage(analyze.error, analyze.isSuccess && isAnalysisInFlight(latest));

  return (
    <div className={styles.backdrop}>
      <button
        type="button"
        className={styles.backdropButton}
        aria-label="Close incident details"
        tabIndex={-1}
        onClick={onClose}
        {...{ 'data-testid': 'incident-triage-detail-backdrop' }}
      />
      <aside
        ref={drawerRef}
        className={styles.drawer}
        role="dialog"
        aria-modal="false"
        aria-labelledby="incident-triage-detail-title"
        {...{ 'data-testid': 'incident-triage-detail' }}
      >
        <div className={styles.drawerHeader}>
          <div>
            <h2 id="incident-triage-detail-title" className={styles.drawerTitle}>
              {incident?.number ?? 'Incident'}
            </h2>
            {incident?.shortDescription ? <p className={styles.detailMeta}>{incident.shortDescription}</p> : null}
          </div>
          <button
            type="button"
            className={styles.drawerButton}
            onClick={onClose}
            {...{ 'data-testid': 'incident-triage-detail-close' }}
          >
            Close
          </button>
        </div>
        {detailQuery.isLoading ? <p className={styles.muted}>Loading incident…</p> : null}
        {detailQuery.isError ? (
          <div className={styles.drawerError} role="alert">
            <p>{detailQuery.error.message}</p>
            <button
              type="button"
              className={styles.drawerButton}
              onClick={() => { void detailQuery.refetch(); }}
              {...{ 'data-testid': 'incident-triage-detail-retry' }}
            >
              Retry
            </button>
          </div>
        ) : null}
        {incident ? (
          <div className={styles.drawerBody}>
            {incident.serviceNowUrl ? (
              <a
                href={incident.serviceNowUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={styles.drawerLink}
                {...{ 'data-testid': 'incident-triage-detail-servicenow-link' }}
              >
                Open in ServiceNow
              </a>
            ) : null}
            <IncidentFacts incident={incident} />
            <section className={styles.drawerSection} aria-labelledby="incident-triage-detail-description-heading">
              <h3 id="incident-triage-detail-description-heading" className={styles.drawerSectionTitle}>Description</h3>
              <p className={styles.detailText}>{incidentText(incident.description)}</p>
            </section>
            {incident.closeNotes ? (
              <section className={styles.drawerSection} aria-labelledby="incident-triage-detail-close-notes-heading">
                <h3 id="incident-triage-detail-close-notes-heading" className={styles.drawerSectionTitle}>Close notes</h3>
                <p className={styles.detailText}>{incident.closeNotes}</p>
              </section>
            ) : null}
            <section className={styles.drawerSection} aria-labelledby="incident-triage-detail-analysis-heading">
              <div className={styles.sectionHeader}>
                <h3 id="incident-triage-detail-analysis-heading" className={styles.drawerSectionTitle}>Analysis</h3>
                {canRun ? (
                  <button
                    type="button"
                    className={styles.drawerButton}
                    disabled={analyze.isPending || isAnalysisInFlight(latest)}
                    onClick={() => analyze.mutate({ project, id: incident.id })}
                    {...{ 'data-testid': 'incident-triage-detail-reanalyze' }}
                  >
                    {analyze.isPending ? 'Starting…' : latest ? 'Re-analyze' : 'Analyze'}
                  </button>
                ) : null}
              </div>
              {message ? (
                <p
                  className={analyze.isError ? styles.fieldError : styles.sweepResult}
                  role={analyze.isError ? 'alert' : 'status'}
                  {...{ 'data-testid': 'incident-triage-detail-reanalyze-message' }}
                >
                  {message}
                </p>
              ) : null}
              <AnalysisPanel analysis={latest} data-testid="incident-triage-detail-analysis" />
            </section>
            <AnalysisHistory analyses={earlier} />
          </div>
        ) : null}
      </aside>
    </div>
  );
};
