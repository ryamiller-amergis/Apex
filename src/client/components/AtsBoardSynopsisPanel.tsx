import React, { useState } from 'react';
import type { PlaybookRunDetail } from '../../shared/types/playbook';
import {
  atsBoardPackageStatusLabel,
  plainExceptionCategory,
  plainLeadershipCopy,
  formatAtsBoardTranscript,
  parseAtsBoardLeadershipAnswers,
  parseAtsBoardSynopsis,
  type AtsBoardDeliberationItem,
  type AtsBoardLeadershipDecision,
} from '../../shared/atsBoard';
import { useAtsBoardAudit } from '../hooks/usePlaybookRuns';
import styles from './AtsBoardSynopsisPanel.module.css';

const KNOWN_ACRONYMS = new Set([
  'PHI',
  'HIPAA',
  'BAA',
  'ATS',
  'VMS',
  'MSP',
  'UX',
  'API',
  'SSO',
  'RBAC',
  'QA',
]);

const CODE_TITLE_OVERRIDES: Record<string, string> = {
  'D-PORTAL': 'Client Portal & Submittal Review',
  'D-CLIENT-AUTH': 'Client Decision Logging Authority',
  'D-CLEARANCE': 'Compliance Clearance Bridge Rule',
  'D-CUTOVER-PLACEMENTS': 'Active Placements at Day-1 Cutover',
  'D-COMMERCIAL': 'Pay, Bill & Margin Field Visibility',
  'D-MIGRATION': 'Legacy ATS Export & Stage Mapping',
  'D-PHI': 'PHI, BAA & Client Packet Boundaries',
};

interface ParsedReferenceText {
  code: string | null;
  title: string | null;
  body: string;
  inlineRefs: string[];
}

function humanizeCode(code: string): string {
  const upper = code.toUpperCase();
  if (CODE_TITLE_OVERRIDES[upper]) {
    return CODE_TITLE_OVERRIDES[upper];
  }
  const stripped = upper.replace(/^[A-Z]-/, '');
  if (/^\d+$/.test(stripped)) {
    return `Item ${upper}`;
  }
  return stripped
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) =>
      KNOWN_ACRONYMS.has(word)
        ? word
        : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
    )
    .join(' ');
}

function extractInlineCodes(text: string): string[] {
  const matches = text.match(/\b(?:D-[A-Z0-9-]+|[TDOC]\d+)\b/g) ?? [];
  return Array.from(new Set(matches));
}

export function parseReferenceItem(raw: string): ParsedReferenceText {
  const trimmed = raw.trim();
  const prefixMatch =
    /^([A-Z]+(?:-[A-Z0-9]+)+|[A-Z]\d+)\s*(?::|—|–)\s*(.+)$/s.exec(trimmed);
  if (!prefixMatch) {
    return {
      code: null,
      title: null,
      body: trimmed,
      inlineRefs: extractInlineCodes(trimmed),
    };
  }

  const code = prefixMatch[1].trim();
  const rest = prefixMatch[2].trim();

  // For topic strings like "T1 — Client vs Product: detail...", split short title before colon
  if (/^[A-Z]\d+$/i.test(code)) {
    const colonIdx = rest.indexOf(':');
    if (colonIdx > 0 && colonIdx <= 65) {
      return {
        code,
        title: rest.slice(0, colonIdx).trim(),
        body: rest.slice(colonIdx + 1).trim(),
        inlineRefs: extractInlineCodes(rest),
      };
    }
    return {
      code,
      title: rest,
      body: '',
      inlineRefs: extractInlineCodes(rest),
    };
  }

  return {
    code,
    title: humanizeCode(code),
    body: rest,
    inlineRefs: extractInlineCodes(rest),
  };
}

function formatActionText(raw: string): {
  text: string;
  refs: string[];
} {
  const refs = extractInlineCodes(raw);
  // Keep text readable by replacing parenthetical raw codes like "(D-CLEARANCE)" at the end
  // while preserving inline prose references in a human-friendly way.
  const cleaned = raw
    .replace(
      /\s*\((?:D-[A-Z0-9-]+|[TDOC]\d+)(?:,\s*(?:D-[A-Z0-9-]+|[TDOC]\d+))*\)(?=[.;,]?$)/g,
      ''
    )
    .replace(/\bD-[A-Z0-9-]+\b/g, (match) => humanizeCode(match))
    .trim();
  return { text: cleaned, refs };
}

function findMatchingActions(
  code: string | null,
  index: number,
  totalDecisions: number,
  actions: string[]
): string[] {
  if (code) {
    const pattern = new RegExp(
      `\\b${code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
      'i'
    );
    const matched = actions.filter((action) => pattern.test(action));
    if (matched.length > 0) {
      return matched;
    }
  }
  if (!code && totalDecisions === actions.length && actions[index]) {
    return [actions[index]];
  }
  return [];
}

function formatDeliberationStatus(status: AtsBoardDeliberationItem['status']): {
  label: string;
  tone: 'warning' | 'danger' | 'success';
} {
  switch (status) {
    case 'leadership_required':
      return { label: 'Needs leadership decision', tone: 'warning' };
    case 'unresolved':
      return { label: 'Unresolved', tone: 'danger' };
    case 'resolved':
      return { label: 'Resolved by board', tone: 'success' };
  }
}

function formatDecisionStatusTone(
  status: string
): 'success' | 'warning' | 'danger' {
  if (status.startsWith('Board approved')) return 'success';
  if (status.startsWith('Blocked')) return 'danger';
  return 'warning';
}

function formatParticipantName(role: string): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function leadershipDecision(
  run: PlaybookRunDetail
): AtsBoardLeadershipDecision | null {
  const gate = run.steps.find(
    (step) => step.stepId === 'ratify' && step.status === 'completed'
  );
  const decision = gate?.outputInline?.decision;
  if (decision !== 'approved' && decision !== 'rejected') return null;
  const comment = gate?.outputInline?.comment;
  const answers = parseAtsBoardLeadershipAnswers(gate?.outputInline?.answers);
  return {
    decision,
    ...(typeof comment === 'string' && comment.trim() ? { comment } : {}),
    ...(answers?.length ? { answers } : {}),
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
}> = ({ project, runId, 'data-testid': testId = 'ats-board-audit' }) => {
  const audit = useAtsBoardAudit(project, runId, true);
  return (
    <details
      className={styles.collapsibleSection}
      {...{ 'data-testid': testId }}
    >
      <summary className={styles.collapsibleSummary}>
        <span>Board discussion audit</span>
        <span className={styles.summaryMeta}>
          Turn-by-turn specialist trace
        </span>
      </summary>
      <div className={styles.collapsibleBody}>
        {audit.isPending ? <p>Loading structured discussion…</p> : null}
        {audit.isError ? <p>Could not load the discussion audit.</p> : null}
        {audit.data?.charter ? (
          <div className={styles.auditCharterBox}>
            <h4>Charter</h4>
            <p className={styles.auditCharter}>{audit.data.charter}</p>
          </div>
        ) : null}
        {audit.data?.turns.map((turn) => {
          const result = turn.result ?? {};
          const evidence = strings(result.evidence);
          const challenges = strings(result.challenges);
          const revisions = strings(result.revisions);
          const citedEvidenceIds = strings(result.citedEvidenceIds);
          const evidenceGaps = strings(result.evidenceGaps);
          const unsupportedClaims = strings(result.unsupportedClaims);
          return (
            <article key={turn.sequence} className={styles.auditTurn}>
              <h4>
                {turn.sequence}. {formatParticipantName(turn.specialist)} ·{' '}
                {turn.phase}
                {turn.topicId ? (
                  <span className={styles.refBadge} data-ref-id={turn.topicId}>
                    {turn.topicId}
                  </span>
                ) : null}
              </h4>
              {typeof result.position === 'string' ? (
                <p>{result.position}</p>
              ) : null}
              {typeof result.outcome === 'string' ? (
                <p>{result.outcome}</p>
              ) : null}
              {[
                ...evidence,
                ...challenges,
                ...revisions,
                ...evidenceGaps,
                ...unsupportedClaims,
              ].length > 0 || citedEvidenceIds.length > 0 ? (
                <ul className={styles.list}>
                  {citedEvidenceIds.map((item) => (
                    <li key={`id-${item}`}>
                      Cited evidence ID:{' '}
                      <span className={styles.refBadge} data-ref-id={item}>
                        {item}
                      </span>
                    </li>
                  ))}
                  {evidence.map((item) => (
                    <li key={`e-${item}`}>Evidence: {item}</li>
                  ))}
                  {challenges.map((item) => (
                    <li key={`c-${item}`}>Challenge: {item}</li>
                  ))}
                  {revisions.map((item) => (
                    <li key={`r-${item}`}>Revision: {item}</li>
                  ))}
                  {evidenceGaps.map((item) => (
                    <li key={`g-${item}`}>Evidence gap: {item}</li>
                  ))}
                  {unsupportedClaims.map((item) => (
                    <li key={`u-${item}`}>Unsupported: {item}</li>
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
      </div>
    </details>
  );
};

export const AtsBoardSynopsisPanel: React.FC<{
  run: PlaybookRunDetail;
  'data-testid'?: string;
}> = ({ run, 'data-testid': testId = 'ats-board-synopsis' }) => {
  const [copied, setCopied] = useState(false);
  const isBoard = run.steps.some((step) => step.stepId === 'chair');
  const hasDeliberation = run.steps.some(
    (step) => step.stepType === 'board-deliberation'
  );
  if (!isBoard) return null;

  const chair = run.steps.find((step) => step.stepId === 'chair');
  const synopsis = parseAtsBoardSynopsis(chair?.outputInline ?? null);
  const leadership = leadershipDecision(run);
  const isFocusedV4 =
    synopsis?.schemaVersion === 4 && Boolean(synopsis.leadershipBrief);

  const approvedDomainsCount =
    synopsis?.decisions.filter((d) => d.status.startsWith('Board approved'))
      .length ?? 0;
  const blockedDomainsCount =
    synopsis?.decisions.filter((d) => d.status.startsWith('Blocked')).length ??
    0;
  const insufficientDomainsCount =
    synopsis?.decisions.filter((d) =>
      d.status.startsWith('Open — insufficient')
    ).length ?? 0;
  const openDomainsCount =
    (synopsis?.decisions.length ?? 0) - approvedDomainsCount;

  return (
    <section
      className={styles.panel}
      aria-labelledby="ats-board-synopsis-title"
      {...{ 'data-testid': testId }}
    >
      <div className={styles.headerRow}>
        <div>
          <p className={styles.eyebrow}>Executive Decision Brief</p>
          <h2 id="ats-board-synopsis-title" className={styles.title}>
            Board synopsis
          </h2>
        </div>
        {synopsis ? (
          <div className={styles.headerRight}>
            <p
              className={`${styles.status} ${
                leadership?.decision === 'approved'
                  ? styles.statusApproved
                  : leadership?.decision === 'rejected'
                    ? styles.statusRejected
                    : styles.statusPending
              }`}
              {...{ 'data-testid': 'ats-board-synopsis-status' }}
            >
              {atsBoardPackageStatusLabel(synopsis, leadership)}
            </p>
          </div>
        ) : null}
      </div>

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
          {isFocusedV4 && synopsis.leadershipBrief ? (
            <div
              className={styles.v4Brief}
              {...{ 'data-testid': 'ats-board-v4-brief' }}
            >
              <div
                className={styles.recommendationCard}
                {...{ 'data-testid': 'ats-board-recommendation' }}
              >
                <div className={styles.sectionHeader}>
                  <h3>
                    {leadership?.decision === 'approved'
                      ? 'Approved AI Phase 1 plan'
                      : 'AI-proposed Phase 1 plan'}
                  </h3>
                  <span className={styles.sectionTag}>
                    {synopsis.leadershipBrief.materialExceptions.length === 0
                      ? 'Ready to approve'
                      : `${synopsis.leadershipBrief.materialExceptions.length} exception${
                          synopsis.leadershipBrief.materialExceptions.length === 1
                            ? ''
                            : 's'
                        } for review`}
                  </span>
                </div>
                <p
                  className={styles.leadText}
                  {...{ 'data-testid': 'ats-board-v4-headline' }}
                >
                  {plainLeadershipCopy(
                    synopsis.leadershipBrief.headline,
                    synopsis.leadershipBrief.materialExceptions
                  )}
                </p>

                {leadership?.decision === 'approved' && leadership.comment ? (
                  <p
                    className={styles.leadershipNote}
                    {...{ 'data-testid': 'ats-board-leadership-note' }}
                  >
                    <strong>Ratification note:</strong> {leadership.comment}
                  </p>
                ) : null}

                <div className={styles.outcomesBlock}>
                  <h4 className={styles.subHeading}>Decisions the AI made</h4>
                  <ul
                    className={styles.list}
                    {...{ 'data-testid': 'ats-board-v4-ai-decisions' }}
                  >
                    {synopsis.leadershipBrief.aiDecisions.map((item) => (
                      <li key={item}>
                        {plainLeadershipCopy(
                          item,
                          synopsis.leadershipBrief?.materialExceptions
                        )}
                      </li>
                    ))}
                  </ul>
                </div>

                <div className={styles.outcomesBlock}>
                  <h4 className={styles.subHeading}>Expected business impact</h4>
                  <ul
                    className={styles.outcomeGrid}
                    {...{ 'data-testid': 'ats-board-v4-outcomes' }}
                  >
                    {synopsis.leadershipBrief.expectedOutcomes.map((item) => (
                      <li key={item} className={styles.outcomeCard}>
                        {plainLeadershipCopy(
                          item,
                          synopsis.leadershipBrief?.materialExceptions
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              <div
                className={styles.sectionBlock}
                {...{ 'data-testid': 'ats-board-v4-exceptions' }}
              >
                <div className={styles.sectionHeader}>
                  <div>
                    <h3>Material exceptions for leadership</h3>
                    <p className={styles.sectionSubtitle}>
                      Product, workflow, and screen choices are already settled
                      above. Only a charter change, a legal duty, customer data,
                      go-live, spending, or a promise to an outside party
                      appears here.
                    </p>
                  </div>
                </div>
                {synopsis.leadershipBrief.materialExceptions.length === 0 ? (
                  <p
                    className={styles.meta}
                    {...{ 'data-testid': 'ats-board-v4-no-exceptions' }}
                  >
                    No material exceptions. All Phase 1 decisions fit within the
                    charter and can be approved directly.
                  </p>
                ) : (
                  <div className={styles.decisionRequestGrid}>
                    {synopsis.leadershipBrief.materialExceptions.map(
                      (exception) => {
                        const recordedAnswer = leadership?.answers?.find(
                          (item) => item.decisionId === exception.id
                        );
                        return (
                          <article
                            key={exception.id}
                            className={styles.decisionRequestCard}
                            data-ref-id={exception.id}
                            {...{ 'data-testid': 'ats-board-v4-exception' }}
                          >
                            <div className={styles.cardHeader}>
                              <h4 className={styles.cardTitle}>
                                {plainLeadershipCopy(
                                  exception.title,
                                  synopsis.leadershipBrief?.materialExceptions
                                )}
                              </h4>
                              <div className={styles.badgeRow}>
                                <span className={styles.toneBadge}>
                                  {plainExceptionCategory(exception.category)}
                                </span>
                              </div>
                            </div>
                            <p className={styles.cardBody}>
                              {plainLeadershipCopy(
                                exception.question,
                                synopsis.leadershipBrief?.materialExceptions
                              )}
                            </p>
                            <div className={styles.followUpBox}>
                              <span className={styles.followUpLabel}>
                                {recordedAnswer &&
                                recordedAnswer.resolution !==
                                  'accept_recommendation'
                                  ? 'Leadership override'
                                  : 'AI recommended resolution'}
                              </span>
                              <p className={styles.cardBody}>
                                {plainLeadershipCopy(
                                  recordedAnswer
                                    ? recordedAnswer.response
                                    : exception.recommendedResolution,
                                  synopsis.leadershipBrief?.materialExceptions
                                )}
                              </p>
                            </div>
                          </article>
                        );
                      }
                    )}
                  </div>
                )}
              </div>
            </div>
          ) : (
            <>
          {/* At-a-glance executive context banner */}
          {leadership?.decision === 'approved' ? null : (
            <div className={styles.kpiStrip}>
              <div className={styles.kpiChip}>
                <span className={styles.kpiValue}>
                  {synopsis.decisionRequests.length}
                </span>
                <span className={styles.kpiLabel}>
                  Leadership decisions needed
                </span>
              </div>
              <div className={styles.kpiChip}>
                <span className={styles.kpiValue}>{approvedDomainsCount}</span>
                <span className={styles.kpiLabel}>Board-settled domains</span>
              </div>
              <div className={styles.kpiChip}>
                <span className={styles.kpiValue}>
                  {insufficientDomainsCount}
                </span>
                <span className={styles.kpiLabel}>Insufficient evidence</span>
              </div>
              <div className={styles.kpiChip}>
                <span className={styles.kpiValue}>{blockedDomainsCount}</span>
                <span className={styles.kpiLabel}>Charter blocked</span>
              </div>
              <div className={styles.kpiChip}>
                <span className={styles.kpiValue}>{openDomainsCount}</span>
                <span className={styles.kpiLabel}>Open domains (total)</span>
              </div>
              <div className={styles.kpiChip}>
                <span className={styles.kpiValue}>
                  {synopsis.leadershipActions.length}
                </span>
                <span className={styles.kpiLabel}>Follow-up actions</span>
              </div>
            </div>
          )}

          {leadership?.decision === 'approved' ? (
            <div
              className={styles.sectionBlock}
              {...{ 'data-testid': 'ats-board-ratification-summary' }}
            >
              <div className={styles.sectionHeader}>
                <div>
                  <h3>What leadership approved</h3>
                  <p className={styles.sectionSubtitle}>
                    This is the decision record. The research behind it stays
                    available below.
                  </p>
                </div>
              </div>
              <p className={styles.leadText}>{synopsis.recommendation}</p>
              {leadership.comment ? (
                <p
                  className={styles.leadershipNote}
                  {...{ 'data-testid': 'ats-board-leadership-note' }}
                >
                  <strong>Ratification note:</strong> {leadership.comment}
                </p>
              ) : null}
              {leadership.answers && leadership.answers.length > 0 ? (
                <div {...{ 'data-testid': 'ats-board-leadership-resolutions' }}>
                  <h4 className={styles.subHeading}>Decisions recorded</h4>
                  <ul className={styles.actionChecklist}>
                    {leadership.answers.map((answer, index) => {
                      const request = synopsis.decisionRequests.find((item) =>
                        item.toUpperCase().startsWith(answer.decisionId)
                      );
                      const parsed = request
                        ? parseReferenceItem(request)
                        : null;
                      const resolution =
                        answer.resolution === 'accept_recommendation'
                          ? 'Accepted the board recommendation'
                          : answer.resolution === 'defer'
                            ? 'Deferred'
                            : 'Leadership direction';
                      return (
                        <li
                          key={answer.decisionId}
                          className={styles.actionItem}
                        >
                          <span className={styles.actionNumber}>
                            {index + 1}
                          </span>
                          <div className={styles.actionContent}>
                            <strong>
                              {parsed?.title ??
                                parsed?.body ??
                                `Decision ${index + 1}`}
                            </strong>
                            <span>
                              {resolution}: {answer.response}
                            </span>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : null}
              <div>
                <h4 className={styles.subHeading}>Phase 1 includes</h4>
                <ul className={styles.list}>
                  {synopsis.phase1.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h4 className={styles.subHeading}>Left for later</h4>
                <ul className={styles.list}>
                  {synopsis.deferred.length > 0 ? (
                    synopsis.deferred.map((item) => <li key={item}>{item}</li>)
                  ) : (
                    <li>Nothing else was deferred.</li>
                  )}
                </ul>
              </div>
              <div>
                <h4 className={styles.subHeading}>Follow-up actions</h4>
                <ul className={styles.list}>
                  {synopsis.leadershipActions.length > 0 ? (
                    synopsis.leadershipActions.map((item) => (
                      <li key={item}>{formatActionText(item).text}</li>
                    ))
                  ) : (
                    <li>No follow-up actions were recorded.</li>
                  )}
                </ul>
              </div>
              <div>
                <h4 className={styles.subHeading}>
                  Items that still need attention
                </h4>
                <ul className={styles.list}>
                  {[...synopsis.risks, ...synopsis.unresolved].length > 0 ? (
                    [...synopsis.risks, ...synopsis.unresolved].map((item) => (
                      <li key={item}>
                        {parseReferenceItem(item).body || item}
                      </li>
                    ))
                  ) : (
                    <li>No open risks were recorded.</li>
                  )}
                </ul>
              </div>
            </div>
          ) : null}

          {leadership?.decision !== 'approved' && !leadership ? (
            <p
              className={styles.ratificationExplainer}
              {...{ 'data-testid': 'ats-board-not-a-requirement' }}
            >
              <strong>How to use this brief:</strong> This is not a requirement
              until leadership ratifies it. Review the recommendation, then
              resolve each open decision in the guided leadership review before
              ratifying.
            </p>
          ) : null}

          {/* 1. Executive Recommendation & Business Outcomes */}
          {leadership?.decision === 'approved' ? null : (
            <div
              className={styles.recommendationCard}
              {...{ 'data-testid': 'ats-board-recommendation' }}
            >
              <div className={styles.sectionHeader}>
                <h3>Board recommendation</h3>
                <span className={styles.sectionTag}>Phase 1 Direction</span>
              </div>
              <p className={styles.leadText}>{synopsis.recommendation}</p>

              {synopsis.businessOutcomes.length > 0 ? (
                <div className={styles.outcomesBlock}>
                  <h4 className={styles.subHeading}>
                    Target business outcomes
                  </h4>
                  <ul className={styles.outcomeGrid}>
                    {synopsis.businessOutcomes.map((item) => (
                      <li key={item} className={styles.outcomeCard}>
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {synopsis.executiveSynopsis &&
              synopsis.executiveSynopsis.trim() !==
                synopsis.recommendation.trim() ? (
                <details className={styles.inlineDetails}>
                  <summary className={styles.inlineSummary}>
                    View full executive narrative
                  </summary>
                  <p className={styles.narrativeText}>
                    {synopsis.executiveSynopsis}
                  </p>
                </details>
              ) : null}
            </div>
          )}

          {/* 2. Decisions Requested from Leadership + Paired Follow-up Actions */}
          {leadership?.decision !== 'approved' &&
          synopsis.decisionRequests.length > 0 ? (
            <div
              className={styles.sectionBlock}
              {...{ 'data-testid': 'ats-board-decision-requests' }}
            >
              <div className={styles.sectionHeader}>
                <div>
                  <h3>Decisions requested from leadership</h3>
                  <p className={styles.sectionSubtitle}>
                    Each item below pairs the policy or scope question with the
                    concrete follow-up action required to unblock Phase 1.
                  </p>
                </div>
              </div>
              <div className={styles.decisionRequestGrid}>
                {synopsis.decisionRequests.map((item, index) => {
                  const parsed = parseReferenceItem(item);
                  const matchedActions = findMatchingActions(
                    parsed.code,
                    index,
                    synopsis.decisionRequests.length,
                    synopsis.leadershipActions
                  );
                  return (
                    <article
                      key={item}
                      className={styles.decisionRequestCard}
                      data-ref-id={parsed.code ?? undefined}
                    >
                      <div className={styles.cardHeader}>
                        <span className={styles.stepIndex}>#{index + 1}</span>
                        <h4 className={styles.cardTitle}>
                          {parsed.title ?? `Leadership Decision ${index + 1}`}
                        </h4>
                      </div>
                      <p className={styles.cardBody}>{parsed.body}</p>
                      {matchedActions.length > 0 ? (
                        <div className={styles.followUpBox}>
                          <span className={styles.followUpLabel}>
                            What needs to be accomplished:
                          </span>
                          <ul className={styles.followUpList}>
                            {matchedActions.map((action) => {
                              const formatted = formatActionText(action);
                              return <li key={action}>{formatted.text}</li>;
                            })}
                          </ul>
                        </div>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            </div>
          ) : null}
            </>
          )}

          <details
            className={styles.collapsibleSection}
            {...{ 'data-testid': 'ats-board-supporting-detail' }}
          >
            <summary className={styles.collapsibleSummary}>
              <span>Supporting research and delivery detail</span>
              <span className={styles.summaryMeta}>
                Scope, options, evidence, risks and board record
              </span>
            </summary>
            <div className={styles.collapsibleBody}>
              {/* 3. Complete Leadership Action Plan */}
              {synopsis.leadershipActions.length > 0 ? (
                <div
                  className={styles.sectionBlock}
                  {...{ 'data-testid': 'ats-board-leadership-actions' }}
                >
                  <div className={styles.sectionHeader}>
                    <div>
                      <h3>Leadership action plan</h3>
                      <p className={styles.sectionSubtitle}>
                        Next steps and sign-offs to complete during or
                        immediately after ratification.
                      </p>
                    </div>
                  </div>
                  <ul className={styles.actionChecklist}>
                    {synopsis.leadershipActions.map((item, idx) => {
                      const formatted = formatActionText(item);
                      return (
                        <li key={item} className={styles.actionItem}>
                          <span className={styles.actionNumber}>{idx + 1}</span>
                          <div className={styles.actionContent}>
                            <span>{formatted.text}</span>
                            {formatted.refs.length > 0 ? (
                              <span className={styles.inlineRefGroup}>
                                {formatted.refs.map((ref) => (
                                  <span
                                    key={ref}
                                    className={styles.refBadge}
                                    data-ref-id={ref}
                                  >
                                    {ref}
                                  </span>
                                ))}
                              </span>
                            ) : null}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : null}

              {/* 4. Options & Trade-offs */}
              {synopsis.options.length > 0 ? (
                <div
                  className={styles.sectionBlock}
                  {...{ 'data-testid': 'ats-board-options' }}
                >
                  <div className={styles.sectionHeader}>
                    <div>
                      <h3>Options and trade-offs</h3>
                      <p className={styles.sectionSubtitle}>
                        Rollout paths evaluated by the board.
                      </p>
                    </div>
                  </div>
                  <div className={styles.optionsGrid}>
                    {synopsis.options.map((option) => (
                      <article
                        key={option.id}
                        className={`${styles.optionCard} ${
                          option.recommended ? styles.optionCardRecommended : ''
                        }`}
                        data-ref-id={option.id}
                      >
                        <div className={styles.cardHeader}>
                          <h4 className={styles.cardTitle}>
                            {option.recommended
                              ? `Recommended: ${option.title}`
                              : option.title}
                          </h4>
                          <span
                            className={styles.refBadge}
                            data-ref-id={option.id}
                          >
                            {option.id}
                          </span>
                        </div>
                        <p className={styles.cardBody}>{option.description}</p>
                        {option.tradeoffs.length > 0 ? (
                          <div className={styles.tradeoffsBox}>
                            <span className={styles.tradeoffsLabel}>
                              Trade-offs
                            </span>
                            <ul className={styles.list}>
                              {option.tradeoffs.map((item) => (
                                <li key={item}>{item}</li>
                              ))}
                            </ul>
                          </div>
                        ) : null}
                      </article>
                    ))}
                  </div>
                </div>
              ) : null}

              {/* 5. Scope & Operational Boundaries (Phase 1 vs Deferred + Cutover/Separation) */}
              <div className={styles.scopeGrid}>
                <div className={styles.scopeCard}>
                  <h3>Phase 1 scope</h3>
                  <ul className={styles.list}>
                    {synopsis.phase1.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
                <div className={styles.scopeCard}>
                  <h3>Deferred beyond Phase 1</h3>
                  <ul className={styles.list}>
                    {synopsis.deferred.length > 0 ? (
                      synopsis.deferred.map((item) => (
                        <li key={item}>{item}</li>
                      ))
                    ) : (
                      <li>None recorded.</li>
                    )}
                  </ul>
                </div>
              </div>

              {synopsis.readiness ? (
                <div
                  className={styles.sectionBlock}
                  {...{ 'data-testid': 'ats-board-readiness' }}
                >
                  <div className={styles.sectionHeader}>
                    <h3>Package readiness</h3>
                    <span className={styles.sectionTag}>
                      {synopsis.readiness.ratifiable
                        ? 'Ratifiable'
                        : 'Not ratifiable'}
                    </span>
                  </div>
                  {synopsis.readiness.blockers.length > 0 ? (
                    <ul className={styles.list}>
                      {synopsis.readiness.blockers.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className={styles.meta}>No blockers recorded.</p>
                  )}
                </div>
              ) : null}

              {synopsis.lenses ? (
                <div
                  className={styles.sectionBlock}
                  {...{ 'data-testid': 'ats-board-lenses' }}
                >
                  <div className={styles.sectionHeader}>
                    <h3>Cross-cutting lenses</h3>
                  </div>
                  <div className={styles.scopeGrid}>
                    {(
                      [
                        ['Security', synopsis.lenses.security],
                        ['Cost', synopsis.lenses.cost],
                        ['Delivery', synopsis.lenses.delivery],
                        ['Adoption', synopsis.lenses.adoption],
                      ] as const
                    ).map(([label, items]) => (
                      <div key={label} className={styles.scopeCard}>
                        <h4>{label}</h4>
                        <ul className={styles.list}>
                          {items.length > 0 ? (
                            items.map((item) => <li key={item}>{item}</li>)
                          ) : (
                            <li>None recorded.</li>
                          )}
                        </ul>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className={styles.calloutGrid}>
                <div className={styles.calloutBox}>
                  <h4>Day-1 cutover</h4>
                  <p>{synopsis.day1Cutover}</p>
                </div>
                <div className={styles.calloutBox}>
                  <h4>Separation</h4>
                  <p>{synopsis.separationImpact}</p>
                </div>
              </div>

              {/* 6. Supporting Details (Collapsible sections for deep-dive inspection) */}
              <div className={styles.supportingSectionGroup}>
                <p className={styles.supportingHeader}>
                  Supporting Board Record & Specialist Evidence
                </p>

                {synopsis.evidenceRegister &&
                synopsis.evidenceRegister.length > 0 ? (
                  <details
                    className={styles.collapsibleSection}
                    {...{ 'data-testid': 'ats-board-evidence-register' }}
                  >
                    <summary className={styles.collapsibleSummary}>
                      <span>Evidence register</span>
                      <span className={styles.summaryMeta}>
                        {synopsis.evidenceRegister.length} entries
                      </span>
                    </summary>
                    <div className={styles.collapsibleBody}>
                      {synopsis.evidenceRegister.map((entry) => (
                        <article
                          key={entry.id}
                          className={styles.decision}
                          data-ref-id={entry.id}
                        >
                          <div className={styles.cardHeader}>
                            <h3>{entry.id}</h3>
                            {entry.corroboration ? (
                              <span className={styles.refBadge}>
                                {entry.corroboration}
                              </span>
                            ) : null}
                          </div>
                          <p>{entry.claim}</p>
                          <p className={styles.meta}>{entry.source}</p>
                        </article>
                      ))}
                    </div>
                  </details>
                ) : null}

                {/* 6a. Domain Decision Ledger */}
                <details className={styles.collapsibleSection}>
                  <summary className={styles.collapsibleSummary}>
                    <span>Domain decision ledger & citations</span>
                    <span className={styles.summaryMeta}>
                      {synopsis.decisions.length} domains (
                      {approvedDomainsCount} approved, {openDomainsCount} open)
                    </span>
                  </summary>
                  <div className={styles.collapsibleBody}>
                    {synopsis.decisions.map((decision) => {
                      const tone = formatDecisionStatusTone(decision.status);
                      return (
                        <article
                          key={decision.id}
                          className={styles.decision}
                          data-ref-id={decision.id}
                          {...{ 'data-testid': 'ats-board-decision' }}
                        >
                          <div className={styles.cardHeader}>
                            <h3>{decision.area}</h3>
                            <div className={styles.badgeRow}>
                              <span
                                className={`${styles.toneBadge} ${
                                  tone === 'success'
                                    ? styles.toneSuccess
                                    : tone === 'danger'
                                      ? styles.toneDanger
                                      : styles.toneWarning
                                }`}
                              >
                                {decision.status}
                              </span>
                              <span
                                className={styles.refBadge}
                                data-ref-id={decision.id}
                              >
                                {decision.id}
                              </span>
                            </div>
                          </div>
                          <p>{decision.decision}</p>
                          <p className={styles.meta}>
                            Confidence {Math.round(decision.confidence * 100)}%
                            {decision.evidenceQuality
                              ? ` · Evidence ${decision.evidenceQuality}`
                              : ''}
                          </p>
                          {decision.evidenceIds &&
                          decision.evidenceIds.length > 0 ? (
                            <p className={styles.meta}>
                              Evidence IDs:{' '}
                              {decision.evidenceIds.map((id) => (
                                <span
                                  key={id}
                                  className={styles.refBadge}
                                  data-ref-id={id}
                                >
                                  {id}
                                </span>
                              ))}
                            </p>
                          ) : null}
                          {decision.evidence.length > 0 ? (
                            <details className={styles.inlineDetails}>
                              <summary className={styles.inlineSummary}>
                                View {decision.evidence.length} source{' '}
                                {decision.evidence.length === 1
                                  ? 'citation'
                                  : 'citations'}
                              </summary>
                              <ul className={styles.list}>
                                {decision.evidence.map((item) => (
                                  <li key={item}>{item}</li>
                                ))}
                              </ul>
                            </details>
                          ) : null}
                        </article>
                      );
                    })}
                  </div>
                </details>

                {/* 6b. Board Deliberation & Dissent */}
                <details className={styles.collapsibleSection}>
                  <summary className={styles.collapsibleSummary}>
                    <span>Board deliberation & dissent</span>
                    <span className={styles.summaryMeta}>
                      {synopsis.deliberation.length} debated topics ·{' '}
                      {synopsis.dissent.length} dissent items
                    </span>
                  </summary>
                  <div className={styles.collapsibleBody}>
                    {synopsis.deliberation.length > 0 ? (
                      <div
                        {...{ 'data-testid': 'ats-board-deliberation-summary' }}
                      >
                        <h3>Board deliberation</h3>
                        {synopsis.deliberation.map((item) => {
                          const parsedTopic = parseReferenceItem(item.topic);
                          const statusInfo = formatDeliberationStatus(
                            item.status
                          );
                          return (
                            <article
                              key={item.topic}
                              className={styles.decision}
                              data-ref-id={parsedTopic.code ?? undefined}
                              data-status={item.status}
                            >
                              <div className={styles.cardHeader}>
                                <h4>{parsedTopic.title ?? item.topic}</h4>
                                <div className={styles.badgeRow}>
                                  <span
                                    className={`${styles.toneBadge} ${
                                      statusInfo.tone === 'success'
                                        ? styles.toneSuccess
                                        : statusInfo.tone === 'danger'
                                          ? styles.toneDanger
                                          : styles.toneWarning
                                    }`}
                                  >
                                    {statusInfo.label}
                                  </span>
                                  {parsedTopic.code ? (
                                    <span
                                      className={styles.refBadge}
                                      data-ref-id={parsedTopic.code}
                                    >
                                      {parsedTopic.code}
                                    </span>
                                  ) : null}
                                </div>
                              </div>
                              {parsedTopic.body ? (
                                <p>{parsedTopic.body}</p>
                              ) : null}
                              <p>{item.outcome}</p>
                              <p className={styles.meta}>
                                Participants:{' '}
                                {item.participants
                                  .map(formatParticipantName)
                                  .join(', ')}
                              </p>
                            </article>
                          );
                        })}
                      </div>
                    ) : null}

                    <div {...{ 'data-testid': 'ats-board-dissent' }}>
                      <h3>Dissent</h3>
                      <ul className={styles.list}>
                        {synopsis.dissent.length > 0 ? (
                          synopsis.dissent.map((item) => {
                            const parsed = parseReferenceItem(item);
                            return (
                              <li
                                key={item}
                                data-ref-id={parsed.code ?? undefined}
                              >
                                {parsed.title ? (
                                  <strong>{parsed.title}: </strong>
                                ) : null}
                                {parsed.body || parsed.title}
                                {parsed.code ? (
                                  <span
                                    className={styles.refBadgeInline}
                                    data-ref-id={parsed.code}
                                  >
                                    {parsed.code}
                                  </span>
                                ) : null}
                              </li>
                            );
                          })
                        ) : (
                          <li>No dissent recorded.</li>
                        )}
                      </ul>
                    </div>
                  </div>
                </details>

                {/* 6c. Risks, Assumptions & Unresolved */}
                <details className={styles.collapsibleSection}>
                  <summary className={styles.collapsibleSummary}>
                    <span>Risks, assumptions & unresolved items</span>
                    <span className={styles.summaryMeta}>
                      {synopsis.risks.length} risks ·{' '}
                      {synopsis.assumptions.length} assumptions ·{' '}
                      {synopsis.unresolved.length} unresolved
                    </span>
                  </summary>
                  <div className={styles.collapsibleBody}>
                    <div className={styles.detailGrid}>
                      <div>
                        <h3>Risks</h3>
                        <ul className={styles.list}>
                          {synopsis.risks.length > 0 ? (
                            synopsis.risks.map((item) => (
                              <li key={item}>{item}</li>
                            ))
                          ) : (
                            <li>None recorded.</li>
                          )}
                        </ul>
                      </div>
                      <div>
                        <h3>Assumptions</h3>
                        <ul className={styles.list}>
                          {synopsis.assumptions.length > 0 ? (
                            synopsis.assumptions.map((item) => (
                              <li key={item}>{item}</li>
                            ))
                          ) : (
                            <li>None recorded.</li>
                          )}
                        </ul>
                      </div>
                      <div>
                        <h3>Unresolved</h3>
                        <ul className={styles.list}>
                          {synopsis.unresolved.length > 0 ? (
                            synopsis.unresolved.map((item) => {
                              const parsed = parseReferenceItem(item);
                              return (
                                <li
                                  key={item}
                                  data-ref-id={parsed.code ?? undefined}
                                >
                                  {parsed.title ? (
                                    <strong>{parsed.title}: </strong>
                                  ) : null}
                                  {parsed.body || parsed.title}
                                  {parsed.code ? (
                                    <span
                                      className={styles.refBadgeInline}
                                      data-ref-id={parsed.code}
                                    >
                                      {parsed.code}
                                    </span>
                                  ) : null}
                                </li>
                              );
                            })
                          ) : (
                            <li>None recorded.</li>
                          )}
                        </ul>
                      </div>
                    </div>
                  </div>
                </details>

                {/* 6d. Turn-by-turn Audit */}
                {hasDeliberation ? (
                  <AtsBoardAuditPanel
                    project={run.project}
                    runId={run.runId}
                    {...{ 'data-testid': 'ats-board-audit' }}
                  />
                ) : null}
              </div>
            </div>
          </details>

          {leadership?.decision === 'approved' ? (
            <details
              className={styles.collapsibleSection}
              {...{ 'data-testid': 'ats-board-export-record' }}
            >
              <summary className={styles.collapsibleSummary}>
                <span>Export the full record</span>
                <span className={styles.summaryMeta}>
                  For audit and downstream work
                </span>
              </summary>
              <div
                className={`${styles.collapsibleBody} ${styles.transcriptBox}`}
              >
                <p className={styles.sectionSubtitle}>
                  The full record is written for the next workflow. It is not
                  the leadership summary.
                </p>
                <div className={styles.exportActions}>
                  <button
                    type="button"
                    className={styles.copyButton}
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
                    {copied ? 'Copied' : 'Copy full record'}
                  </button>
                  <button
                    type="button"
                    className={styles.copyButton}
                    onClick={() => {
                      const transcript = formatAtsBoardTranscript(
                        synopsis,
                        leadership
                      );
                      const url = URL.createObjectURL(
                        new Blob([transcript], { type: 'text/markdown' })
                      );
                      const link = document.createElement('a');
                      link.href = url;
                      link.download = 'ats-board-ratification.md';
                      link.click();
                      URL.revokeObjectURL(url);
                    }}
                    {...{ 'data-testid': 'ats-board-download-transcript' }}
                  >
                    Download full record
                  </button>
                </div>
                <pre
                  className={styles.transcript}
                  {...{ 'data-testid': 'ats-board-transcript' }}
                >
                  {formatAtsBoardTranscript(synopsis, leadership)}
                </pre>
              </div>
            </details>
          ) : null}
        </>
      )}
    </section>
  );
};
