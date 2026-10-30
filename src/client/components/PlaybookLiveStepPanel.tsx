/**
 * The step panel docked over the bottom of the live run graph. Collapsed, it is one line: what the
 * step is, how long it has run, and what it is doing now or why it failed. Expanded, it shows the
 * step's log and its input and output.
 */
import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Clock, Loader2, X } from 'lucide-react';
import type {
  PlaybookStepRun,
  PlaybookSuspensionDetail,
} from '../../shared/types/playbook';
import { usePlaybookStepActivity } from '../hooks/usePlaybookRuns';
import { stepStatusLabel } from './playbookStatusFormat';
import { stepMeta } from './playbookStepCatalog';
import {
  LIVE_STATUSES,
  StatusIcon,
  StepDetails,
  StepLog,
  duration,
  stepFailureReason,
  useNow,
} from './PlaybookStepDetailDrawer';
import styles from './PlaybookLiveStepPanel.module.css';

interface PlaybookLiveStepPanelProps {
  project: string;
  runId: string;
  step: PlaybookStepRun;
  suspension?: PlaybookSuspensionDetail | null;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  onClose: () => void;
  'data-testid'?: string;
}

export const PlaybookLiveStepPanel: React.FC<PlaybookLiveStepPanelProps> = ({
  project,
  runId,
  step,
  suspension,
  expanded,
  onExpandedChange,
  onClose,
  'data-testid': testId = 'playbook-live-step-panel',
}) => {
  const [tab, setTab] = useState<'log' | 'details'>('log');
  const live = LIVE_STATUSES.includes(step.status);
  const now = useNow(live);
  const meta = stepMeta(step.stepType);
  const Icon = meta.icon;
  const isAgent = step.stepType === 'cursor-agent';
  const activity = usePlaybookStepActivity(project, runId, isAgent ? step.id : null, live);
  const nowDoing = live ? activity.data?.agentRun?.label ?? null : null;
  const failure = stepFailureReason(step);

  useEffect(() => {
    if (!expanded) return undefined;
    const collapse = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onExpandedChange(false);
    };
    window.addEventListener('keydown', collapse);
    return () => window.removeEventListener('keydown', collapse);
  }, [expanded, onExpandedChange]);

  return (
    <section
      className={`${styles.panel} ${expanded ? styles.panelExpanded : ''}`}
      data-status={step.status}
      aria-label={`${meta.title} ${step.stepId}`}
      {...{ 'data-testid': testId }}
    >
      <div className={styles.bar}>
        <button
          type="button"
          className={styles.summary}
          onClick={() => onExpandedChange(!expanded)}
          aria-expanded={expanded}
          {...{ 'data-testid': 'playbook-live-step-panel-toggle' }}
        >
          <span className={styles.icon} data-group={meta.group} aria-hidden>
            <Icon size={16} strokeWidth={2} />
          </span>
          <span className={styles.heading}>
            <span className={styles.titleRow}>
              <span className={styles.title}>{meta.title}</span>
              <span className={styles.stepId}>{step.stepId}</span>
              <span className={styles.statusPill} data-status={step.status}>
                <StatusIcon status={step.status} size={12} />
                {stepStatusLabel(step.status)}
              </span>
              {step.startedAt ? (
                <span className={styles.elapsed}>
                  <Clock size={12} aria-hidden /> {duration(step.startedAt, step.completedAt, now)}
                </span>
              ) : null}
            </span>
            {failure ? (
              <span className={styles.subline} data-tone="error">{failure}</span>
            ) : nowDoing ? (
              <span className={styles.subline} data-tone="live">
                <Loader2 size={12} aria-hidden className={styles.spin} /> {nowDoing}
              </span>
            ) : (
              <span className={styles.subline}>
                {expanded ? 'Click to collapse' : 'Click to see the log and details'}
              </span>
            )}
          </span>
          <span className={styles.chevron} aria-hidden>
            {expanded ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
          </span>
        </button>
        <button
          type="button"
          className={styles.close}
          onClick={onClose}
          aria-label="Close step panel"
          {...{ 'data-testid': 'playbook-live-step-panel-close' }}
        >
          <X size={15} aria-hidden />
        </button>
      </div>

      {expanded ? (
        <>
          <div className={styles.tabs} role="tablist" aria-label="Step detail">
            {([['log', 'Log'], ['details', 'Input and output']] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                className={`${styles.tab} ${tab === value ? styles.tabActive : ''}`}
                onClick={() => setTab(value)}
                {...{ 'data-testid': `playbook-live-step-panel-tab-${value}` }}
              >
                {label}
              </button>
            ))}
          </div>
          <div className={styles.body}>
            {tab === 'log' ? (
              <StepLog key={step.id} project={project} runId={runId} step={step} suspension={suspension} />
            ) : (
              <StepDetails key={step.id} project={project} runId={runId} step={step} suspension={suspension} />
            )}
          </div>
        </>
      ) : null}
    </section>
  );
};

export default PlaybookLiveStepPanel;
