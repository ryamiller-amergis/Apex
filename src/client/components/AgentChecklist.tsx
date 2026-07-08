import React, { useState } from 'react';
import type { AgentChecklist as AgentChecklistData, ChecklistItem, ChecklistItemStatus } from '../utils/parseAgentTodos';
import styles from './AgentChecklist.module.css';

interface AgentChecklistProps {
  checklist: AgentChecklistData;
  isRunning: boolean;
}

function StatusIcon({ status }: { status: ChecklistItemStatus }) {
  if (status === 'completed') {
    return <span className={styles['icon-completed']} aria-label="Completed">✓</span>;
  }
  if (status === 'cancelled') {
    return <span className={styles['icon-cancelled']} aria-label="Cancelled">–</span>;
  }
  if (status === 'in_progress') {
    return <span className={styles['icon-spinner']} aria-label="In progress" />;
  }
  return <span className={styles['icon-pending']} aria-label="Pending" />;
}

const ChecklistRow: React.FC<{ item: ChecklistItem }> = ({ item }) => (
  <div
    className={[
      styles['checklist-row'],
      item.status === 'completed' ? styles['row-completed'] : '',
      item.status === 'in_progress' ? styles['row-in-progress'] : '',
      item.status === 'cancelled' ? styles['row-cancelled'] : '',
    ]
      .filter(Boolean)
      .join(' ')}
  >
    <StatusIcon status={item.status} />
    <span className={styles['row-label']}>{item.label}</span>
  </div>
);

export const AgentChecklist: React.FC<AgentChecklistProps> = ({ checklist, isRunning }) => {
  const [collapsed, setCollapsed] = useState(false);

  const { items } = checklist;
  if (items.length === 0) return null;

  const completedCount = items.filter((i) => i.status === 'completed').length;
  const total = items.length;
  const allDone = completedCount === total;

  return (
    <div className={`${styles.container} ${isRunning ? styles['container-running'] : ''} ${allDone ? styles['container-done'] : ''}`}>
      <button
        type="button"
        className={styles.header}
        onClick={() => setCollapsed((p) => !p)}
        aria-expanded={!collapsed}
      >
        <span className={styles['header-left']}>
          {isRunning && !allDone && <span className={styles['header-spinner']} />}
          <span className={styles['header-title']}>Tasks</span>
          <span className={styles['header-count']}>
            {completedCount}/{total}
          </span>
        </span>
        <span className={styles['header-toggle']}>{collapsed ? '▶' : '▼'}</span>
      </button>

      {!collapsed && (
        <div className={styles.body}>
          {items.map((item) => (
            <ChecklistRow key={item.id} item={item} />
          ))}
        </div>
      )}
    </div>
  );
};
