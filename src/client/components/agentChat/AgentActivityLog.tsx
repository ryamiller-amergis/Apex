import React, { useEffect, useMemo, useRef } from 'react';
import type { AgentActivityItem } from '../../chatHarness/types';
import { friendlyToolActivityLabel } from '../../../shared/utils/chatProgressCopy';
import { AgentToolGroup, cleanTargetLabel, formatToolStatusPrefix } from './AgentToolGroup';
import styles from './agentChat.module.css';

interface FlatToolEntry {
  id: string;
  toolName: string;
  status: AgentActivityItem['status'];
  target?: string | null;
}

export function formatActivitySummaryLabel(items: ReadonlyArray<AgentActivityItem>): string {
  let toolCount = 0;
  for (const item of items) {
    if (item.kind === 'tool') {
      toolCount += 1;
    } else if (item.kind === 'tool-group') {
      toolCount += item.tools ? item.tools.length : 1;
    }
  }
  if (toolCount > 0) {
    return `Thought process · ${toolCount} ${toolCount === 1 ? 'step' : 'steps'}`;
  }
  return 'Thought process';
}

export interface AgentActivityLogTestIds {
  thinking?: string;
  steps?: string;
  toolGroup?: string;
}

export interface AgentActivityLogProps {
  items: ReadonlyArray<AgentActivityItem>;
  testIdPrefix?: string;
  testIds?: AgentActivityLogTestIds;
  className?: string;
}

export const AgentActivityLog: React.FC<AgentActivityLogProps> = ({
  items,
  testIdPrefix,
  testIds,
  className,
}) => {
  const scrollerRef = useRef<HTMLDivElement>(null);

  const flatTools = useMemo<FlatToolEntry[]>(() => {
    const collected: FlatToolEntry[] = [];
    for (const item of items) {
      if (item.kind === 'tool') {
        collected.push({
          id: item.id,
          toolName: item.toolName ?? 'tool',
          status: item.status,
          target: item.target,
        });
      } else if (item.kind === 'tool-group') {
        if (item.tools && item.tools.length > 0) {
          for (const tool of item.tools) {
            collected.push({
              id: tool.id,
              toolName: tool.toolName,
              status: tool.status,
              target: tool.target,
            });
          }
        } else if (item.toolName) {
          collected.push({
            id: item.id,
            toolName: item.toolName,
            status: item.status,
            target: item.target,
          });
        }
      }
    }
    return collected;
  }, [items]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [items]);

  if (items.length === 0) return null;

  const thinkingTestId = testIds?.thinking
    ?? (testIdPrefix ? `${testIdPrefix}-agent-thinking` : 'agent-thinking');
  const stepsTestId = testIds?.steps
    ?? (testIdPrefix ? `${testIdPrefix}-agent-steps` : 'agent-steps');
  const toolGroupTestId = testIds?.toolGroup
    ?? (testIdPrefix ? `${testIdPrefix}-tool-group` : 'agent-tool-group');

  return (
    <div ref={scrollerRef} className={`${styles.activityScroller} ${className ?? ''}`}>
      {items.map((item) => {
        if (item.kind === 'thinking') {
          if (!item.text) return null;
          return (
            <p
              key={item.id}
              className={styles.thinking}
              {...{ 'data-testid': thinkingTestId }}
            >
              {item.text}
            </p>
          );
        }

        if (item.kind === 'tool-group') {
          return (
            <AgentToolGroup
              key={item.id}
              item={item}
              testIdPrefix={testIdPrefix}
              testId={toolGroupTestId}
            />
          );
        }

        if (item.kind === 'summary') {
          if (!item.text) return null;
          return (
            <p key={item.id} className={styles.activitySummaryNote}>
              {item.text}
            </p>
          );
        }

        const target = cleanTargetLabel(item.target);
        const label = friendlyToolActivityLabel(
          item.toolName ?? 'tool',
          item.target ? { target: item.target } : undefined,
        );
        const statusPrefix = formatToolStatusPrefix(item.status);
        return (
          <div key={item.id} className={styles.stepRow}>
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
      })}

      {flatTools.length > 0 ? (
        <ul className={styles.srOnlySteps} {...{ 'data-testid': stepsTestId }}>
          {flatTools.map((tool) => {
            const target = cleanTargetLabel(tool.target);
            const label = friendlyToolActivityLabel(
              tool.toolName,
              tool.target ? { target: tool.target } : undefined,
            );
            const statusPrefix = formatToolStatusPrefix(tool.status);
            return (
              <li key={tool.id}>
                {statusPrefix}
                {label}
                {target ? ` — ${target}` : ''}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
};
