import React, { useMemo, useState } from 'react';
import type {
  QaAdoSuiteSelection,
  QaAdoTestPlanOption,
  QaLabNewPlacement,
  QaLabNewPlacementApproval,
  QaLabNewPlacementSuiteType,
} from '../../shared/types/qaLab';
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
  /** An existing Test Case in no Test Plan; publish only adds it to the suite. */
  existingAdoTestCaseId?: number;
}

/** A needs-update case whose suggestion can be applied to its existing Test Case. */
export interface QaLabPublishUpdateCase {
  id: string;
  title: string;
  adoTestCaseId: number;
  reason: string;
}

/** Proposals QA approved and the cases that go to each. */
export interface QaLabPublishNewPlacements {
  newPlacements: QaLabNewPlacementApproval[];
  newPlacementSelections: Record<string, string>;
}

interface QaLabPublishReviewProps {
  suiteId: string;
  cases: QaLabPublishReviewCase[];
  updates?: QaLabPublishUpdateCase[];
  /** Plans and suites the skill proposed creating. */
  newPlacements?: QaLabNewPlacement[];
  requireSuite: boolean;
  isPublishing: boolean;
  onCancel: () => void;
  onPublish: (
    selections: Record<string, QaAdoSuiteSelection>,
    updateLocalCaseIds: string[],
    created: QaLabPublishNewPlacements,
  ) => void;
}

interface RowSelection {
  planId: number | null;
  suiteId: number | null;
  /** The case goes to this proposal once QA approves it. */
  newKey?: string;
}

interface ProposalEdit {
  approved: boolean;
  testPlan: string;
  testSuite: string;
}

/** A plan or suite QA added by hand; `existingPlanId` null means a new plan named `testPlan`. */
interface ManualPlacement {
  key: string;
  approved: boolean;
  existingPlanId: number | null;
  testPlan: string;
  suiteType: QaLabNewPlacementSuiteType;
  testSuite: string;
}

/** A skill proposal or a hand-added row, with QA's current edits applied. */
interface PlacementDraft {
  key: string;
  approved: boolean;
  testPlan: string;
  testSuite: string;
  createPlan: boolean;
  suiteType: QaLabNewPlacementSuiteType;
}

const EMPTY_ROW: RowSelection = { planId: null, suiteId: null };
const NEW_OPTION_PREFIX = 'new:';

function draftReady(draft: PlacementDraft): boolean {
  if (!draft.testPlan.trim()) return false;
  return draft.suiteType === 'requirement' || draft.createPlan || draft.testSuite.trim() !== '';
}

function draftSuiteLabel(draft: PlacementDraft): string {
  if (draft.suiteType === 'requirement') return 'Requirement suite per PBI';
  return draft.testSuite.trim() || 'Plan root';
}

function draftLabel(draft: PlacementDraft): string {
  return `${draft.testPlan.trim() || 'Unnamed plan'} / ${draftSuiteLabel(draft)} (new)`;
}

function normalizeName(value: string): string {
  return value.split('>').map((part) => part.trim().toLowerCase()).filter(Boolean).join(' > ');
}

function proposalFor(
  newPlacements: QaLabNewPlacement[],
  entry: QaLabPublishReviewCase,
): QaLabNewPlacement | undefined {
  if (!entry.proposedTestPlan) return undefined;
  const plan = normalizeName(entry.proposedTestPlan);
  const suite = normalizeName(entry.proposedTestSuite ?? '');
  return newPlacements.find((proposal) =>
    normalizeName(proposal.testPlan) === plan
    && (proposal.suiteType === 'requirement' || normalizeName(proposal.testSuite ?? '') === suite));
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
  updates = [],
  newPlacements = [],
  requireSuite,
  isPublishing,
  onCancel,
  onPublish,
}) => {
  const plansQuery = useAdoTestPlanOptions(suiteId, true);
  const [chosenUpdates, setChosenUpdates] = useState<Set<string>>(new Set());
  const toggleUpdate = (caseId: string) =>
    setChosenUpdates((previous) => {
      const next = new Set(previous);
      if (next.has(caseId)) next.delete(caseId);
      else next.add(caseId);
      return next;
    });
  const updateIds = updates.filter((entry) => chosenUpdates.has(entry.id)).map((entry) => entry.id);
  const plans = useMemo(() => plansQuery.data?.plans ?? [], [plansQuery.data?.plans]);
  const [rows, setRows] = useState<Record<string, RowSelection>>({});
  const [bulk, setBulk] = useState<RowSelection>(EMPTY_ROW);
  const proposed = useMemo(
    () => Object.fromEntries(cases.map((entry) => {
      const match = matchProposal(plans, entry);
      const proposal = match.suiteId === null ? proposalFor(newPlacements, entry) : undefined;
      return [entry.id, proposal ? { ...EMPTY_ROW, newKey: proposal.key } : match];
    })),
    [plans, cases, newPlacements],
  );
  const [edits, setEdits] = useState<Record<string, ProposalEdit>>({});
  const editFor = (proposal: QaLabNewPlacement): ProposalEdit => edits[proposal.key] ?? {
    approved: false,
    testPlan: proposal.testPlan,
    testSuite: proposal.testSuite ?? '',
  };
  const setEdit = (proposal: QaLabNewPlacement, next: Partial<ProposalEdit>) =>
    setEdits((previous) => ({ ...previous, [proposal.key]: { ...editFor(proposal), ...next } }));
  const [manual, setManual] = useState<ManualPlacement[]>([]);
  const [manualCount, setManualCount] = useState(0);

  const planById = useMemo(() => new Map(plans.map((plan) => [plan.id, plan])), [plans]);
  const planNames = useMemo(() => new Set(plans.map((plan) => normalizeName(plan.name))), [plans]);
  const rowFor = (caseId: string): RowSelection => rows[caseId] ?? proposed[caseId] ?? EMPTY_ROW;
  const setRow = (caseId: string, next: RowSelection) =>
    setRows((previous) => ({ ...previous, [caseId]: next }));
  const pointsAt = (key: string) => (caseId: string): boolean => {
    const row = rowFor(caseId);
    return row.suiteId === null && row.newKey === key;
  };

  /** Listed while a case points at it now or did when the window opened. */
  const usedProposals = newPlacements.filter((proposal) =>
    cases.some((entry) => proposed[entry.id]?.newKey === proposal.key || pointsAt(proposal.key)(entry.id)));
  const skillDraft = (proposal: QaLabNewPlacement): PlacementDraft => ({
    ...editFor(proposal),
    key: proposal.key,
    createPlan: proposal.createPlan,
    suiteType: proposal.suiteType,
  });
  const manualDraft = (entry: ManualPlacement): PlacementDraft => ({
    key: entry.key,
    approved: entry.approved,
    testPlan: entry.existingPlanId === null ? entry.testPlan : planById.get(entry.existingPlanId)?.name ?? '',
    testSuite: entry.testSuite,
    createPlan: entry.existingPlanId === null,
    suiteType: entry.suiteType,
  });
  const listedDrafts = [...usedProposals.map(skillDraft), ...manual.map(manualDraft)];
  const draftFor = (key: string | undefined): PlacementDraft | undefined => {
    if (key === undefined) return undefined;
    const proposal = newPlacements.find((entry) => entry.key === key);
    if (proposal) return skillDraft(proposal);
    const added = manual.find((entry) => entry.key === key);
    return added ? manualDraft(added) : undefined;
  };
  const isApproved = (key: string | undefined): boolean => {
    const draft = draftFor(key);
    return draft !== undefined && draft.approved && draftReady(draft);
  };

  const addManual = () => {
    setManual((previous) => [...previous, {
      key: `manual-${manualCount + 1}`,
      approved: true,
      existingPlanId: null,
      testPlan: '',
      suiteType: 'requirement',
      testSuite: '',
    }]);
    setManualCount((count) => count + 1);
  };
  const updateManual = (key: string, next: Partial<ManualPlacement>) =>
    setManual((previous) => previous.map((entry) => (entry.key === key ? { ...entry, ...next } : entry)));
  const removeManual = (key: string) => {
    setManual((previous) => previous.filter((entry) => entry.key !== key));
    setRows((previous) => Object.fromEntries(cases.map((entry) => {
      const row = previous[entry.id] ?? proposed[entry.id] ?? EMPTY_ROW;
      return [entry.id, row.newKey === key ? EMPTY_ROW : row];
    })));
    if (bulk.newKey === key) setBulk(EMPTY_ROW);
  };
  /** A plan alone keeps each row's suite when it is in that plan; a suite applies to every row. */
  const setAll = (next: RowSelection) => {
    setBulk(next);
    setRows(Object.fromEntries(cases.map((entry) => {
      if (next.suiteId !== null || next.planId === null) return [entry.id, next];
      const current = rowFor(entry.id);
      return [entry.id, current.planId === next.planId ? current : { planId: next.planId, suiteId: null }];
    })));
  };

  const missingCount = cases.filter((entry) => {
    const row = rowFor(entry.id);
    return row.suiteId === null && !isApproved(row.newKey);
  }).length;
  const canChoose = !plansQuery.isLoading && !plansQuery.isError && cases.length > 0;
  const actionCount = cases.length + updateIds.length;
  const canPublish = !isPublishing && !plansQuery.isLoading && actionCount > 0
    && (!requireSuite || missingCount === 0);

  const handlePublish = () => {
    const selections: Record<string, QaAdoSuiteSelection> = {};
    const newPlacementSelections: Record<string, string> = {};
    for (const entry of cases) {
      const row = rowFor(entry.id);
      if (row.planId !== null && row.suiteId !== null) {
        const suite = planById.get(row.planId)?.suites.find((option) => option.id === row.suiteId);
        selections[entry.id] = {
          planId: row.planId,
          suiteId: row.suiteId,
          ...(suite?.requirementId !== undefined ? { requirement: true } : {}),
        };
      } else if (row.newKey !== undefined && isApproved(row.newKey)) {
        newPlacementSelections[entry.id] = row.newKey;
      }
    }
    const approved = listedDrafts
      .filter((draft) => isApproved(draft.key))
      .map((draft): QaLabNewPlacementApproval => ({
        key: draft.key,
        testPlan: draft.testPlan.trim(),
        ...(draft.suiteType === 'static' && draft.testSuite.trim() ? { testSuite: draft.testSuite.trim() } : {}),
        createPlan: draft.createPlan,
        suiteType: draft.suiteType,
      }));
    onPublish(selections, updateIds, { newPlacements: approved, newPlacementSelections });
  };

  const renderSelects = (
    row: RowSelection,
    onChange: (next: RowSelection) => void,
    testIdPrefix: string,
  ) => {
    const plan = row.planId !== null ? planById.get(row.planId) : undefined;
    const draft = row.suiteId === null ? draftFor(row.newKey) : undefined;
    return (
      <div className={styles.selects}>
        <select
          className={styles.select}
          value={draft ? `${NEW_OPTION_PREFIX}${draft.key}` : row.planId ?? ''}
          aria-label="Test Plan"
          onChange={(event) => {
            const { value } = event.target;
            if (value.startsWith(NEW_OPTION_PREFIX)) {
              onChange({ planId: null, suiteId: null, newKey: value.slice(NEW_OPTION_PREFIX.length) });
              return;
            }
            onChange({ planId: value ? Number(value) : null, suiteId: null });
          }}
          {...{ 'data-testid': `${testIdPrefix}-plan` }}
        >
          <option value="">Choose a Test Plan</option>
          {plans.map((option) => (
            <option key={option.id} value={option.id}>{option.name}</option>
          ))}
          {listedDrafts.length > 0 && (
            <optgroup label="New in Azure DevOps">
              {listedDrafts.map((entry) => (
                <option key={entry.key} value={`${NEW_OPTION_PREFIX}${entry.key}`}>{draftLabel(entry)}</option>
              ))}
            </optgroup>
          )}
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
          <option value="">{draft ? draftSuiteLabel(draft) : 'Choose a suite'}</option>
          {(plan?.suites ?? []).map((option) => (
            <option key={option.id} value={option.id}>
              {suiteLabel(option.path)}{option.requirementId !== undefined ? ' (requirement)' : ''}
            </option>
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
      {!plansQuery.isLoading && !plansQuery.isError && plans.length === 0 && cases.length > 0 && (
        <p className={styles.status}>No active Test Plans were found in this project.</p>
      )}

      {updates.length > 0 && (
        <div className={styles.updates}>
          <span className={styles.bulkLabel}>Update existing Test Cases</span>
          <ul className={styles.list}>
            {updates.map((entry) => (
              <li key={entry.id} className={styles.row}>
                <label className={styles.updateLabel}>
                  <input
                    type="checkbox"
                    checked={chosenUpdates.has(entry.id)}
                    onChange={() => toggleUpdate(entry.id)}
                    {...{ 'data-testid': `qa-lab-publish-review-update-${entry.id}` }}
                  />
                  <span className={styles.caseText}>
                    <span className={styles.caseTitle}>Update existing #{entry.adoTestCaseId}</span>
                    <span className={styles.caseMeta}>{entry.id} · {entry.title}</span>
                    {entry.reason && <span className={styles.caseReason}>{entry.reason}</span>}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}

      {canChoose && (
        <div className={styles.updates} {...{ 'data-testid': 'qa-lab-publish-review-new-placements' }}>
          <span className={styles.bulkLabel}>Create in Azure DevOps</span>
          {listedDrafts.length > 0 && <ul className={styles.list}>
            {usedProposals.map((proposal, index) => {
              const edit = editFor(proposal);
              const caseCount = cases.filter((entry) => pointsAt(proposal.key)(entry.id)).length;
              return (
                <li key={proposal.key} className={styles.row}>
                  <label className={styles.updateLabel}>
                    <input
                      type="checkbox"
                      checked={edit.approved}
                      onChange={() => setEdit(proposal, { approved: !edit.approved })}
                      aria-label={`Create ${proposal.testPlan}`}
                      {...{ 'data-testid': `qa-lab-publish-review-create-${index}` }}
                    />
                    <span className={styles.caseText}>
                      <span className={styles.caseTitle}>
                        {proposal.createPlan ? 'New Test Plan' : 'New suite in an existing plan'}
                        {proposal.suiteType === 'requirement' ? ' with a requirement suite per PBI' : ''}
                      </span>
                      <span className={styles.caseMeta}>
                        {caseCount} {caseCount === 1 ? 'case goes' : 'cases go'} here
                      </span>
                      {proposal.reason && <span className={styles.caseReason}>{proposal.reason}</span>}
                    </span>
                  </label>
                  <div className={styles.selects}>
                    <input
                      className={styles.select}
                      value={edit.testPlan}
                      aria-label="New Test Plan name"
                      disabled={!proposal.createPlan}
                      onChange={(event) => setEdit(proposal, { testPlan: event.target.value })}
                      {...{ 'data-testid': `qa-lab-publish-review-create-${index}-plan` }}
                    />
                    {proposal.suiteType === 'static' && (
                      <input
                        className={styles.select}
                        value={edit.testSuite}
                        aria-label="New suite path"
                        placeholder="Plan root"
                        onChange={(event) => setEdit(proposal, { testSuite: event.target.value })}
                        {...{ 'data-testid': `qa-lab-publish-review-create-${index}-suite` }}
                      />
                    )}
                  </div>
                  {proposal.createPlan && planNames.has(normalizeName(edit.testPlan)) && (
                    <span className={styles.caseMeta}>Already exists; Apex will use it</span>
                  )}
                </li>
              );
            })}
            {manual.map((entry, index) => {
              const draft = manualDraft(entry);
              const caseCount = cases.filter((item) => pointsAt(entry.key)(item.id)).length;
              const prefix = `qa-lab-publish-review-manual-${index}`;
              return (
                <li key={entry.key} className={styles.row}>
                  <label className={styles.updateLabel}>
                    <input
                      type="checkbox"
                      checked={entry.approved}
                      onChange={() => updateManual(entry.key, { approved: !entry.approved })}
                      aria-label={`Create ${draftLabel(draft)}`}
                      {...{ 'data-testid': prefix }}
                    />
                    <span className={styles.caseText}>
                      <span className={styles.caseTitle}>
                        {draft.createPlan ? 'New Test Plan' : 'New suite in an existing plan'} (added by QA)
                      </span>
                      <span className={styles.caseMeta}>
                        {caseCount} {caseCount === 1 ? 'case goes' : 'cases go'} here
                        {!draftReady(draft) && ' · needs a plan name and suite'}
                      </span>
                    </span>
                  </label>
                  <div className={styles.selects}>
                    <select
                      className={styles.select}
                      value={entry.existingPlanId ?? ''}
                      aria-label="Plan to create in"
                      onChange={(event) => updateManual(entry.key, {
                        existingPlanId: event.target.value ? Number(event.target.value) : null,
                      })}
                      {...{ 'data-testid': `${prefix}-plan-source` }}
                    >
                      <option value="">New Test Plan</option>
                      {plans.map((option) => (
                        <option key={option.id} value={option.id}>{option.name}</option>
                      ))}
                    </select>
                    {entry.existingPlanId === null && (
                      <input
                        className={styles.select}
                        value={entry.testPlan}
                        aria-label="New Test Plan name"
                        placeholder="Test Plan name"
                        onChange={(event) => updateManual(entry.key, { testPlan: event.target.value })}
                        {...{ 'data-testid': `${prefix}-plan` }}
                      />
                    )}
                    <select
                      className={styles.select}
                      value={entry.suiteType}
                      aria-label="Suite type"
                      onChange={(event) => updateManual(entry.key, {
                        suiteType: event.target.value === 'static' ? 'static' : 'requirement',
                      })}
                      {...{ 'data-testid': `${prefix}-type` }}
                    >
                      <option value="requirement">Requirement suite per PBI</option>
                      <option value="static">Static suite</option>
                    </select>
                    {entry.suiteType === 'static' && (
                      <input
                        className={styles.select}
                        value={entry.testSuite}
                        aria-label="New suite path"
                        placeholder={draft.createPlan ? 'Plan root' : 'Suite > Sub-suite'}
                        onChange={(event) => updateManual(entry.key, { testSuite: event.target.value })}
                        {...{ 'data-testid': `${prefix}-suite` }}
                      />
                    )}
                    <button
                      type="button"
                      className={styles.secondaryBtn}
                      onClick={() => removeManual(entry.key)}
                      aria-label={`Remove ${draftLabel(draft)}`}
                      {...{ 'data-testid': `${prefix}-remove` }}
                    >
                      Remove
                    </button>
                  </div>
                  {draft.createPlan && planNames.has(normalizeName(entry.testPlan)) && (
                    <span className={styles.caseMeta}>Already exists; Apex will use it</span>
                  )}
                </li>
              );
            })}
          </ul>}
          <div>
            <button
              type="button"
              className={styles.secondaryBtn}
              onClick={addManual}
              {...{ 'data-testid': 'qa-lab-publish-review-add-placement' }}
            >
              Add a Test Plan or suite
            </button>
          </div>
        </div>
      )}

      {canChoose && (
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
              const proposalMissed = proposal !== null && proposed[entry.id]?.suiteId === null
                && proposed[entry.id]?.newKey === undefined;
              const awaitingCreate = row.newKey !== undefined && row.suiteId === null;
              return (
                <li key={entry.id} className={styles.row}>
                  <div className={styles.caseText}>
                    <span className={styles.caseTitle}>{entry.title}</span>
                    <span className={styles.caseMeta}>
                      {entry.id}
                      {entry.existingAdoTestCaseId !== undefined && ` · Existing #${entry.existingAdoTestCaseId}, added to the suite only`}
                      {proposal && ` · Proposed: ${proposal}`}
                      {proposalMissed && ' (not found)'}
                      {awaitingCreate && (isApproved(row.newKey) ? ' (will be created)' : ' (new; approve it above)')}
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
        {requireSuite && missingCount > 0 && canChoose && (
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
          {isPublishing ? 'Publishing…' : `Publish ${actionCount} to ADO`}
        </button>
      </div>
    </section>
  );
};
