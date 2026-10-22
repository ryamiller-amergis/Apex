import React, { useEffect, useState } from 'react';
import type { PrdStatus } from '../../shared/types/interview';
import { WORKFLOW_EVALUATION_PRD_STAGE_KEY } from '../../shared/types/workflowEvaluation';
import { useAppShell } from '../hooks/useAppShell';
import { QualityFeedbackPromptController } from './QualityFeedbackPromptController';

export function isPrdFeedbackPromptEligible(status: PrdStatus): boolean {
  return status === 'pending_review' || status === 'reviewer_approved';
}

const WALKTHROUGH_SELECTOR = '[data-testid="walkthrough-renderer"]';

/** No app state says a walkthrough is on screen, so watch the DOM for its renderer. */
function useWalkthroughOpen(): boolean {
  const [open, setOpen] = useState(() => document.querySelector(WALKTHROUGH_SELECTOR) !== null);
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setOpen(document.querySelector(WALKTHROUGH_SELECTOR) !== null);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  return open;
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
      testIdPrefix="prd-quality-feedback"
    />
  );
};

export default PrdQualityFeedbackPrompt;
