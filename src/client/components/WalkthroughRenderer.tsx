import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  WalkthroughAnchorMiss,
  WalkthroughRendererCallbacks,
  WalkthroughRendererDefinition,
} from '../../shared/types/walkthrough';
import { DEFAULT_WALKTHROUGH_PLACEMENT } from '../../shared/walkthroughAnchors';
import { useWalkthroughAnchorTarget } from '../hooks/useWalkthroughAnchorTarget';
import { WalkthroughCoachmark } from './WalkthroughCoachmark';
import { WalkthroughModalStep } from './WalkthroughModalStep';
import styles from './WalkthroughRenderer.module.css';

export interface WalkthroughRendererProps extends WalkthroughRendererCallbacks {
  definition: WalkthroughRendererDefinition;
  /** 0-based initial step index. */
  initialStepIndex?: number;
  open?: boolean;
  /** Unique per playback session so miss dedupe resets on voluntary replay. */
  playbackSessionId?: string;
}

function sortSteps(definition: WalkthroughRendererDefinition) {
  return [...definition.steps].sort((a, b) => a.position - b.position);
}

function safeCall(fn: (() => void) | undefined): void {
  if (!fn) return;
  try {
    fn();
  } catch {
    // Callback failures must preserve visible Step content (FEAT-002).
  }
}

export const WalkthroughRenderer: React.FC<WalkthroughRendererProps> = ({
  definition,
  initialStepIndex = 0,
  open = true,
  playbackSessionId = 'default',
  onSeen,
  onStepChange,
  onComplete,
  onDismiss,
  onAnchorMiss,
}) => {
  const steps = useMemo(() => sortSteps(definition), [definition]);
  const stepCount = steps.length;
  const clampedInitial = Math.max(0, Math.min(initialStepIndex, Math.max(stepCount - 1, 0)));
  const [stepIndex, setStepIndex] = useState(clampedInitial);
  const seenRef = useRef(false);
  const missKeysRef = useRef(new Set<string>());

  useEffect(() => {
    // Reset playback-local UI state when the walkthrough identity or session changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional remount-equivalent reset for step/miss/seen
    setStepIndex(clampedInitial);
    seenRef.current = false;
    missKeysRef.current = new Set();
  }, [definition.id, definition.revision, playbackSessionId, clampedInitial]);

  const step = steps[stepIndex] ?? null;
  const activationKey = `${definition.id}:${definition.revision}:${step?.id ?? 'none'}:${playbackSessionId}`;

  const anchorResult = useWalkthroughAnchorTarget({
    walkthroughId: definition.id,
    revision: definition.revision,
    stepId: step?.id ?? '',
    anchor: step?.anchor ?? null,
    activationKey,
    enabled: open && !!step?.anchor,
  });

  useEffect(() => {
    if (!open || !step || seenRef.current) return;
    seenRef.current = true;
    safeCall(() =>
      onSeen?.({
        walkthroughId: definition.id,
        revision: definition.revision,
        stepId: step.id,
      }),
    );
  }, [open, step, definition.id, definition.revision, onSeen]);

  useEffect(() => {
    if (!open || !step) return;
    safeCall(() =>
      onStepChange?.({
        walkthroughId: definition.id,
        revision: definition.revision,
        stepId: step.id,
        stepIndex,
      }),
    );
  }, [open, step, stepIndex, definition.id, definition.revision, onStepChange]);

  useEffect(() => {
    if (!open || !step?.anchor) return;
    if (anchorResult.status !== 'fallback' || !anchorResult.missReason) return;
    const key = `${definition.id}:${definition.revision}:${step.id}:${playbackSessionId}`;
    if (missKeysRef.current.has(key)) return;
    missKeysRef.current.add(key);
    const payload: WalkthroughAnchorMiss = {
      walkthroughId: definition.id,
      revision: definition.revision,
      stepId: step.id,
      anchorKey: step.anchor.key,
      targetRoute: step.anchor.targetRoute,
      reason: anchorResult.missReason,
      clientTimestamp: new Date().toISOString(),
    };
    safeCall(() => onAnchorMiss?.(payload));
  }, [
    open,
    step,
    anchorResult.status,
    anchorResult.missReason,
    definition.id,
    definition.revision,
    playbackSessionId,
    onAnchorMiss,
  ]);

  if (!open || stepCount === 0 || !step) return null;

  const goTo = (next: number) => {
    setStepIndex(Math.max(0, Math.min(next, stepCount - 1)));
  };

  const handleBack = () => goTo(stepIndex - 1);
  const handleNext = () => goTo(stepIndex + 1);
  const handleComplete = () => {
    safeCall(() =>
      onComplete?.({
        walkthroughId: definition.id,
        revision: definition.revision,
        stepId: step.id,
      }),
    );
  };
  const handleDismiss = () => {
    safeCall(() =>
      onDismiss?.({
        walkthroughId: definition.id,
        revision: definition.revision,
        stepId: step.id,
      }),
    );
  };

  const useCoachmark =
    !!step.anchor &&
    anchorResult.status === 'resolved' &&
    anchorResult.targetElement != null;

  const showFallbackNotice =
    !!step.anchor &&
    (anchorResult.status === 'fallback' ||
      (!!anchorResult.missReason && anchorResult.status !== 'resolved'));

  const locating = !!step.anchor && anchorResult.locating;

  const announcement = locating
    ? 'Preparing guide…'
    : showFallbackNotice
      ? 'Anchor unavailable; showing centered guidance.'
      : `${step.heading}. Step ${stepIndex + 1} of ${stepCount}.`;

  const content = (
    <div className={styles.renderer} {...{ 'data-testid': 'walkthrough-renderer' }}>
      <div className={styles.liveRegion} aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
      {useCoachmark ? (
        <WalkthroughCoachmark
          step={step}
          stepIndex={stepIndex}
          stepCount={stepCount}
          reference={anchorResult.targetElement!}
          placement={step.anchor?.placement ?? DEFAULT_WALKTHROUGH_PLACEMENT}
          onBack={handleBack}
          onNext={handleNext}
          onComplete={handleComplete}
          onDismiss={handleDismiss}
        />
      ) : (
        <WalkthroughModalStep
          step={step}
          stepIndex={stepIndex}
          stepCount={stepCount}
          locating={locating}
          showFallbackNotice={showFallbackNotice}
          onBack={handleBack}
          onNext={handleNext}
          onComplete={handleComplete}
          onDismiss={handleDismiss}
        />
      )}
    </div>
  );

  if (typeof document === 'undefined') return content;
  return createPortal(content, document.body);
};
