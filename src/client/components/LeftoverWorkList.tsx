import React from 'react';
import {
  isLeftoverWorkClean,
  type LeftoverWorkSummary,
} from '../../shared/types/devWorkbench';
import styles from './LeftoverWorkList.module.css';

interface LeftoverWorkListProps {
  sessionId: string;
  summary: LeftoverWorkSummary | null | undefined;
}

function leftoverWorkItems(summary: LeftoverWorkSummary): string[] {
  const items = summary.failingChecks.map((check) => `Failing check: ${check}`);
  if (summary.missingPr) {
    items.push('No pull request was opened — no PR yet');
  }
  for (const criterion of summary.incompleteAcceptanceCriteria) {
    items.push(`Incomplete acceptance criterion: ${criterion}`);
  }
  return items;
}

export const LeftoverWorkList: React.FC<LeftoverWorkListProps> = ({
  sessionId,
  summary,
}) => {
  if (!summary || isLeftoverWorkClean(summary)) return null;

  const items = leftoverWorkItems(summary);

  return (
    <ul
      className={styles.list}
      aria-label="Remaining work"
      {...{ 'data-testid': `my-work-leftover-work-${sessionId}` }}
    >
      {items.map((text, index) => (
        <li
          key={`${sessionId}-${index}`}
          className={styles.item}
          {...{ 'data-testid': `my-work-leftover-work-item-${sessionId}-${index}` }}
        >
          {text}
        </li>
      ))}
    </ul>
  );
};
