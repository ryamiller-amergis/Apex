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

function createOccurrenceId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }
  // jsdom / older runtimes — RFC4122 v4 fallback for FEAT-008 occurrence idempotency
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const n = (Math.random() * 16) | 0;
    const v = ch === 'x' ? n : (n & 0x3) | 0x8;
    return v.toString(16);
  });
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
  const lastStepChangeKeyRef = useRef<string | null>(null);
  const rendererRef = useRef<HTMLDivElement>(null);

  // Keep latest callbacks in refs so step effects do not re-fire when parents recreate closures.
  const onSeenRef = useRef(onSeen);
  const onStepChangeRef = useRef(onStepChange);
  const onCompleteRef = useRef(onComplete);
  const onDismissRef = useRef(onDismiss);
  const onAnchorMissRef = useRef(onAnchorMiss);
  /* eslint-disable react-hooks/refs -- keep latest callbacks without retriggering step effects */
  onSeenRef.current = onSeen;
  onStepChangeRef.current = onStepChange;
  onCompleteRef.current = onComplete;
  onDismissRef.current = onDismiss;
  onAnchorMissRef.current = onAnchorMiss;
  /* eslint-enable react-hooks/refs */

  useEffect(() => {
    // Reset playback-local UI state when the walkthrough identity or session changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional remount-equivalent reset for step/miss/seen
    setStepIndex(clampedInitial);
    seenRef.current = false;
    missKeysRef.current = new Set();
    lastStepChangeKeyRef.current = null;
  }, [definition.id, definition.revision, playbackSessionId, clampedInitial]);

  useEffect(() => {
    if (!open || typeof document === 'undefined' || !rendererRef.current) return;

    const rendererElement = rendererRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const lockedSiblings = Array.from(document.body.children)
      .filter((element) => element !== rendererElement)
      .map((element) => ({
        element,
        wasInert: element.hasAttribute('inert'),
      }));

    lockedSiblings.forEach(({ element }) => element.setAttribute('inert', ''));

    return () => {
      lockedSiblings.forEach(({ element, wasInert }) => {
        if (!wasInert) element.removeAttribute('inert');
      });
      previouslyFocused?.focus?.({ preventScroll: true });
    };
  }, [open, definition.id, definition.revision, playbackSessionId]);

  const step = steps[stepIndex] ?? null;
  const activationKey = `${definition.id}:${definition.revision}:${step?.id ?? 'none'}:${playbackSessionId}`;

  const anchorResult = useWalkthroughAnchorTarget({
    walkthroughId: definition.id,
    revision: definition.revision,
    stepId: step?.id ?? '',
    anchor: step?.anchor ?? null,
    stepRoute: step?.route ?? null,
    activationKey,
    enabled: open && (!!step?.anchor || !!step?.route),
  });

  useEffect(() => {
    if (!open || !step || seenRef.current) return;
    seenRef.current = true;
    safeCall(() =>
      onSeenRef.current?.({
        walkthroughId: definition.id,
        revision: definition.revision,
        stepId: step.id,
      }),
    );
  }, [open, step, definition.id, definition.revision]);

  useEffect(() => {
    if (!open || !step) return;
    const key = `${definition.id}:${definition.revision}:${step.id}:${stepIndex}`;
    if (lastStepChangeKeyRef.current === key) return;
    lastStepChangeKeyRef.current = key;
    safeCall(() =>
      onStepChangeRef.current?.({
        walkthroughId: definition.id,
        revision: definition.revision,
        stepId: step.id,
        stepIndex,
      }),
    );
  }, [open, step, stepIndex, definition.id, definition.revision]);

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
      occurrenceId: createOccurrenceId(),
    };
    safeCall(() => onAnchorMissRef.current?.(payload));
  }, [
    open,
    step,
    anchorResult.status,
    anchorResult.missReason,
    definition.id,
    definition.revision,
    playbackSessionId,
  ]);

  if (!open || stepCount === 0 || !step) return null;

  const goTo = (next: number) => {
    setStepIndex(Math.max(0, Math.min(next, stepCount - 1)));
  };

  const handleBack = () => goTo(stepIndex - 1);
  const handleNext = () => goTo(stepIndex + 1);
  const handleComplete = () => {
    safeCall(() =>
      onCompleteRef.current?.({
        walkthroughId: definition.id,
        revision: definition.revision,
        stepId: step.id,
      }),
    );
  };
  const handleDismiss = () => {
    safeCall(() =>
      onDismissRef.current?.({
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

  const locating =
    (!!step.anchor && anchorResult.locating) ||
    (!step.anchor && !!step.route && anchorResult.status === 'navigating');

  const announcement = locating
    ? 'Preparing guide…'
    : showFallbackNotice
      ? 'Anchor unavailable; showing centered guidance.'
      : `${step.heading}. Step ${stepIndex + 1} of ${stepCount}.`;

  const content = (
    <div
      ref={rendererRef}
      className={styles.renderer}
      {...{ 'data-testid': 'walkthrough-renderer' }}
    >
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
