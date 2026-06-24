import React from 'react';
import type { ApproverResponseStatus } from '../../shared/types/approvals';
import styles from './ReviewerApprovalChecklist.module.css';

export interface ReviewerApprovalRow {
  name: string;
  status: ApproverResponseStatus;
  respondedAt?: string | null;
}

export interface ReviewerApprovalGroup {
  label: string;
  /** Informational groups (e.g. Design Doc) show hollow markers and a hint — status is tracked downstream. */
  informational?: boolean;
  /** Subtitle shown below the group label (e.g. "1 of 3 required" or "All required"). */
  subtitle?: string;
  rows: ReviewerApprovalRow[];
}

interface ReviewerApprovalChecklistProps {
  groups: ReviewerApprovalGroup[];
}

function formatRespondedDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

const ApprovedIcon: React.FC = () => (
  <svg
    className={`${styles.statusIcon} ${styles.statusApproved}`}
    viewBox="0 0 16 16"
    aria-hidden="true"
  >
    <rect x="1" y="1" width="14" height="14" rx="3" fill="currentColor" />
    <path
      d="M4.5 8.2L7 10.5 11.5 5.5"
      fill="none"
      stroke="var(--bg-primary)"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const PendingIcon: React.FC = () => (
  <svg
    className={`${styles.statusIcon} ${styles.statusPending}`}
    viewBox="0 0 16 16"
    aria-hidden="true"
  >
    <rect
      x="1.5"
      y="1.5"
      width="13"
      height="13"
      rx="3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
    />
  </svg>
);

const RevisionIcon: React.FC = () => (
  <svg
    className={`${styles.statusIcon} ${styles.statusRevision}`}
    viewBox="0 0 16 16"
    aria-hidden="true"
  >
    <rect
      x="1.5"
      y="1.5"
      width="13"
      height="13"
      rx="3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
    />
    <path
      d="M10.5 6H6.2l1.4-1.4M5.5 10h4.3l-1.4 1.4"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const RowStatusIcon: React.FC<{ status: ApproverResponseStatus; informational?: boolean }> = ({
  status,
  informational = false,
}) => {
  if (informational) return <PendingIcon />;
  if (status === 'approved') return <ApprovedIcon />;
  if (status === 'revision_requested') return <RevisionIcon />;
  return <PendingIcon />;
};

export const ReviewerApprovalChecklist: React.FC<ReviewerApprovalChecklistProps> = ({ groups }) => {
  const visibleGroups = groups.filter((group) => group.rows.length > 0);
  if (visibleGroups.length === 0) return null;

  return (
    <div className={styles.checklist} data-testid="reviewer-approval-checklist">
      {visibleGroups.map((group) => (
        <div key={group.label} className={styles.group}>
          <div className={styles.groupHeader}>
            <span className={styles.groupLabel}>{group.label}</span>
            {group.subtitle && (
              <span className={styles.groupSubtitle}>{group.subtitle}</span>
            )}
          </div>
          <ul className={styles.rows}>
            {group.rows.map((row, index) => (
              <li key={`${group.label}-${row.name}-${index}`} className={styles.row}>
                <RowStatusIcon status={row.status} informational={group.informational} />
                <span className={styles.rowName} data-status={row.status}>
                  {row.name}
                </span>
                {!group.informational && row.status === 'approved' && row.respondedAt && (
                  <span className={styles.rowDate}>{formatRespondedDate(row.respondedAt)}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
};
