import React, { useState } from 'react';
import type { PlaybookRunDetail } from '../../shared/types/playbook';
import {
  formatAtsBoardTranscript,
  parseAtsBoardSynopsis,
  type AtsBoardLeadershipDecision,
} from '../../shared/atsBoard';
import { useAtsBoardAudit } from '../hooks/usePlaybookRuns';
import styles from './AtsBoardSynopsisPanel.module.css';

function leadershipDecision(
  run: PlaybookRunDetail
): AtsBoardLeadershipDecision | null {
  const gate = run.steps.find(
    (step) => step.stepId === 'ratify' && step.status === 'completed'
  );
  const decision = gate?.outputInline?.decision;
  if (decision !== 'approved' && decision !== 'rejected') return null;
  const comment = gate?.outputInline?.comment;
  return {
    decision,
    ...(typeof comment === 'string' && comment.trim() ? { comment } : {}),
  };
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

const AtsBoardAuditPanel: React.FC<{
  project: string;
  runId: string;
  'data-testid'?: string;
}> = ({
  project,
  runId,
  'data-testid': testId = 'ats-board-audit',
}) => {
  const audit = useAtsBoardAudit(project, runId, true);
  return (
    <details className={styles.audit} {...{ 'data-testid': testId }}>
      <summary>Board discussion audit</summary>
      {audit.isPending ? <p>Loading structured discussion…</p> : null}
      {audit.isError ? <p>Could not load the discussion audit.</p> : null}
      {audit.data?.charter ? (
        <div>
          <h4>Charter</h4>
          <p className={styles.auditCharter}>{audit.data.charter}</p>
        </div>
      ) : null}
      {audit.data?.turns.map((turn) => {
        const result = turn.result ?? {};
        const evidence = strings(result.evidence);
        const challenges = strings(result.challenges);
        const revisions = strings(result.revisions);
        return (
          <article key={turn.sequence} className={styles.auditTurn}>
            <h4>
              {turn.sequence}. {turn.specialist} · {turn.phase}
              {turn.topicId ? ` · ${turn.topicId}` : ''}
            </h4>
            {typeof result.position === 'string' ? (
              <p>{result.position}</p>
            ) : null}
            {typeof result.outcome === 'string' ? (
              <p>{result.outcome}</p>
            ) : null}
            {[...evidence, ...challenges, ...revisions].length > 0 ? (
              <ul className={styles.list}>
                {evidence.map((item) => (
                  <li key={`e-${item}`}>Evidence: {item}</li>
                ))}
                {challenges.map((item) => (
                  <li key={`c-${item}`}>Challenge: {item}</li>
                ))}
                {revisions.map((item) => (
                  <li key={`r-${item}`}>Revision: {item}</li>
                ))}
              </ul>
            ) : null}
            <p className={styles.meta}>
              {turn.status}
              {turn.completedAt ? ` · ${turn.completedAt}` : ''}
            </p>
          </article>
        );
      })}
    </details>
  );
};

export const AtsBoardSynopsisPanel: React.FC<{
  run: PlaybookRunDetail;
  'data-testid'?: string;
}> = ({
  run,
  'data-testid': testId = 'ats-board-synopsis',
}) => {
  const [copied, setCopied] = useState(false);
  const isBoard = run.steps.some((step) => step.stepId === 'chair');
  const hasDeliberation = run.steps.some(
    (step) => step.stepType === 'board-deliberation'
  );
  if (!isBoard) return null;

  const chair = run.steps.find((step) => step.stepId === 'chair');
  const synopsis = parseAtsBoardSynopsis(chair?.outputInline ?? null);
  const leadership = leadershipDecision(run);

  return (
    <section
      className={styles.panel}
      aria-labelledby="ats-board-synopsis-title"
      {...{ 'data-testid': testId }}
    >
      <h2 id="ats-board-synopsis-title">Board synopsis</h2>
      {!synopsis ? (
        <p
          className={styles.waiting}
          {...{ 'data-testid': 'ats-board-synopsis-waiting' }}
        >
          {chair?.outputInline
            ? 'The chair finished, but the synopsis could not be read.'
            : 'The board has not finished. The synopsis appears here when the chair step completes.'}
        </p>
      ) : (
        <>
          <p
            className={styles.status}
            {...{ 'data-testid': 'ats-board-synopsis-status' }}
          >
            {leadership?.decision === 'approved'
              ? 'Leadership ratified'
              : leadership?.decision === 'rejected'
                ? 'Leadership rejected'
                : synopsis.status}
          </p>
          {synopsis.decisionRequests.length > 0 ? (
            <div {...{ 'data-testid': 'ats-board-decision-requests' }}>
              <h3>Decisions requested</h3>
              <ul className={styles.list}>
                {synopsis.decisionRequests.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div {...{ 'data-testid': 'ats-board-recommendation' }}>
            <h3>Recommendation</h3>
            <p>{synopsis.recommendation}</p>
          </div>
          <p>{synopsis.executiveSynopsis}</p>
          {synopsis.businessOutcomes.length > 0 ? (
            <div>
              <h3>Business outcomes</h3>
              <ul className={styles.list}>
                {synopsis.businessOutcomes.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div>
            <h3>Phase 1</h3>
            <ul className={styles.list}>
              {synopsis.phase1.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
          <p>
            <strong>Day-1 cutover.</strong> {synopsis.day1Cutover}
          </p>
          <p>
            <strong>Separation.</strong> {synopsis.separationImpact}
          </p>
          <div>
            {synopsis.decisions.map((decision) => (
              <article
                key={decision.id}
                className={styles.decision}
                {...{ 'data-testid': 'ats-board-decision' }}
              >
                <h3>{decision.area}</h3>
                <p>{decision.decision}</p>
                <p>{decision.status}</p>
                <p className={styles.meta}>
                  Confidence {Math.round(decision.confidence * 100)}%
                  {decision.evidenceQuality
                    ? ` · Evidence ${decision.evidenceQuality}`
                    : ''}
                </p>
                <ul className={styles.list}>
                  {decision.evidence.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
          {synopsis.options.length > 0 ? (
            <div {...{ 'data-testid': 'ats-board-options' }}>
              <h3>Options and trade-offs</h3>
              {synopsis.options.map((option) => (
                <article key={option.id} className={styles.decision}>
                  <h4>
                    {option.recommended
                      ? `Recommended: ${option.title}`
                      : option.title}
                  </h4>
                  <p>{option.description}</p>
                  <ul className={styles.list}>
                    {option.tradeoffs.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </article>
              ))}
            </div>
          ) : null}
          {synopsis.deliberation.length > 0 ? (
            <div {...{ 'data-testid': 'ats-board-deliberation-summary' }}>
              <h3>Board deliberation</h3>
              {synopsis.deliberation.map((item) => (
                <article key={item.topic} className={styles.decision}>
                  <h4>{item.topic}</h4>
                  <p>{item.outcome}</p>
                  <p className={styles.meta}>
                    {item.status} · {item.participants.join(', ')}
                  </p>
                </article>
              ))}
            </div>
          ) : null}
          <div {...{ 'data-testid': 'ats-board-dissent' }}>
            <h3>Dissent</h3>
            <ul className={styles.list}>
              {synopsis.dissent.length > 0 ? (
                synopsis.dissent.map((item) => <li key={item}>{item}</li>)
              ) : (
                <li>No dissent recorded.</li>
              )}
            </ul>
          </div>
          <div className={styles.detailGrid}>
            <div>
              <h3>Risks</h3>
              <ul className={styles.list}>
                {synopsis.risks.length > 0 ? (
                  synopsis.risks.map((item) => <li key={item}>{item}</li>)
                ) : (
                  <li>None recorded.</li>
                )}
              </ul>
            </div>
            <div>
              <h3>Assumptions</h3>
              <ul className={styles.list}>
                {synopsis.assumptions.length > 0 ? (
                  synopsis.assumptions.map((item) => <li key={item}>{item}</li>)
                ) : (
                  <li>None recorded.</li>
                )}
              </ul>
            </div>
            <div>
              <h3>Unresolved</h3>
              <ul className={styles.list}>
                {synopsis.unresolved.length > 0 ? (
                  synopsis.unresolved.map((item) => <li key={item}>{item}</li>)
                ) : (
                  <li>None recorded.</li>
                )}
              </ul>
            </div>
            <div>
              <h3>Deferred</h3>
              <ul className={styles.list}>
                {synopsis.deferred.length > 0 ? (
                  synopsis.deferred.map((item) => <li key={item}>{item}</li>)
                ) : (
                  <li>None recorded.</li>
                )}
              </ul>
            </div>
          </div>
          {synopsis.leadershipActions.length > 0 ? (
            <div {...{ 'data-testid': 'ats-board-leadership-actions' }}>
              <h3>Leadership actions</h3>
              <ul className={styles.list}>
                {synopsis.leadershipActions.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {hasDeliberation ? (
            <AtsBoardAuditPanel
              project={run.project}
              runId={run.runId}
              {...{ 'data-testid': 'ats-board-audit' }}
            />
          ) : null}
          {leadership?.comment ? (
            <p {...{ 'data-testid': 'ats-board-leadership-note' }}>
              {leadership.comment}
            </p>
          ) : null}
          {leadership?.decision === 'approved' ? (
            <>
              <button
                type="button"
                onClick={() => {
                  const transcript = formatAtsBoardTranscript(
                    synopsis,
                    leadership
                  );
                  void navigator.clipboard?.writeText(transcript);
                  setCopied(true);
                }}
                {...{ 'data-testid': 'ats-board-copy-transcript' }}
              >
                {copied ? 'Copied' : 'Copy requirements transcript'}
              </button>
              <pre
                className={styles.transcript}
                {...{ 'data-testid': 'ats-board-transcript' }}
              >
                {formatAtsBoardTranscript(synopsis, leadership)}
              </pre>
            </>
          ) : (
            <p {...{ 'data-testid': 'ats-board-not-a-requirement' }}>
              This is not a requirement until leadership ratifies it.
            </p>
          )}
        </>
      )}
    </section>
  );
};
