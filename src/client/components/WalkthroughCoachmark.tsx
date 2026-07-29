import React, { useEffect, useRef } from 'react';
import {
  arrow,
  autoUpdate,
  flip,
  offset,
  shift,
  useFloating,
} from '@floating-ui/react';
import type { WalkthroughAnchorPlacement } from '../../shared/types/walkthrough';
import type { WalkthroughRendererStep } from '../../shared/types/walkthrough';
import { WalkthroughStepContent } from './WalkthroughStepContent';
import styles from './WalkthroughRenderer.module.css';

export interface WalkthroughCoachmarkProps {
  step: WalkthroughRendererStep;
  stepIndex: number;
  stepCount: number;
  reference: Element;
  placement: WalkthroughAnchorPlacement;
  onBack: () => void;
  onNext: () => void;
  onComplete: () => void;
  onDismiss: () => void;
}

function toFloatingPlacement(
  placement: WalkthroughAnchorPlacement,
): 'top' | 'right' | 'bottom' | 'left' {
  if (placement === 'top' || placement === 'right' || placement === 'bottom' || placement === 'left') {
    return placement;
  }
  if (placement.startsWith('top')) return 'top';
  if (placement.startsWith('bottom')) return 'bottom';
  return 'bottom';
}

export const WalkthroughCoachmark: React.FC<WalkthroughCoachmarkProps> = ({
  step,
  stepIndex,
  stepCount,
  reference,
  placement,
  onBack,
  onNext,
  onComplete,
  onDismiss,
}) => {
  const arrowRef = useRef<HTMLDivElement>(null);
  const titleId = `walkthrough-step-title-${step.id}`;
  const descriptionId = `walkthrough-step-desc-${step.id}`;

  const { refs, floatingStyles, context, middlewareData } = useFloating({
    placement: toFloatingPlacement(placement),
    whileElementsMounted: autoUpdate,
    // Floating UI's documented arrow API takes a ref object; it does not read .current during render.
    // eslint-disable-next-line react-hooks/refs -- required by @floating-ui/react arrow({ element })
    middleware: [offset(12), flip(), shift({ padding: 8 }), arrow({ element: arrowRef })],
  });

  useEffect(() => {
    refs.setReference(reference);
  }, [reference, refs]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onDismiss();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onDismiss]);

  const arrowX = middlewareData.arrow?.x;
  const arrowY = middlewareData.arrow?.y;
  const side = context.placement.split('-')[0];

  return (
    <div
      ref={refs.setFloating}
      style={floatingStyles}
      className={styles.coachmark}
      role="region"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      {...{ 'data-testid': 'walkthrough-coachmark-step' }}
    >
      <div
        ref={arrowRef}
        className={styles.arrow}
        style={{
          left: arrowX != null ? `${arrowX}px` : '',
          top: arrowY != null ? `${arrowY}px` : '',
          [side === 'top' ? 'bottom' : side === 'bottom' ? 'top' : side === 'left' ? 'right' : 'left']:
            '-5px',
        }}
        aria-hidden="true"
      />
      <WalkthroughStepContent
        step={step}
        stepIndex={stepIndex}
        stepCount={stepCount}
        titleId={titleId}
        descriptionId={descriptionId}
        onBack={onBack}
        onNext={onNext}
        onComplete={onComplete}
        onDismiss={onDismiss}
      />
    </div>
  );
};
