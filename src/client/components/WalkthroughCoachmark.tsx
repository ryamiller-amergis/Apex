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

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

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
  const coachmarkRef = useRef<HTMLDivElement | null>(null);
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
      // crossAxis rescues the card back into the viewport when neither same-axis
      // side has room (e.g. an anchor taller than the viewport, like a full-page
      // document card). Without it, a top/bottom placement overflows the viewport
      // edge and the footer controls get clipped. Overlapping an oversized anchor
      // is acceptable; being cut off is not.
      shift({ crossAxis: true, padding: COACHMARK_VIEWPORT_PADDING_PX }),
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

  useEffect(() => {
    const coachmark = coachmarkRef.current;
    if (!coachmark) return;

    const focusable = coachmark.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    focusable[0]?.focus({ preventScroll: true });

    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const currentFocusable = coachmark.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
      if (currentFocusable.length === 0) {
        event.preventDefault();
        return;
      }

      const first = currentFocusable[0];
      const last = currentFocusable[currentFocusable.length - 1];
      if (!coachmark.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus({ preventScroll: true });
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };

    document.addEventListener('keydown', trapFocus);
    return () => document.removeEventListener('keydown', trapFocus);
  }, [step.id]);

  const arrowX = middlewareData.arrow?.x;
  const arrowY = middlewareData.arrow?.y;
  const side = context.placement.split('-')[0];

  return (
    <>
      <div
        className={styles.interactionShield}
        aria-hidden="true"
        onWheel={(event) => event.preventDefault()}
        {...{ 'data-testid': 'walkthrough-interaction-shield' }}
      />
      <div
        style={highlightStyle}
        className={styles.anchorHighlight}
        aria-hidden="true"
        {...{ 'data-testid': 'walkthrough-anchor-highlight' }}
      />
      <div
        ref={(node) => {
          coachmarkRef.current = node;
          refs.setFloating(node);
        }}
        style={floatingStyles}
        className={styles.coachmark}
        role="dialog"
        aria-modal="true"
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
