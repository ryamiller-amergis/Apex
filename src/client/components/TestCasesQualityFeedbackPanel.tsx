import React from 'react';
import { WORKFLOW_EVALUATION_TEST_CASES_STAGE_KEY } from '../../shared/types/workflowEvaluation';
import { QualityFeedbackForm } from './QualityFeedbackForm';
import { QualityFeedbackHistory } from './QualityFeedbackHistory';
import styles from './PrdQualityFeedbackTab.module.css';

export interface TestCasesQualityFeedbackPanelProps {
  testCaseId: string;
  project: string;
  updatedAt: string;
  canView: boolean;
  canSubmit: boolean;
  'data-testid'?: string;
}

const TestCasesQualityFeedbackPanel: React.FC<TestCasesQualityFeedbackPanelProps> = ({
  testCaseId,
  project,
  updatedAt,
  canView,
  canSubmit,
  'data-testid': testId = 'test-cases-quality-feedback-panel',
}) => (
  <div className={styles.panel} {...{ 'data-testid': testId }}>
    <div>
      <h2 className={styles.title}>Test case feedback</h2>
      <p className={styles.intro}>
        Rate the generated test cases. QA approvers give feedback here before approving QA.
      </p>
    </div>
    <QualityFeedbackForm
      project={project}
      subjectType="test_cases"
      subjectId={testCaseId}
      stageKey={WORKFLOW_EVALUATION_TEST_CASES_STAGE_KEY}
      canSubmit={canSubmit}
      correctedArtifact={{ label: 'Corrected test cases' }}
      successMessage="Feedback saved. It does not change these test cases."
      testIdPrefix="test-cases-quality-feedback"
      data-testid="test-cases-quality-feedback-form"
    />
    <QualityFeedbackHistory
      project={project}
      subjectType="test_cases"
      subjectId={testCaseId}
      stageKey={WORKFLOW_EVALUATION_TEST_CASES_STAGE_KEY}
      canView={canView}
      subjectVersion={updatedAt}
      emptyMessage="No feedback yet for this version of the test cases."
      testIdPrefix="test-cases-quality-feedback"
    />
  </div>
);

export default TestCasesQualityFeedbackPanel;
