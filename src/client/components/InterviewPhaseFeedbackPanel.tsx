import React from 'react';
import {
  INTERVIEW_FEEDBACK_PHASE_LABEL,
  interviewPhaseStageKey,
  type InterviewFeedbackPhase,
} from '../utils/interviewPhaseFeedback';
import { QualityFeedbackForm } from './QualityFeedbackForm';
import styles from './InterviewPhaseFeedbackPanel.module.css';

export interface InterviewPhaseFeedbackPanelProps {
  project: string;
  interviewId: string;
  /** Phases still waiting for this reviewer; each gets its own form. */
  phases: readonly InterviewFeedbackPhase[];
  title: string;
  intro: string;
  testIdPrefix: string;
  'data-testid'?: string;
}

export const InterviewPhaseFeedbackPanel: React.FC<InterviewPhaseFeedbackPanelProps> = ({
  project,
  interviewId,
  phases,
  title,
  intro,
  testIdPrefix,
  'data-testid': testId = `${testIdPrefix}-panel`,
}) => (
  <section className={styles.panel} aria-label={title} {...{ 'data-testid': testId }}>
    <h2 className={styles.title}>{title}</h2>
    <p className={styles.intro}>{intro}</p>
    {phases.map((phase) => (
      <div key={phase} className={styles.phase}>
        <h3 className={styles.phaseTitle}>
          {INTERVIEW_FEEDBACK_PHASE_LABEL[phase]} (phase {phase})
        </h3>
        <QualityFeedbackForm
          project={project}
          subjectType="interview_phase"
          subjectId={interviewId}
          stageKey={interviewPhaseStageKey(phase)}
          canSubmit
          correctedArtifact={{ label: 'Corrected transcript' }}
          successMessage="Feedback saved. It does not change this interview."
          testIdPrefix={`${testIdPrefix}-phase-${phase}`}
          data-testid={`${testIdPrefix}-phase-${phase}-form`}
        />
      </div>
    ))}
  </section>
);
