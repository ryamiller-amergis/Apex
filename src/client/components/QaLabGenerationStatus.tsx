import React, { useEffect, useMemo, useRef } from 'react';
import { useChatStream, type ToolProgress } from '../hooks/useChatStream';
import {
  friendlyChatProgressLabel,
  friendlyToolActivityLabel,
} from '../../shared/utils/chatProgressCopy';
import { ApexLoader } from './ApexLoader';
import { ChatRunProgressLabel } from './ChatRunProgressLabel';
import styles from './QaLabGenerationStatus.module.css';

type MilestoneState = 'pending' | 'active' | 'done';

/**
 * What a test-case run does. The work items arrive in the kickoff instructions,
 * so they count as loaded once the agent starts; the rest are recognised from
 * the files the agent touches.
 */
const MILESTONES: { key: string; label: string; matches: RegExp | null }[] = [
  { key: 'work-items', label: 'Load the work items', matches: null },
  { key: 'skill', label: 'Read the QA skill', matches: /(SKILL\.md|test-case-schema\.json)$/i },
  { key: 'write', label: 'Write the test cases', matches: /\.test-cases\.(json|md)$/i },
];

const TARGET_KEYS = ['target', 'path', 'file_path', 'filePath', 'pattern', 'query'] as const;

function targetOf(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null;
  const record = args as Record<string, unknown>;
  for (const key of TARGET_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return record.args ? targetOf(record.args) : null;
}

/** Workspace paths are long and machine-specific; show them from `.ai-pilot/` or the repo root. */
function shortTarget(target: string): string {
  const normalized = target.replace(/\\/g, '/');
  const pilot = normalized.indexOf('.ai-pilot/');
  if (pilot >= 0) return normalized.slice(pilot);
  const skills = normalized.indexOf('.cursor/skills/');
  return skills >= 0 ? normalized.slice(skills) : normalized;
}

function milestoneStates(tools: ToolProgress[], agentStarted: boolean): MilestoneState[] {
  return MILESTONES.map(({ matches }) => {
    if (matches === null) return agentStarted ? 'done' : 'active';
    const touching = tools.filter((tool) => {
      const target = targetOf(tool.args);
      return target !== null && matches.test(target);
    });
    if (touching.some((tool) => tool.status === 'completed')) return 'done';
    return touching.length > 0 ? 'active' : 'pending';
  });
}

function stepStatusLabel(status: ToolProgress['status']): string {
  switch (status) {
    case 'running':
      return 'Working: ';
    case 'error':
      return 'Could not finish: ';
    case 'completed':
      return 'Finished: ';
    default: {
      const unhandled: never = status;
      throw new Error(`Unknown step status: ${String(unhandled)}`);
    }
  }
}

export interface QaLabGenerationStatusProps {
  /** Agent thread running the generation. Null before the server records it. */
  threadId: string | null;
}

/** Loader, test-case milestones, and the agent's live activity while QA Lab generates. */
export const QaLabGenerationStatus: React.FC<QaLabGenerationStatusProps> = ({ threadId }) => {
  const { progressLabel, progressPhase, toolProgress, thinkingText } = useChatStream(threadId);
  const thinking = thinkingText.trim();
  const agentStarted = toolProgress.length > 0
    || thinking.length > 0
    || (progressPhase !== null && progressPhase !== 'queued' && progressPhase !== 'dispatched');
  const states = useMemo(() => milestoneStates(toolProgress, agentStarted), [toolProgress, agentStarted]);
  const scrollerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [toolProgress, thinking]);

  return (
    <div className={styles.root} role="status" aria-live="polite" {...{ 'data-testid': 'qa-lab-generating' }}>
      <ApexLoader size={72} />
      <div className={styles.label}>Generating your test cases…</div>

      <ol className={styles.milestones} {...{ 'data-testid': 'qa-lab-generating-milestones' }}>
        {MILESTONES.map((milestone, index) => (
          <li
            key={milestone.key}
            className={`${styles.milestone} ${styles[`milestone_${states[index]}`]}`}
            {...{ 'data-testid': `qa-lab-milestone-${milestone.key}`, 'data-state': states[index] }}
          >
            <span className={styles.milestoneMark} aria-hidden="true">
              {states[index] === 'done' ? '✓' : index + 1}
            </span>
            {milestone.label}
          </li>
        ))}
      </ol>

      <div className={styles.liveWorkBox}>
        <p className={styles.activity} {...{ 'data-testid': 'qa-lab-generating-step' }}>
          <span className={styles.spinner} aria-hidden="true" />
          <ChatRunProgressLabel
            fallbackLabel={progressPhase || progressLabel
              ? friendlyChatProgressLabel(progressLabel, progressPhase)
              : 'Starting the agent…'}
            progressPhase={progressPhase}
            toolProgress={toolProgress}
          />
        </p>
        {(thinking || toolProgress.length > 0) && (
          <div ref={scrollerRef} className={styles.activityScroller} {...{ 'data-testid': 'qa-lab-generating-steps' }}>
            {toolProgress.map((tool) => {
              const target = targetOf(tool.args);
              return (
                <div key={tool.callId} className={styles.stepRow}>
                  <span className={styles.stepBullet} aria-hidden="true">•</span>
                  <span className={styles.stepItem}>
                    <span className={styles.stepStatus}>{stepStatusLabel(tool.status)}</span>
                    <span className={styles.stepLabel}>{friendlyToolActivityLabel(tool.toolName, tool.args)}</span>
                    {target && <code className={styles.stepTarget}>{` — ${shortTarget(target)}`}</code>}
                  </span>
                </div>
              );
            })}
            {thinking && <p className={styles.thinking}>{thinking}</p>}
          </div>
        )}
      </div>

      <div className={styles.hint}>This can take a few minutes. You can leave and come back.</div>
    </div>
  );
};
