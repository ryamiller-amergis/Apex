import React, { useMemo, useState } from 'react';
import type { QaAdoSuiteSelection, QaAdoTestPlanOption } from '../../shared/types/qaLab';
import { useAdoTestPlanOptions } from '../hooks/useQaLab';
import styles from './QaLabPublishReview.module.css';

export interface QaLabPublishReviewCase {
  id: string;
  title: string;
  proposedTestPlan?: string;
  proposedTestSuite?: string;
  placementReason?: string;
  /** Set when the case was created earlier but never reached its suite. */
  suiteError?: string;
}

interface QaLabPublishReviewProps {
  suiteId: string;
  cases: QaLabPublishReviewCase[];
  requireSuite: boolean;
  isPublishing: boolean;
  onCancel: () => void;
  onPublish: (selections: Record<string, QaAdoSuiteSelection>) => void;
}

interface RowSelection {
  planId: number | null;
  suiteId: number | null;
}

const EMPTY_ROW: RowSelection = { planId: null, suiteId: null };

function normalizeName(value: string): string {
  return value.split('>').map((part) => part.trim().toLowerCase()).filter(Boolean).join(' > ');
}

function matchProposal(plans: QaAdoTestPlanOption[], entry: QaLabPublishReviewCase): RowSelection {
  if (!entry.proposedTestPlan) return EMPTY_ROW;
  const plan = plans.find((option) => normalizeName(option.name) === normalizeName(entry.proposedTestPlan ?? ''));
  if (!plan) return EMPTY_ROW;
  const suitePath = normalizeName(entry.proposedTestSuite ?? '');
  const suite = plan.suites.find((option) => normalizeName(option.path) === suitePath);
  return { planId: plan.id, suiteId: suite?.id ?? null };
}

function suiteLabel(path: string): string {
  return path || 'Plan root';
}

export const QaLabPublishReview: React.FC<QaLabPublishReviewProps> = ({
  suiteId,
  cases,
  requireSuite,
  isPublishing,
  onCancel,
  onPublish,
}) => {
  const plansQuery = useAdoTestPlanOptions(suiteId, true);
  const plans = useMemo(() => plansQuery.data?.plans ?? [], [plansQuery.data?.plans]);
  const [rows, setRows] = useState<Record<string, RowSelection>>({});
  const [bulk, setBulk] = useState<RowSelection>(EMPTY_ROW);
  const proposed = useMemo(
    () => Object.fromEntries(cases.map((entry) => [entry.id, matchProposal(plans, entry)])),
    [plans, cases],
  );

  const planById = useMemo(() => new Map(plans.map((plan) => [plan.id, plan])), [plans]);
  const rowFor = (caseId: string): RowSelection => rows[caseId] ?? proposed[caseId] ?? EMPTY_ROW;
  const setRow = (caseId: string, next: RowSelection) =>
    setRows((previous) => ({ ...previous, [caseId]: next }));
  /** A plan alone keeps each row's suite when it is in that plan; a suite applies to every row. */
  const setAll = (next: RowSelection) => {
    setBulk(next);
    setRows(Object.fromEntries(cases.map((entry) => {
      if (next.suiteId !== null || next.planId === null) return [entry.id, next];
      const current = rowFor(entry.id);
      return [entry.id, current.planId === next.planId ? current : { planId: next.planId, suiteId: null }];
    })));
  };

  const missingCount = cases.filter((entry) => rowFor(entry.id).suiteId === null).length;
  const canPublish = !isPublishing && !plansQuery.isLoading && (!requireSuite || missingCount === 0);

  const handlePublish = () => {
    const selections: Record<string, QaAdoSuiteSelection> = {};
    for (const entry of cases) {
      const row = rowFor(entry.id);
      if (row.planId !== null && row.suiteId !== null) {
        selections[entry.id] = { planId: row.planId, suiteId: row.suiteId };
      }
    }
    onPublish(selections);
  };

  const renderSelects = (
    row: RowSelection,
    onChange: (next: RowSelection) => void,
    testIdPrefix: string,
  ) => {
    const plan = row.planId !== null ? planById.get(row.planId) : undefined;
    return (
      <div className={styles.selects}>
        <select
          className={styles.select}
          value={row.planId ?? ''}
          aria-label="Test Plan"
          onChange={(event) => {
            const planId = event.target.value ? Number(event.target.value) : null;
            onChange({ planId, suiteId: null });
          }}
          {...{ 'data-testid': `${testIdPrefix}-plan` }}
        >
          <option value="">Choose a Test Plan</option>
          {plans.map((option) => (
            <option key={option.id} value={option.id}>{option.name}</option>
          ))}
        </select>
        <select
          className={styles.select}
          value={row.suiteId ?? ''}
          aria-label="Test Suite"
          disabled={!plan}
          onChange={(event) =>
            onChange({ planId: row.planId, suiteId: event.target.value ? Number(event.target.value) : null })
          }
          {...{ 'data-testid': `${testIdPrefix}-suite` }}
        >
          <option value="">Choose a suite</option>
          {(plan?.suites ?? []).map((option) => (
            <option key={option.id} value={option.id}>{suiteLabel(option.path)}</option>
          ))}
        </select>
      </div>
    );
  };

  return (
    <section className={styles.panel} aria-label="Confirm Test Plan placement" {...{ 'data-testid': 'qa-lab-publish-review' }}>
      <div className={styles.header}>
        <h3 className={styles.title}>Confirm where these cases go</h3>
        <span className={styles.hint}>
          The skill proposed a Test Plan and suite for each case. Check them before publishing.
          {requireSuite ? ' This project requires a suite for every case.' : ' Cases without a suite are only linked to their work item.'}
        </span>
      </div>

      {plansQuery.isLoading && <p className={styles.status}>Loading Test Plans…</p>}
      {plansQuery.isError && (
        <p className={`${styles.status} ${styles.statusError}`} {...{ 'data-testid': 'qa-lab-publish-review-error' }}>
          {plansQuery.error instanceof Error ? plansQuery.error.message : 'Could not load Test Plans.'}
        </p>
      )}
      {!plansQuery.isLoading && !plansQuery.isError && plans.length === 0 && (
        <p className={styles.status}>No active Test Plans were found in this project.</p>
      )}

      {plans.length > 0 && (
        <>
          <div className={styles.bulkRow}>
            <span className={styles.bulkLabel}>Set all</span>
            {renderSelects(bulk, setAll, 'qa-lab-publish-review-all')}
          </div>
          <ul className={styles.list}>
            {cases.map((entry) => {
              const row = rowFor(entry.id);
              const proposal = entry.proposedTestPlan
                ? `${entry.proposedTestPlan}${entry.proposedTestSuite ? ` / ${entry.proposedTestSuite}` : ''}`
                : null;
              const proposalMissed = proposal !== null && proposed[entry.id]?.suiteId === null;
              return (
                <li key={entry.id} className={styles.row}>
                  <div className={styles.caseText}>
                    <span className={styles.caseTitle}>{entry.title}</span>
                    <span className={styles.caseMeta}>
                      {entry.id}
                      {proposal && ` · Proposed: ${proposal}`}
                      {proposalMissed && ' (not found)'}
                    </span>
                    {proposal && entry.placementReason && (
                      <span className={styles.caseReason}>{entry.placementReason}</span>
                    )}
                    {entry.suiteError && (
                      <span className={styles.caseError}>Created earlier but not in a suite: {entry.suiteError}</span>
                    )}
                  </div>
                  {renderSelects(row, (next) => setRow(entry.id, next), `qa-lab-publish-review-${entry.id}`)}
                </li>
              );
            })}
          </ul>
        </>
      )}

      <div className={styles.actions}>
        {requireSuite && missingCount > 0 && plans.length > 0 && (
          <span className={styles.missing}>{missingCount} {missingCount === 1 ? 'case needs' : 'cases need'} a suite</span>
        )}
        <button
          type="button"
          className={styles.secondaryBtn}
          onClick={onCancel}
          {...{ 'data-testid': 'qa-lab-publish-review-cancel' }}
        >
          Cancel
        </button>
        <button
          type="button"
          className={styles.primaryBtn}
          onClick={handlePublish}
          disabled={!canPublish}
          {...{ 'data-testid': 'qa-lab-publish-review-confirm' }}
        >
          {isPublishing ? 'Publishing…' : `Publish ${cases.length} to ADO`}
        </button>
      </div>
    </section>
  );
};
