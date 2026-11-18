/**
 * Every problem the server's check found in the graph on screen, with a way to jump to the step.
 * A step shows its own problems in the settings panel; this is the whole list in one place,
 * including problems that belong to a connection or to the graph rather than to one step.
 */
import React, { useState } from 'react';
import { ChevronDown, ChevronUp, TriangleAlert } from 'lucide-react';
import type { PlaybookDryRunIssue } from '../../shared/types/playbook';
import styles from './PlaybookBuilder.module.css';

interface PlaybookIssueSummaryProps {
  issues: readonly PlaybookDryRunIssue[];
  onSelectNode: (nodeId: string) => void;
  'data-testid'?: string;
}

export const PlaybookIssueSummary: React.FC<PlaybookIssueSummaryProps> = ({
  issues,
  onSelectNode,
  'data-testid': testId = 'playbook-issue-summary',
}) => {
  const [open, setOpen] = useState(false);
  if (issues.length === 0) return null;

  return (
    <section className={styles.issueSummary} {...{ 'data-testid': testId }}>
      <button
        type="button"
        className={styles.issueSummaryToggle}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        {...{ 'data-testid': 'playbook-issue-summary-toggle' }}
      >
        <TriangleAlert size={14} aria-hidden />
        {issues.length === 1 ? '1 problem to fix before publishing' : `${issues.length} problems to fix before publishing`}
        {open ? <ChevronUp size={14} aria-hidden /> : <ChevronDown size={14} aria-hidden />}
      </button>
      {open ? (
        <ul className={styles.issueSummaryList} {...{ 'data-testid': 'playbook-issue-summary-list' }}>
          {issues.map((issue) => (
            <li
              key={`${issue.nodeId}-${issue.edge?.from ?? ''}-${issue.edge?.to ?? ''}-${issue.message}`}
              className={styles.issueSummaryItem}
            >
              {issue.nodeId ? (
                <button
                  type="button"
                  className={styles.issueNode}
                  onClick={() => onSelectNode(issue.nodeId)}
                  title="Show this step"
                  {...{ 'data-testid': `playbook-issue-summary-node-${issue.nodeId}` }}
                >
                  {issue.nodeId}
                </button>
              ) : null}
              <span className={styles.issueMessage}>{issue.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
};

export default PlaybookIssueSummary;
