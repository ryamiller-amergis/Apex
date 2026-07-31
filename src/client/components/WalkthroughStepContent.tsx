import React, { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Link } from 'react-router-dom';
import { isValidInAppWalkthroughRoute } from '../../shared/walkthroughAnchors';
import { resolveThemedImageUrl } from '../../shared/walkthroughAssets';
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
  allowDismiss?: boolean;
  /**
   * When true, body content may scroll while Back/Next/Dismiss stay pinned
   * (coachmark chrome must never disappear behind an inner scrollbar).
   */
  stickyControls?: boolean;
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
  allowDismiss = true,
  stickyControls = false,
}) => {
  const [imageFailed, setImageFailed] = useState(false);
  const resolvedImageUrl = useMemo(() => {
    if (!step.imageUrl) return null;
    const theme = document.documentElement.getAttribute('data-theme') ?? 'light';
    return resolveThemedImageUrl(step.imageUrl, theme);
  }, [step.imageUrl]);
  const isFirst = stepIndex <= 0;
  const isLast = stepIndex >= stepCount - 1;
  const ctaSafe =
    step.ctaRoute &&
    step.ctaLabel &&
    isValidInAppWalkthroughRoute(step.ctaRoute)
      ? { label: step.ctaLabel, route: step.ctaRoute }
      : null;

  const body = (
    <>
      <h2 id={titleId} className={styles.heading} {...{ 'data-testid': 'walkthrough-step-title' }}>
        {step.heading}
      </h2>
      <div
        id={descriptionId}
        className={styles.body}
        {...{ 'data-testid': 'walkthrough-step-body' }}
      >
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{step.bodyMarkdown}</ReactMarkdown>
      </div>

      {locating && (
        <p
          className={styles.locating}
          {...{ 'data-testid': 'walkthrough-loading' }}
          aria-live="polite"
        >
          Preparing guide…
        </p>
      )}

      {showFallbackNotice && (
        <p
          className={styles.fallbackNotice}
          {...{ 'data-testid': 'walkthrough-anchor-fallback' }}
          role="status"
        >
          We couldn&apos;t find that spot in the UI, so here is the same guidance centered.
        </p>
      )}

      {resolvedImageUrl && !imageFailed ? (
        <img
          className={styles.image}
          src={resolvedImageUrl}
          alt={step.imageAlt || ''}
          onError={() => setImageFailed(true)}
        />
      ) : null}

      <p className={styles.progress} {...{ 'data-testid': 'walkthrough-step-position' }}>
        Step {stepIndex + 1} of {stepCount}
      </p>
    </>
  );

  const controls = (
    <div className={styles.controls} {...{ 'data-testid': 'walkthrough-step-controls' }}>
      <button
        type="button"
        className={styles.button}
        {...{ 'data-testid': 'walkthrough-previous' }}
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
          {...{ 'data-testid': 'walkthrough-next' }}
          onClick={onNext}
          aria-label="Next step"
        >
          Next
        </button>
      ) : (
        <button
          type="button"
          className={styles.buttonPrimary}
          {...{ 'data-testid': 'walkthrough-complete' }}
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
          {...{ 'data-testid': 'walkthrough-cta' }}
        >
          {ctaSafe.label}
        </Link>
      ) : null}
      {allowDismiss ? (
        <button
          type="button"
          className={styles.button}
          {...{ 'data-testid': 'walkthrough-close' }}
          onClick={onDismiss}
          aria-label="Dismiss walkthrough"
        >
          Dismiss
        </button>
      ) : null}
    </div>
  );

  if (!stickyControls) {
    return (
      <>
        {body}
        {controls}
      </>
    );
  }

  return (
    <div className={styles.coachmarkLayout}>
      <div className={styles.coachmarkScroll}>{body}</div>
      <div className={styles.coachmarkFooter}>{controls}</div>
    </div>
  );
};
