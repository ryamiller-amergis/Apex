import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  arrow,
  autoUpdate,
  flip,
  offset,
  shift,
  size,
  useFloating,
} from '@floating-ui/react';
import type { WalkthroughAnchorPlacement } from '../../shared/types/walkthrough';
import type { WalkthroughRendererStep } from '../../shared/types/walkthrough';
import {
  buildAnchorHighlightStyle,
  COACHMARK_OFFSET_PX,
  COACHMARK_PREFERRED_HEIGHT_PX,
  COACHMARK_PREFERRED_WIDTH_PX,
  COACHMARK_VIEWPORT_PADDING_PX,
  getElementLayoutRect,
  getViewportSize,
  pickBestCoachmarkPlacement,
  resolveCoachmarkMaxHeight,
  resolveCoachmarkMaxWidth,
  sameAxisFallbackPlacements,
  scrollWalkthroughAnchorIntoView,
  type CoachmarkSide,
} from '../utils/walkthroughCoachmarkLayout';
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

function toFloatingPlacement(placement: WalkthroughAnchorPlacement): CoachmarkSide {
  if (placement === 'top' || placement === 'right' || placement === 'bottom' || placement === 'left') {
    return placement;
  }
  if (placement.startsWith('top')) return 'top';
  if (placement.startsWith('bottom')) return 'bottom';
  return 'bottom';
}

const ESTIMATED_FLOATING = {
  width: COACHMARK_PREFERRED_WIDTH_PX,
  height: COACHMARK_PREFERRED_HEIGHT_PX,
};

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
  const [highlightStyle, setHighlightStyle] = useState(() =>
    buildAnchorHighlightStyle(getElementLayoutRect(reference)),
  );

  const preferred = toFloatingPlacement(placement);

  // Always position against the registry target itself — never an inner heading.
  // Heading attachment placed cards *inside* large sections (Identity/Bio/Theme).
  const initialPlacement = useMemo(() => {
    try {
      return pickBestCoachmarkPlacement(
        preferred,
        getElementLayoutRect(reference),
        getViewportSize(),
        ESTIMATED_FLOATING,
      );
    } catch {
      return preferred;
    }
  }, [preferred, reference]);

  const { refs, floatingStyles, context, middlewareData, update } = useFloating({
    placement: initialPlacement,
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
    // Floating UI's documented arrow API takes a ref object; it does not read .current during render.
    // eslint-disable-next-line react-hooks/refs -- required by @floating-ui/react arrow({ element })
    middleware: [
      offset(COACHMARK_OFFSET_PX),
      flip({
        fallbackPlacements: sameAxisFallbackPlacements(initialPlacement),
        padding: COACHMARK_VIEWPORT_PADDING_PX,
      }),
      shift({ padding: COACHMARK_VIEWPORT_PADDING_PX }),
      size({
        padding: COACHMARK_VIEWPORT_PADDING_PX,
        apply({ availableWidth, availableHeight, elements }) {
          const maxWidth = resolveCoachmarkMaxWidth(availableWidth);
          const maxHeight = resolveCoachmarkMaxHeight(availableHeight, window.innerHeight);
          Object.assign(elements.floating.style, {
            width: `${maxWidth}px`,
            maxWidth: `${maxWidth}px`,
            maxHeight: `${maxHeight}px`,
          });
        },
      }),
      // eslint-disable-next-line react-hooks/refs -- Floating UI arrow middleware requires the ref object during render
            arrow({ element: arrowRef, padding: 12 }),
    ],
  });

  useEffect(() => {
    refs.setReference(reference);
  }, [reference, refs]);

  // Scroll page content into view when needed. Skips fixed/sticky header chrome
  // so the user menu does not jump.
  useEffect(() => {
    const didScroll = scrollWalkthroughAnchorIntoView(reference, {
      preferred,
      floating: ESTIMATED_FLOATING,
    });
    if (!didScroll) {
      update();
      return;
    }
    const timer = window.setTimeout(() => update(), 120);
    return () => window.clearTimeout(timer);
  }, [reference, preferred, step.id, update]);

  // Non-mutating highlight overlay — tracks the target rect without touching its styles.
  useLayoutEffect(() => {
    const sync = () => {
      setHighlightStyle(buildAnchorHighlightStyle(getElementLayoutRect(reference)));
    };
    sync();
    window.addEventListener('scroll', sync, true);
    window.addEventListener('resize', sync);
    return () => {
      window.removeEventListener('scroll', sync, true);
      window.removeEventListener('resize', sync);
    };
  }, [reference, step.id]);

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
    <>
      <div
        style={highlightStyle}
        className={styles.anchorHighlight}
        aria-hidden="true"
        {...{ 'data-testid': 'walkthrough-anchor-highlight' }}
      />
      <div
        ref={refs.setFloating}
        style={floatingStyles}
        className={styles.coachmark}
        role="region"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        data-placement={context.placement}
        {...{ 'data-testid': 'walkthrough-coachmark-step' }}
      >
        <div
          ref={arrowRef}
          className={styles.arrow}
          data-side={side}
          style={{
            left: arrowX != null ? `${arrowX}px` : '',
            top: arrowY != null ? `${arrowY}px` : '',
            [side === 'top'
              ? 'bottom'
              : side === 'bottom'
                ? 'top'
                : side === 'left'
                  ? 'right'
                  : 'left']: '-5px',
          }}
          aria-hidden="true"
        />
        <WalkthroughStepContent
          step={step}
          stepIndex={stepIndex}
          stepCount={stepCount}
          titleId={titleId}
          descriptionId={descriptionId}
          stickyControls
          onBack={onBack}
          onNext={onNext}
          onComplete={onComplete}
          onDismiss={onDismiss}
        />
      </div>
    </>
  );
};
