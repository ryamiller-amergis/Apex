import React from 'react';
import { WORKFLOW_EVALUATION_DESIGN_DOC_STAGE_KEY } from '../../shared/types/workflowEvaluation';
import { QualityFeedbackForm } from './QualityFeedbackForm';
import { QualityFeedbackHistory } from './QualityFeedbackHistory';
import styles from './PrdQualityFeedbackTab.module.css';

export interface DesignDocQualityFeedbackTabProps {
  designDocId: string;
  project: string;
  updatedAt: string;
  canView: boolean;
  canSubmit: boolean;
  'data-testid'?: string;
}

const DesignDocQualityFeedbackTab: React.FC<DesignDocQualityFeedbackTabProps> = ({
  designDocId,
  project,
  updatedAt,
  canView,
  canSubmit,
  'data-testid': testId = 'design-doc-quality-feedback-panel',
}) => (
  <div className={styles.panel} {...{ 'data-testid': testId }}>
    <div>
      <h2 className={styles.title}>Quality feedback</h2>
      <p className={styles.intro}>
        Your feedback improves the AI over time. The design doc owner gives feedback before approving.
      </p>
    </div>
    <QualityFeedbackForm
      project={project}
      subjectType="design_doc"
      subjectId={designDocId}
      stageKey={WORKFLOW_EVALUATION_DESIGN_DOC_STAGE_KEY}
      canSubmit={canSubmit}
      correctedArtifact={{ label: 'Corrected design doc' }}
      successMessage="Feedback saved. It does not change this design doc."
      testIdPrefix="design-doc-quality-feedback"
      data-testid="design-doc-quality-feedback-form"
    />
    <QualityFeedbackHistory
      project={project}
      subjectType="design_doc"
      subjectId={designDocId}
      stageKey={WORKFLOW_EVALUATION_DESIGN_DOC_STAGE_KEY}
      canView={canView}
      subjectVersion={updatedAt}
      emptyMessage="No feedback yet for this version of the design doc."
      testIdPrefix="design-doc-quality-feedback"
    />
  </div>
);

export default DesignDocQualityFeedbackTab;
