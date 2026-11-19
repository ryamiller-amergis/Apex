import React from 'react';
import type { AgentActivityItem, AgentActivityToolItem } from '../../chatHarness/types';
import { friendlyToolActivityLabel } from '../../../shared/utils/chatProgressCopy';
import styles from './agentChat.module.css';

export function cleanTargetLabel(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\\/g, '/');
  const sourcesIdx = normalized.indexOf('sources/');
  if (sourcesIdx >= 0) {
    return normalized.slice(sourcesIdx);
  }
  return trimmed;
}

export function formatToolStatusPrefix(
  status: AgentActivityItem['status'] | AgentActivityToolItem['status'] | undefined,
): string {
  if (status === 'running') return 'Working: ';
  if (status === 'error') return 'Could not finish: ';
  return 'Finished: ';
}

function resolveGroupStatus(tools: ReadonlyArray<AgentActivityToolItem>): 'running' | 'completed' | 'error' {
  if (tools.some((tool) => tool.status === 'running')) return 'running';
  if (tools.some((tool) => tool.status === 'error')) return 'error';
  return 'completed';
}

export interface AgentToolGroupProps {
  item: AgentActivityItem;
  testIdPrefix?: string;
  testId?: string;
  className?: string;
}

export const AgentToolGroup: React.FC<AgentToolGroupProps> = ({
  item,
  testIdPrefix,
  testId,
  className,
}) => {
  const tools = item.tools ?? [];

  if (tools.length === 0) {
    if (!item.toolName) return null;
    const target = cleanTargetLabel(item.target);
    const label = friendlyToolActivityLabel(
      item.toolName,
      item.target ? { target: item.target } : undefined,
    );
    const statusPrefix = formatToolStatusPrefix(item.status);
    return (
      <div className={`${styles.stepRow} ${className ?? ''}`}>
        <span className={styles.stepBullet} aria-hidden="true">•</span>
        <span className={styles.stepItem}>
          <span
            className={`${styles.stepStatus} ${item.status === 'error' ? styles.stepStatusError : ''}`}
          >
            {statusPrefix}
          </span>
          <span className={styles.stepLabel}>{label}</span>
          {target ? <code className={styles.stepTarget}>{` — ${target}`}</code> : null}
        </span>
      </div>
    );
  }

  if (tools.length === 1) {
    const tool = tools[0];
    const target = cleanTargetLabel(tool.target);
    const label = friendlyToolActivityLabel(
      tool.toolName,
      tool.target ? { target: tool.target } : undefined,
    );
    const statusPrefix = formatToolStatusPrefix(tool.status);
    return (
      <div className={`${styles.stepRow} ${className ?? ''}`}>
        <span className={styles.stepBullet} aria-hidden="true">•</span>
        <span className={styles.stepItem}>
          <span
            className={`${styles.stepStatus} ${tool.status === 'error' ? styles.stepStatusError : ''}`}
          >
            {statusPrefix}
          </span>
          <span className={styles.stepLabel}>{label}</span>
          {target ? <code className={styles.stepTarget}>{` — ${target}`}</code> : null}
        </span>
      </div>
    );
  }

  const groupStatus = resolveGroupStatus(tools);
  const groupStatusPrefix = formatToolStatusPrefix(groupStatus);
  const resolvedTestId = testId ?? (testIdPrefix ? `${testIdPrefix}-tool-group` : 'agent-tool-group');

  return (
    <div
      className={`${styles.toolGroup} ${className ?? ''}`}
      {...{ 'data-testid': resolvedTestId }}
    >
      <div className={styles.toolGroupHeader}>
        <span className={styles.stepBullet} aria-hidden="true">•</span>
        <span className={styles.stepItem}>
          <span
            className={`${styles.stepStatus} ${groupStatus === 'error' ? styles.stepStatusError : ''}`}
          >
            {groupStatusPrefix}
          </span>
          <span className={styles.stepLabel}>{`${tools.length} tools`}</span>
        </span>
      </div>
      <ul className={styles.toolGroupList}>
        {tools.map((tool) => {
          const target = cleanTargetLabel(tool.target);
          const label = friendlyToolActivityLabel(
            tool.toolName,
            tool.target ? { target: tool.target } : undefined,
          );
          const statusPrefix = formatToolStatusPrefix(tool.status);
          return (
            <li key={tool.id} className={styles.toolGroupItem}>
              <span
                className={`${styles.stepStatus} ${tool.status === 'error' ? styles.stepStatusError : ''}`}
              >
                {statusPrefix}
              </span>
              <span className={styles.stepLabel}>{label}</span>
              {target ? <code className={styles.stepTarget}>{` — ${target}`}</code> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
};
