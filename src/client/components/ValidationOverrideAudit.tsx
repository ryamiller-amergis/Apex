import React from 'react';
import type { ValidationOverrideAuditEntry } from '../../shared/utils/validationOverride';
import { formatOverrideTimestamp, resolveOverrideHistory } from '../../shared/utils/validationOverride';
import type { ValidationOverrideBase } from '../../shared/utils/validationOverride';
import styles from './ValidationOverrideAudit.module.css';

interface ValidationOverrideAuditProps {
  override: ValidationOverrideBase | null | undefined;
  legacySummary: string;
  title?: string;
}

export const ValidationOverrideAudit: React.FC<ValidationOverrideAuditProps> = ({
  override,
  legacySummary,
  title = 'Override audit history',
}) => {
  const entries = resolveOverrideHistory(override, legacySummary);
  if (entries.length === 0) return null;

  const newestFirst = [...entries].reverse();

  return (
    <div className={styles.audit} role="region" aria-label={title}>
      <div className={styles.title}>{title}</div>
      <ul className={styles.list}>
        {newestFirst.map((entry) => (
          <AuditEntryRow key={`${entry.at}-${entry.userId}-${entry.reason}`} entry={entry} />
        ))}
      </ul>
    </div>
  );
};

const AuditEntryRow: React.FC<{ entry: ValidationOverrideAuditEntry }> = ({ entry }) => {
  const who = entry.userDisplayName ?? entry.userId;
  return (
    <li className={styles.entry}>
      <div className={styles.meta}>
        <span className={styles.who}>{who}</span>
        <span className={styles.sep}>·</span>
        <span className={styles.when}>{formatOverrideTimestamp(entry.at)}</span>
      </div>
      {entry.summary && <div className={styles.summary}>{entry.summary}</div>}
      <div className={styles.reason}>Reason: {entry.reason}</div>
    </li>
  );
};

export default ValidationOverrideAudit;
