import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Link } from 'react-router-dom';
import { isValidInAppWalkthroughRoute } from '../../shared/walkthroughAnchors';
import type { WalkthroughRendererStep } from '../../shared/types/walkthrough';
import styles from './WalkthroughRenderer.module.css';

export interface WalkthroughStepContentProps {
  step: WalkthroughRendererStep;
  stepIndex: number;
  stepCount: number;
  locating?: boolean;
  showFallbackNotice?: boolean;
  titleId: string;
  descriptionId: string;
  onBack: () => void;
  onNext: () => void;
  onComplete: () => void;
  onDismiss: () => void;
}

export const WalkthroughStepContent: React.FC<WalkthroughStepContentProps> = ({
  step,
  stepIndex,
  stepCount,
  locating = false,
  showFallbackNotice = false,
  titleId,
  descriptionId,
  onBack,
  onNext,
  onComplete,
  onDismiss,
}) => {
  const [imageFailed, setImageFailed] = useState(false);
  const isFirst = stepIndex <= 0;
  const isLast = stepIndex >= stepCount - 1;
  const ctaSafe =
    step.ctaRoute &&
    step.ctaLabel &&
    isValidInAppWalkthroughRoute(step.ctaRoute)
      ? { label: step.ctaLabel, route: step.ctaRoute }
      : null;

  return (
    <>
      <h2 id={titleId} className={styles.heading}>
        {step.heading}
      </h2>
      <div id={descriptionId} className={styles.body}>
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{step.bodyMarkdown}</ReactMarkdown>
      </div>

      {locating && (
        <p className={styles.locating} data-testid="walkthrough-locating-target" aria-live="polite">
          Locating this feature…
        </p>
      )}

      {showFallbackNotice && (
        <p
          className={styles.fallbackNotice}
          data-testid="walkthrough-anchor-fallback"
          role="status"
        >
          We couldn&apos;t find that spot in the UI, so here is the same guidance centered.
        </p>
      )}

      {step.imageUrl && !imageFailed ? (
        <img
          className={styles.image}
          src={step.imageUrl}
          alt=""
          onError={() => setImageFailed(true)}
        />
      ) : null}

      <p className={styles.progress} data-testid="walkthrough-step-progress">
        Step {stepIndex + 1} of {stepCount}
      </p>

      <div className={styles.controls}>
        <button
          type="button"
          className={styles.button}
          data-testid="walkthrough-back"
          onClick={onBack}
          disabled={isFirst}
          aria-label="Previous step"
        >
          Back
        </button>
        {!isLast ? (
          <button
            type="button"
            className={styles.buttonPrimary}
            data-testid="walkthrough-next"
            onClick={onNext}
            aria-label="Next step"
          >
            Next
          </button>
        ) : (
          <button
            type="button"
            className={styles.buttonPrimary}
            data-testid="walkthrough-complete"
            onClick={onComplete}
            aria-label="Complete walkthrough"
          >
            Complete
          </button>
        )}
        <span className={styles.controlsSpacer} />
        {ctaSafe ? (
          <Link
            className={styles.cta}
            to={ctaSafe.route}
            data-testid="walkthrough-cta"
          >
            {ctaSafe.label}
          </Link>
        ) : null}
        <button
          type="button"
          className={styles.button}
          data-testid="walkthrough-dismiss"
          onClick={onDismiss}
          aria-label="Dismiss walkthrough"
        >
          Dismiss
        </button>
      </div>
    </>
  );
};
