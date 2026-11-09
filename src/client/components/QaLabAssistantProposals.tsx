import React from 'react';
import type {
  QaLabAssistantProposal,
  QaLabAssistantProposalKind,
  QaLabTestCase,
} from '../../shared/types/qaLab';
import { useAssistantProposalActions, useAssistantProposals } from '../hooks/useQaLab';
import { QaLabCaseDiff } from './QaLabCaseDiff';
import styles from './QaLabAssistantProposals.module.css';

const KIND_LABEL: Record<QaLabAssistantProposalKind, string> = {
  edit: 'Edit',
  add: 'Add case',
  delete: 'Delete',
  comment: 'Comment',
  regenerate: 'Regenerate',
};

/** The case with every field QaLabCaseDiff compares left empty, to show a whole case as added or removed. */
function emptied(testCase: QaLabTestCase): QaLabTestCase {
  return {
    ...testCase,
    title: '',
    persona: undefined,
    preconditions: [],
    steps: [],
    expectedResult: undefined,
    proposedTestPlan: undefined,
    proposedTestSuite: undefined,
  };
}

const ProposalChange: React.FC<{ proposal: QaLabAssistantProposal }> = ({ proposal }) => {
  const caseId = proposal.localCaseId ?? proposal.after?.id ?? proposal.id;
  switch (proposal.kind) {
    case 'edit':
      return proposal.before && proposal.after
        ? <QaLabCaseDiff localCaseId={caseId} before={proposal.before} after={proposal.after} />
        : null;
    case 'add':
      return proposal.after
        ? <QaLabCaseDiff localCaseId={caseId} before={emptied(proposal.after)} after={proposal.after} />
        : null;
    case 'delete':
      return proposal.before
        ? <QaLabCaseDiff localCaseId={caseId} before={proposal.before} after={emptied(proposal.before)} />
        : null;
    case 'comment':
      return <p className={styles.comment}>{proposal.commentBody}</p>;
    case 'regenerate':
      return (
        <p className={styles.note}>
          Rewrites this case from its open comments with the test-case skill. It runs in the background,
          and you can review and restore the result on the case.
        </p>
      );
    default: {
      const unhandled: never = proposal.kind;
      return unhandled;
    }
  }
};

interface QaLabAssistantProposalsProps {
  threadId: string;
  isRunning: boolean;
}

/** Changes Ask Apex proposed, each shown as old and new text with Confirm and Discard. */
export const QaLabAssistantProposals: React.FC<QaLabAssistantProposalsProps> = ({ threadId, isRunning }) => {
  const { data: proposals = [] } = useAssistantProposals(threadId, isRunning);
  const actions = useAssistantProposalActions(threadId);
  const busy = actions.confirm.isPending || actions.discard.isPending
    || actions.confirmAll.isPending || actions.discardAll.isPending;
  const error = [actions.confirm, actions.discard, actions.confirmAll, actions.discardAll]
    .find((mutation) => mutation.error)?.error?.message;
  const pending = proposals.filter((proposal) => proposal.status === 'pending');

  if (proposals.length === 0) return null;

  return (
    <section className={styles.proposals} aria-label="Changes to review" {...{ 'data-testid': 'qa-lab-proposals' }}>
      <header className={styles.header}>
        <span className={styles.heading}>
          {pending.length > 0
            ? `${pending.length} change${pending.length === 1 ? '' : 's'} to review`
            : 'Changes that could not be applied'}
        </span>
        {pending.length > 1 && (
          <span className={styles.headerActions}>
            <button
              type="button"
              className={styles.secondaryBtn}
              disabled={busy || isRunning}
              onClick={() => actions.discardAll.mutate()}
              {...{ 'data-testid': 'qa-lab-proposals-discard-all' }}
            >
              Discard all
            </button>
            <button
              type="button"
              className={styles.primaryBtn}
              disabled={busy || isRunning}
              onClick={() => actions.confirmAll.mutate()}
              {...{ 'data-testid': 'qa-lab-proposals-confirm-all' }}
            >
              {actions.confirmAll.isPending ? 'Applying…' : 'Confirm all'}
            </button>
          </span>
        )}
      </header>
      {error && <p className={styles.error} role="alert">{error}</p>}
      <ol className={styles.list}>
        {proposals.map((proposal) => {
          const testId = `qa-lab-proposal-${proposal.id}`;
          const title = proposal.after?.title || proposal.before?.title || '';
          return (
            <li key={proposal.id} className={styles.card} {...{ 'data-testid': testId }}>
              <div className={styles.cardHeader}>
                <span className={styles.kind}>{KIND_LABEL[proposal.kind]}</span>
                <span className={styles.caseRef}>
                  {proposal.localCaseId ?? 'New case'}
                  {title ? ` · ${title}` : ''}
                </span>
              </div>
              <p className={styles.where}>
                {proposal.workItem.id > 0 ? `#${proposal.workItem.id} ${proposal.workItem.title}` : proposal.workItem.title}
              </p>
              {proposal.reason && <p className={styles.reason}>{proposal.reason}</p>}
              <ProposalChange proposal={proposal} />
              {proposal.status === 'failed' && proposal.error && (
                <p className={styles.error} role="alert" {...{ 'data-testid': `${testId}-error` }}>{proposal.error}</p>
              )}
              <div className={styles.cardActions}>
                <button
                  type="button"
                  className={styles.secondaryBtn}
                  disabled={busy}
                  onClick={() => actions.discard.mutate(proposal.id)}
                  {...{ 'data-testid': `${testId}-discard` }}
                >
                  {proposal.status === 'failed' ? 'Dismiss' : 'Discard'}
                </button>
                <button
                  type="button"
                  className={styles.primaryBtn}
                  disabled={busy || isRunning}
                  onClick={() => actions.confirm.mutate(proposal.id)}
                  {...{ 'data-testid': `${testId}-confirm` }}
                >
                  {proposal.status === 'failed' ? 'Try again' : 'Confirm'}
                </button>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
};
