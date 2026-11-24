import React, { useState } from 'react';
import type { AgentActivityItem } from '../../chatHarness/types';
import { AgentActivityLog, formatActivitySummaryLabel } from './AgentActivityLog';
import styles from './agentChat.module.css';

export interface AgentThoughtProcessTestIds {
  drawer?: string;
  toggle?: string;
  thinking?: string;
  steps?: string;
  toolGroup?: string;
}

export interface AgentThoughtProcessProps {
  items?: ReadonlyArray<AgentActivityItem> | null;
  isLoading?: boolean;
  isUnavailable?: boolean;
  defaultOpen?: boolean;
  summaryLabel?: string;
  testIdPrefix?: string;
  testIds?: AgentThoughtProcessTestIds;
  className?: string;
}

export const AgentThoughtProcess: React.FC<AgentThoughtProcessProps> = ({
  items = null,
  isLoading = false,
  isUnavailable = false,
  defaultOpen = false,
  summaryLabel,
  testIdPrefix,
  testIds,
  className,
}) => {
  const [open, setOpen] = useState(defaultOpen);

  const hasItems = Boolean(items && items.length > 0);
  if (!isLoading && !isUnavailable && !hasItems) return null;

  const drawerTestId = testIds?.drawer
    ?? (testIdPrefix ? `${testIdPrefix}-thought-process` : 'agent-thought-process');
  const toggleTestId = testIds?.toggle
    ?? (testIdPrefix ? `${testIdPrefix}-thought-process-toggle` : 'agent-thought-process-toggle');

  const resolvedSummary = summaryLabel
    ?? (isLoading
      ? 'Loading activity…'
      : isUnavailable
        ? 'Thought process'
        : formatActivitySummaryLabel(items ?? []));

  const logTestIds = {
    thinking: testIds?.thinking,
    steps: testIds?.steps,
    toolGroup: testIds?.toolGroup,
  };

  return (
    <details
      className={`${styles.traceDrawer} ${className ?? ''}`}
      open={open}
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
      {...{ 'data-testid': drawerTestId }}
    >
      <summary
        className={styles.traceSummary}
        {...{ 'data-testid': toggleTestId }}
      >
        <span className={styles.traceChevron} aria-hidden="true">
          {open ? '▼' : '▶'}
        </span>
        <span>{resolvedSummary}</span>
      </summary>
      {isLoading ? (
        <p className={styles.traceNotice}>Loading activity…</p>
      ) : isUnavailable ? (
        <p className={styles.traceNotice}>Activity is unavailable for this reply.</p>
      ) : (
        <AgentActivityLog
          items={items ?? []}
          testIdPrefix={testIdPrefix}
          testIds={logTestIds}
        />
      )}
    </details>
  );
};
