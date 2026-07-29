import React, { useEffect, useRef } from 'react';
import type { WalkthroughRendererStep } from '../../shared/types/walkthrough';
import { WalkthroughStepContent } from './WalkthroughStepContent';
import styles from './WalkthroughRenderer.module.css';

export interface WalkthroughModalStepProps {
  step: WalkthroughRendererStep;
  stepIndex: number;
  stepCount: number;
  locating?: boolean;
  showFallbackNotice?: boolean;
  onBack: () => void;
  onNext: () => void;
  onComplete: () => void;
  onDismiss: () => void;
  /** When false, Escape does not dismiss (caller may still close via button). */
  allowEscapeDismiss?: boolean;
}

export const WalkthroughModalStep: React.FC<WalkthroughModalStepProps> = ({
  step,
  stepIndex,
  stepCount,
  locating = false,
  showFallbackNotice = false,
  onBack,
  onNext,
  onComplete,
  onDismiss,
  allowEscapeDismiss = true,
}) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const titleId = `walkthrough-step-title-${step.id}`;
  const descriptionId = `walkthrough-step-desc-${step.id}`;

  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement as HTMLElement | null;
    const focusTimer = window.setTimeout(() => {
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      );
      focusable?.[0]?.focus();
    }, 0);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && allowEscapeDismiss) {
        event.preventDefault();
        onDismiss();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocusedRef.current?.focus?.();
    };
  }, [allowEscapeDismiss, onDismiss, step.id]);

  return (
    <>
      <button
        type="button"
        className={styles.overlay}
        aria-label="Walkthrough backdrop"
        tabIndex={-1}
        {...{ 'data-testid': 'walkthrough-modal-overlay' }}
      />
      <div
        ref={dialogRef}
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        {...{ 'data-testid': 'walkthrough-modal-step' }}
      >
        <WalkthroughStepContent
          step={step}
          stepIndex={stepIndex}
          stepCount={stepCount}
          locating={locating}
          showFallbackNotice={showFallbackNotice}
          titleId={titleId}
          descriptionId={descriptionId}
          onBack={onBack}
          onNext={onNext}
          onComplete={onComplete}
          onDismiss={onDismiss}
        />
      </div>
    </>
  );
};
