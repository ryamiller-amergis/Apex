import React, { useMemo } from 'react';
import type { BuildRunStatus, BuildSuspendReason, BuildTaskRole, BuildTaskStatus } from '../../shared/types/build';
import type { BuildTaskView } from '../../shared/types/buildView';
import {
  NOTHING_REUSABLE_FOUND,
  PLAN_EMPTY_AFTER_INVALID,
  PLAN_EMPTY_WHILE_PLANNING,
  taskNoReuseTestId,
  taskReuseTestId,
} from '../../shared/buildPlanCopy';
import { groupTasksByBlockers } from './buildPlanGrouping';
import styles from './BuildRunView.module.css';

export function taskStatusLabel(status: BuildTaskStatus): string {
  switch (status) {
    case 'pending': return 'Waiting';
    case 'ready': return 'Ready';
    case 'running': return 'Running';
    case 'merged': return 'Merged';
    case 'failed': return 'Failed';
    case 'omitted': return 'Omitted';
    default: {
      const unhandled: never = status;
      return unhandled;
    }
  }
}

export function taskRoleLabel(role: BuildTaskRole): string {
  switch (role) {
    case 'planner': return 'Planner';
    case 'implementer': return 'Implementer';
    case 'qa': return 'QA';
    case 'check': return 'Final check';
    case 'sync': return 'Sync';
    default: {
      const unhandled: never = role;
      return unhandled;
    }
  }
}

function emptyPlanText(status: BuildRunStatus, suspendReason: BuildSuspendReason | null): string {
  if (status === 'planning') return PLAN_EMPTY_WHILE_PLANNING;
  if (status === 'suspended' && suspendReason === 'plan_invalid') return PLAN_EMPTY_AFTER_INVALID;
  return 'No plan yet. Apex writes the plan after you approve the brief.';
}

const TaskItem: React.FC<{ task: BuildTaskView }> = ({ task }) => (
  <li className={styles.task} {...{ 'data-testid': 'build-plan-task' }}>
    <div className={styles.taskTitle}>
      <span>{task.key}</span>
      <span>{taskRoleLabel(task.role)}</span>
      <span {...{ 'data-testid': 'build-plan-task-status' }}>{taskStatusLabel(task.status)}</span>
    </div>
    {task.omittedReason && (
      <p className={styles.taskDetail} {...{ 'data-testid': 'build-plan-task-omitted-reason' }}>
        {`Reason: ${task.omittedReason}`}
      </p>
    )}
    <div className={styles.taskDetail}>
      {`Owns: ${task.ownedFiles.length > 0 ? task.ownedFiles.join(', ') : 'no files'}`}
    </div>
    {task.reuse.length > 0 ? (
      <div className={styles.taskDetail} {...{ 'data-testid': taskReuseTestId(task.key) }}>
        {`Reuses: ${task.reuse.map((entry) => (entry.symbol ? `${entry.symbol} (${entry.path})` : entry.path)).join(', ')}`}
      </div>
    ) : (
      <div className={styles.taskDetail} {...{ 'data-testid': taskNoReuseTestId(task.key) }}>
        {NOTHING_REUSABLE_FOUND}
      </div>
    )}
    <div className={styles.taskDetail}>{`Branch: ${task.branch ?? 'not created yet'}`}</div>
  </li>
);

interface TaskGroupProps {
  id: string;
  title: string;
  tasks: BuildTaskView[];
}

const TaskGroup: React.FC<TaskGroupProps> = ({ id, title, tasks }) => (
  <section className={styles.section} aria-labelledby={id} {...{ 'data-testid': 'build-plan-group' }}>
    <h3 id={id}>{title}</h3>
    <ul className={styles.tasks}>
      {tasks.map((task) => <TaskItem key={task.key} task={task} />)}
    </ul>
  </section>
);

interface BuildPlanTabProps {
  tasks: BuildTaskView[];
  status: BuildRunStatus;
  suspendReason: BuildSuspendReason | null;
}

export const BuildPlanTab: React.FC<BuildPlanTabProps> = ({ tasks, status, suspendReason }) => {
  const groups = useMemo(() => groupTasksByBlockers(tasks), [tasks]);

  if (tasks.length === 0) {
    return <p className={styles.empty} {...{ 'data-testid': 'build-plan-empty' }}>{emptyPlanText(status, suspendReason)}</p>;
  }

  return (
    <div className={styles.panel} {...{ 'data-testid': 'build-plan-list' }}>
      {groups.waves.map((wave, index) => (
        <TaskGroup
          key={`wave-${index + 1}`}
          id={`build-plan-wave-${index + 1}`}
          title={index === 0 ? 'Can start now' : `After group ${index}`}
          tasks={wave}
        />
      ))}
      {groups.waiting.length > 0 && (
        <TaskGroup id="build-plan-waiting" title="Waiting on tasks not in this plan" tasks={groups.waiting} />
      )}
    </div>
  );
};
