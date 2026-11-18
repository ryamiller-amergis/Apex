import React from 'react';
import type { PrdStatus } from '../../shared/types/interview';
import { WORKFLOW_EVALUATION_PRD_STAGE_KEY } from '../../shared/types/workflowEvaluation';
import { useAppShell } from '../hooks/useAppShell';
import { useWalkthroughOpen } from '../hooks/useWalkthroughOpen';
import { QualityFeedbackPromptController } from './QualityFeedbackPromptController';

export function isPrdFeedbackPromptEligible(status: PrdStatus): boolean {
  return status === 'pending_review' || status === 'reviewer_approved';
}

export interface PrdQualityFeedbackPromptProps {
  prdId: string;
  project: string;
  status: PrdStatus;
  userId: string;
  canSubmit: boolean;
  onOpenFeedbackTab: () => void;
}

const PrdQualityFeedbackPrompt: React.FC<PrdQualityFeedbackPromptProps> = ({
  prdId,
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
      subjectType="prd"
      subjectId={prdId}
      stageKey={WORKFLOW_EVALUATION_PRD_STAGE_KEY}
      subjectLabel="PRD"
      canSubmit={canSubmit}
      promptReady={isPrdFeedbackPromptEligible(status)}
      suppressModal={showChangelog || !whatsNewAutomaticOverlaySettled || walkthroughOpen}
      onOpenPanel={onOpenFeedbackTab}
      note="Your feedback improves the AI over time. The PRD owner gives feedback before approving."
      testIdPrefix="prd-quality-feedback"
    />
  );
};

export default PrdQualityFeedbackPrompt;
