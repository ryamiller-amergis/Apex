import React from 'react';
import { WORKFLOW_EVALUATION_PRD_STAGE_KEY } from '../../shared/types/workflowEvaluation';
import { QualityFeedbackForm } from './QualityFeedbackForm';
import { QualityFeedbackHistory } from './QualityFeedbackHistory';
import styles from './PrdQualityFeedbackTab.module.css';

export interface PrdQualityFeedbackTabProps {
  prdId: string;
  project: string;
  /** Raw PRD markdown, unstripped, so the snapshot matches what the server hashes. */
  content: string;
  updatedAt: string;
  canView: boolean;
  canSubmit: boolean;
  'data-testid'?: string;
}

function formatUpdatedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

const PrdQualityFeedbackTab: React.FC<PrdQualityFeedbackTabProps> = ({
  prdId,
  project,
  content,
  updatedAt,
  canView,
  canSubmit,
  'data-testid': testId = 'prd-quality-feedback-panel',
}) => (
  <div className={styles.panel} {...{ 'data-testid': testId }}>
    <div>
      <h2 className={styles.title}>Quality feedback</h2>
      <p className={styles.intro}>
        Your feedback improves the AI over time. The PRD owner gives feedback before approving.
      </p>
    </div>
    <QualityFeedbackForm
      project={project}
      subjectType="prd"
      subjectId={prdId}
      stageKey={WORKFLOW_EVALUATION_PRD_STAGE_KEY}
      canSubmit={canSubmit}
      correctedArtifact={{
        label: 'Corrected PRD',
        snapshotMarkdown: content,
        snapshotLabel: formatUpdatedAt(updatedAt),
      }}
      successMessage="Feedback saved. It does not change this PRD."
      testIdPrefix="prd-quality-feedback"
      data-testid="prd-quality-feedback-form"
    />
    <QualityFeedbackHistory
      project={project}
      subjectType="prd"
      subjectId={prdId}
      stageKey={WORKFLOW_EVALUATION_PRD_STAGE_KEY}
      canView={canView}
      subjectVersion={updatedAt}
      emptyMessage="No feedback yet for this version of the PRD."
      testIdPrefix="prd-quality-feedback"
    />
  </div>
);

export default PrdQualityFeedbackTab;
