import React, { useMemo } from 'react';
import type {
  BuildVerificationKind,
  BuildVerificationStatus,
} from '../../shared/types/build';
import type {
  BuildEvidenceSlot,
  BuildEvidenceSummary,
  BuildVerificationRowView,
} from '../../shared/types/buildView';
import type { BuildEvidenceDialogTarget } from './BuildEvidenceDialog';
import styles from './BuildVerificationTab.module.css';

interface BuildVerificationMatrixProps {
  revisionNumber: number;
  rows: BuildVerificationRowView[];
  isLoading?: boolean;
  onOpenEvidence: (target: BuildEvidenceDialogTarget, trigger: HTMLButtonElement) => void;
}

const KIND_ORDER: Record<BuildVerificationKind, number> = {
  ac: 0,
  dod: 1,
  br: 2,
  nfr: 3,
  risk_decision: 4,
};

export function verificationKindLabel(kind: BuildVerificationKind): string {
  switch (kind) {
    case 'ac':
      return 'Acceptance criterion';
    case 'dod':
      return 'Definition of done';
    case 'br':
      return 'Business rule';
    case 'nfr':
      return 'Non-functional requirement';
    case 'risk_decision':
      return 'Risk decision';
    default: {
      const unhandled: never = kind;
      return unhandled;
    }
  }
}

export function verificationStatusLabel(status: BuildVerificationStatus): string {
  switch (status) {
    case 'pass':
      return 'Passed';
    case 'fail':
      return 'Failing';
    case 'deferred':
      return 'Deferred';
    case 'retired':
      return 'Retired';
    case 'pending':
      return 'Pending';
    default: {
      const unhandled: never = status;
      return unhandled;
    }
  }
}

function statusClassName(status: BuildVerificationStatus): string {
  if (status === 'pass') return styles.statusPass;
  if (status === 'fail') return styles.statusFail;
  return styles.statusNeutral;
}

function parseIdNumber(requirementId: string): number {
  const match = /-(\d+)$/.exec(requirementId);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

export function sortVerificationRows(rows: BuildVerificationRowView[]): BuildVerificationRowView[] {
  return [...rows].sort((a, b) => {
    const aRetired = a.status === 'retired' ? 1 : 0;
    const bRetired = b.status === 'retired' ? 1 : 0;
    if (aRetired !== bRetired) return aRetired - bRetired;

    const kindDiff = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    if (kindDiff !== 0) return kindDiff;

    const numDiff = parseIdNumber(a.requirementId) - parseIdNumber(b.requirementId);
    if (numDiff !== 0) return numDiff;

    return a.requirementId.localeCompare(b.requirementId);
  });
}

interface EvidenceCellProps {
  row: BuildVerificationRowView;
  slot: BuildEvidenceSlot;
  evidence: BuildEvidenceSummary | null;
  onOpenEvidence: (target: BuildEvidenceDialogTarget, trigger: HTMLButtonElement) => void;
}

const EvidenceCell: React.FC<EvidenceCellProps> = ({
  row,
  slot,
  evidence,
  onOpenEvidence,
}) => {
  if (evidence) {
    const testId =
      slot === 'red'
        ? `build-verification-red-evidence-${row.requirementId}`
        : `build-verification-green-evidence-${row.requirementId}`;
    return (
      <div className={styles.evidenceCell}>
        <button
          type="button"
          className={styles.button}
          aria-label={`View ${slot} evidence for ${row.requirementId}`}
          onClick={(event) => {
            onOpenEvidence(
              {
                rowId: row.id,
                requirementId: row.requirementId,
                slot,
                commit: evidence.commit,
                command: evidence.command,
                exitCode: evidence.exitCode,
                recordedAt: evidence.recordedAt,
              },
              event.currentTarget,
            );
          }}
          {...{ 'data-testid': testId }}
        >
          View
        </button>
        <span className={styles.commitSha}>{evidence.commit.slice(0, 7)}</span>
      </div>
    );
  }

  if (row.status === 'fail') {
    return <span className={styles.missingText}>Missing</span>;
  }

  return <span>—</span>;
};

export const BuildVerificationMatrix: React.FC<BuildVerificationMatrixProps> = ({
  revisionNumber,
  rows,
  isLoading = false,
  onOpenEvidence,
}) => {
  const sortedRows = useMemo(() => sortVerificationRows(rows), [rows]);

  return (
    <div className={styles.tableWrapper}>
      <table
        className={styles.table}
        {...{ 'data-testid': 'build-verification-matrix' }}
      >
        <caption className={styles.caption}>
          {`Verification matrix for revision ${revisionNumber}`}
        </caption>
        <thead>
          <tr>
            <th scope="col">ID</th>
            <th scope="col">Kind</th>
            <th scope="col">Requirement</th>
            <th scope="col">Tier</th>
            <th scope="col">Status</th>
            <th scope="col">Test reference</th>
            <th scope="col">Red evidence</th>
            <th scope="col">Green evidence</th>
          </tr>
        </thead>
        {isLoading ? (
          <tbody {...{ 'data-testid': 'build-verification-loading' }}>
            {[0, 1, 2].map((index) => (
              <tr key={index}>
                <td colSpan={8}>
                  <div className={styles.skeletonCell} />
                </td>
              </tr>
            ))}
          </tbody>
        ) : (
          <tbody>
            {sortedRows.map((row) => (
              <tr
                key={row.id}
                className={row.status === 'retired' ? styles.rowRetired : undefined}
                {...{ 'data-testid': `build-verification-row-${row.requirementId}` }}
              >
                <th scope="row" className={styles.rowId}>
                  {row.requirementId}
                </th>
                <td>{verificationKindLabel(row.kind)}</td>
                <td>{row.requirementText}</td>
                <td>{row.tier ?? '—'}</td>
                <td>
                  <span
                    className={statusClassName(row.status)}
                    {...{ 'data-testid': `build-verification-status-${row.requirementId}` }}
                  >
                    {verificationStatusLabel(row.status)}
                  </span>
                  {row.status === 'deferred' && row.deferralReason && (
                    <div
                      className={styles.deferralReason}
                      {...{
                        'data-testid': `build-verification-deferral-reason-${row.requirementId}`,
                      }}
                    >
                      {row.deferralReason}
                    </div>
                  )}
                </td>
                <td>
                  {row.testReferences.length > 0 ? (
                    <ul className={styles.testRefList}>
                      {row.testReferences.map((ref, idx) => (
                        <li key={`${ref.file}-${idx}`}>
                          <div>{ref.name}</div>
                          <div className={styles.testRefFile}>{ref.file}</div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    '—'
                  )}
                </td>
                <td>
                  <EvidenceCell
                    row={row}
                    slot="red"
                    evidence={row.red}
                    onOpenEvidence={onOpenEvidence}
                  />
                </td>
                <td>
                  <EvidenceCell
                    row={row}
                    slot="green"
                    evidence={row.green}
                    onOpenEvidence={onOpenEvidence}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        )}
      </table>
    </div>
  );
};
