import React, { useEffect, useRef, useState } from 'react';
import type {
  InterviewPhaseFlow,
  InterviewPhaseStatus,
} from '../../shared/types/interview';
import { isTechnicalTabLocked } from '../utils/interviewPhaseFlow';
import styles from './InterviewPhaseTabs.module.css';

export type InterviewPhaseTabId = 'requirements' | 'technical';

interface InterviewPhaseTabsProps {
  phaseFlow: InterviewPhaseFlow | null | undefined;
  requirementsPhaseStatus: InterviewPhaseStatus | null | undefined;
  activeTab: InterviewPhaseTabId;
  onTabChange: (tab: InterviewPhaseTabId) => void;
}

const LOCKED_MESSAGE =
  'Approve the Requirements summary to unlock Technical.';

export const InterviewPhaseTabs: React.FC<InterviewPhaseTabsProps> = ({
  phaseFlow,
  requirementsPhaseStatus,
  activeTab,
  onTabChange,
}) => {
  const [showLockedNotice, setShowLockedNotice] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const technicalLocked = isTechnicalTabLocked(
    phaseFlow,
    requirementsPhaseStatus,
  );

  useEffect(() => {
    if (!showLockedNotice) return undefined;

    const timeoutId = window.setTimeout(() => {
      setShowLockedNotice(false);
    }, 3000);
    const handleOutsideMouseDown = (event: MouseEvent) => {
      if (
        containerRef.current
        && !containerRef.current.contains(event.target as Node)
      ) {
        setShowLockedNotice(false);
      }
    };

    document.addEventListener('mousedown', handleOutsideMouseDown);
    return () => {
      window.clearTimeout(timeoutId);
      document.removeEventListener('mousedown', handleOutsideMouseDown);
    };
  }, [showLockedNotice]);

  useEffect(() => {
    if (technicalLocked || !showLockedNotice) return undefined;
    const timeoutId = window.setTimeout(() => setShowLockedNotice(false), 0);
    return () => window.clearTimeout(timeoutId);
  }, [showLockedNotice, technicalLocked]);

  const handleTechnicalClick = () => {
    if (technicalLocked) {
      setShowLockedNotice(true);
      return;
    }
    onTabChange('technical');
  };

  return (
    <div ref={containerRef} className={styles.container}>
      <div
        className={styles.tabList}
        role="tablist"
        aria-label="Interview phases"
        {...{ 'data-testid': 'interview-phase-tabs' }}
      >
        <button
          className={`${styles.tab} ${activeTab === 'requirements' ? styles.activeTab : ''}`}
          type="button"
          role="tab"
          id="interview-phase-tab-requirements"
          aria-selected={activeTab === 'requirements'}
          aria-controls="interview-phase-panel-requirements"
          onClick={() => onTabChange('requirements')}
          {...{ 'data-testid': 'interview-phase-tab-requirements' }}
        >
          Requirements
        </button>
        <button
          className={`${styles.tab} ${activeTab === 'technical' ? styles.activeTab : ''} ${technicalLocked ? styles.lockedTab : ''}`}
          type="button"
          role="tab"
          id="interview-phase-tab-technical"
          aria-selected={activeTab === 'technical'}
          aria-controls="interview-phase-panel-technical"
          aria-disabled={technicalLocked || undefined}
          aria-label={technicalLocked
            ? 'Technical — locked until Requirements is approved'
            : 'Technical'}
          title={technicalLocked ? LOCKED_MESSAGE : undefined}
          onClick={handleTechnicalClick}
          {...{ 'data-testid': 'interview-phase-tab-technical' }}
        >
          {technicalLocked && (
            <svg
              className={styles.lockIcon}
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="3" y="7" width="10" height="8" rx="1.5" />
              <path d="M5 7V5a3 3 0 0 1 6 0v2" />
            </svg>
          )}
          Technical
        </button>
      </div>
      {showLockedNotice && technicalLocked && (
        <div
          className={styles.lockedNotice}
          role="status"
          aria-live="polite"
          {...{ 'data-testid': 'interview-phase-tab-technical-locked-tooltip' }}
        >
          {LOCKED_MESSAGE}
        </div>
      )}
    </div>
  );
};
