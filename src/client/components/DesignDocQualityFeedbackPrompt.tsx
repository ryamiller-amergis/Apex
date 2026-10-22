import React from 'react';
import type { DesignDocStatus } from '../../shared/types/interview';
import { WORKFLOW_EVALUATION_DESIGN_DOC_STAGE_KEY } from '../../shared/types/workflowEvaluation';
import { useAppShell } from '../hooks/useAppShell';
import { useWalkthroughOpen } from '../hooks/useWalkthroughOpen';
import { QualityFeedbackPromptController } from './QualityFeedbackPromptController';

export function isDesignDocFeedbackPromptEligible(status: DesignDocStatus): boolean {
  return status === 'pending_review' || status === 'reviewer_approved';
}

export interface DesignDocQualityFeedbackPromptProps {
  designDocId: string;
  project: string;
  status: DesignDocStatus;
  userId: string;
  canSubmit: boolean;
  onOpenFeedbackTab: () => void;
}

const DesignDocQualityFeedbackPrompt: React.FC<DesignDocQualityFeedbackPromptProps> = ({
  designDocId,
  project,
  status,
  userId,
  canSubmit,
  onOpenFeedbackTab,
}) => {
  const { showChangelog, whatsNewAutomaticOverlaySettled } = useAppShell();
  const walkthroughOpen = useWalkthroughOpen();

  return (
    <QualityFeedbackPromptController
      enabled
      project={project}
      userId={userId}
      subjectType="design_doc"
      subjectId={designDocId}
      stageKey={WORKFLOW_EVALUATION_DESIGN_DOC_STAGE_KEY}
      subjectLabel="design doc"
      canSubmit={canSubmit}
      promptReady={isDesignDocFeedbackPromptEligible(status)}
      suppressModal={showChangelog || !whatsNewAutomaticOverlaySettled || walkthroughOpen}
      onOpenPanel={onOpenFeedbackTab}
      note="Your feedback improves the AI over time. The design doc owner gives feedback before approving."
      testIdPrefix="design-doc-quality-feedback"
    />
  );
};

export default DesignDocQualityFeedbackPrompt;
