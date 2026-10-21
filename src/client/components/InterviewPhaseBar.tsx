import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ActiveUser } from '../../shared/types/interview';
import type { InterviewPhaseId, InterviewPhaseProgress, InterviewPhaseState } from '../utils/interviewPhaseProgress';
import { sortByLabel } from '../utils/sortByLabel';
import styles from './InterviewPhaseBar.module.css';

export interface PhaseAssignmentControl {
  users: ActiveUser[];
  selectedIds: Partial<Record<InterviewPhaseId, string | undefined>>;
  selectedNames: Partial<Record<InterviewPhaseId, string | undefined>>;
  canAssign: boolean;
  pending?: boolean;
  error?: string | null;
  onAssign: (phase: InterviewPhaseId, userId: string) => void;
}

interface InterviewPhaseBarProps {
  progress: InterviewPhaseProgress;
  layout?: 'banner' | 'compose';
  assignment?: PhaseAssignmentControl;
}

const STATE_CLASS: Record<InterviewPhaseState, string> = {
  current: styles.stepCurrent,
  complete: styles.stepComplete,
  upcoming: styles.stepUpcoming,
  optional: styles.stepOptional,
  skipped: styles.stepSkipped,
};

function userLabel(user: ActiveUser): string {
  return user.displayName || user.email || user.oid;
}

const PhaseAssignee: React.FC<{
  phase: InterviewPhaseId;
  assignment: PhaseAssignmentControl;
}> = ({ phase, assignment }) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selectedId = assignment.selectedIds[phase] ?? '';
  const selectedUser = assignment.users.find((user) => user.oid === selectedId);
  const label = selectedUser ? userLabel(selectedUser) : (assignment.selectedNames[phase] || 'Unassigned');
  const options = useMemo(() => {
    const ordered = sortByLabel(assignment.users, userLabel);
    const q = query.trim().toLowerCase();
    if (!q) return ordered;
    return ordered.filter((user) => userLabel(user).toLowerCase().includes(q) || user.email?.toLowerCase().includes(q));
  }, [assignment.users, query]);

  const place = useCallback(() => {
    const button = buttonRef.current;
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom - 4;
    const openUp = spaceBelow < 220 && rect.top > spaceBelow;
    return {
      left: rect.left,
      width: Math.max(rect.width, 220),
      maxHeight: Math.min(240, Math.max(120, openUp ? rect.top - 8 : spaceBelow)),
      top: openUp ? 'auto' : rect.bottom + 4,
      bottom: openUp ? window.innerHeight - rect.top + 4 : 'auto',
    } as const;
  }, []);
  const [box, setBox] = useState<ReturnType<typeof place>>(null);

  useEffect(() => {
    if (!open) return;
    setBox(place());
    const onMove = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      setBox(place());
    };
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open, place, options.length]);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const choose = (userId: string) => {
    setOpen(false);
    setQuery('');
    if (userId !== selectedId) assignment.onAssign(phase, userId);
  };

  if (!assignment.canAssign) {
    return <span className={styles.assigneeReadOnly}>{label}</span>;
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={styles.assignee}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={assignment.pending}
        onClick={() => setOpen((value) => !value)}
        {...{ 'data-testid': `interview-phase-assignee-${phase}` }}
      >
        <span className={styles.assigneeName}>{label}</span>
        <svg viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 4.5L6 7.5L9 4.5" />
        </svg>
      </button>
      {open && box && createPortal(
        <div
          ref={menuRef}
          className={styles.assigneeMenu}
          role="listbox"
          style={{
            position: 'fixed',
            left: box.left,
            width: box.width,
            maxHeight: box.maxHeight,
            top: box.top,
            bottom: box.bottom,
            zIndex: 5000,
          }}
          {...{ 'data-testid': `interview-phase-assignee-menu-${phase}` }}
        >
          <input
            className={styles.assigneeSearch}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search users"
            aria-label={`Search ${phase} users`}
            autoFocus
            {...{ 'data-testid': `interview-phase-assignee-search-${phase}` }}
          />
          <button
            type="button"
            role="option"
            aria-selected={!selectedId}
            className={styles.assigneeOption}
            onMouseDown={() => choose('')}
            {...{ 'data-testid': `interview-phase-assignee-option-${phase}-unassigned` }}
          >
            Unassigned
          </button>
          {options.map((user) => (
            <button
              key={user.oid}
              type="button"
              role="option"
              aria-selected={user.oid === selectedId}
              className={styles.assigneeOption}
              onMouseDown={() => choose(user.oid)}
              {...{ 'data-testid': `interview-phase-assignee-option-${phase}-${user.oid}` }}
            >
              {userLabel(user)}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
};

export const InterviewPhaseBar: React.FC<InterviewPhaseBarProps> = ({
  progress,
  layout = 'banner',
  assignment,
}) => {
  return (
    <nav
      className={`${styles.bar} ${layout === 'compose' ? styles.compose : ''}`}
      aria-label="Interview phases"
      {...{ 'data-testid': 'interview-phase-bar' }}
    >
      <ol className={styles.steps}>
        {progress.steps.map((phase) => (
          <li
            key={phase.id}
            className={`${styles.step} ${STATE_CLASS[phase.state]} ${assignment ? styles.stepWithAssignee : ''}`}
            aria-current={phase.state === 'current' ? 'step' : undefined}
            {...{ 'data-testid': `interview-phase-${phase.id}` }}
          >
            <span className={styles.track} aria-hidden="true" />
            <span className={styles.label}>{phase.label}</span>
            {assignment && <PhaseAssignee phase={phase.id} assignment={assignment} />}
            <span className={styles.detail}>{phase.detail}</span>
          </li>
        ))}
      </ol>
      <p className={styles.summary}>{progress.summary}</p>
      {assignment?.error && <p className={styles.assignmentError}>{assignment.error}</p>}
    </nav>
  );
};
