import React, { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  DEFAULT_WALKTHROUGH_AI_POLICY_PRESET,
  WALKTHROUGH_AI_POLICY_PRESETS,
  resolveWalkthroughAiPolicyPreset,
  type WalkthroughAiPolicyPresetId,
  type WalkthroughAiProposalUnit,
} from '../../shared/types/walkthroughAiDraft';
import type { WalkthroughStepInput } from '../../shared/types/walkthrough';
import {
  useGenerateWalkthroughAiStep,
  useValidateWalkthroughAiUnit,
} from '../hooks/useWalkthroughAiDraft';
import { useWalkthroughAnchors } from '../hooks/usePlatformAdminWalkthroughs';
import { useWalkthroughsAiOptions } from '../contexts/WalkthroughsAiOptionsContext';
import styles from './WalkthroughAuthoring.module.css';

export interface AiStepBuilderModalProps {
  projectId: string;
  /** Existing walkthrough draft context (guides tone; prevents duplicate steps). */
  existingDraft: {
    internalName: string;
    userTitle: string;
    whyItMatters: string;
    steps: WalkthroughStepInput[];
  };
  /** Number of steps currently in the editor (bounds the insert-position options). */
  stepCount: number;
  /** Inject the accepted step at the chosen 0-based index (0…stepCount). */
  onInsert: (index: number, step: WalkthroughStepInput) => void;
  onClose: () => void;
}

type StepUnit = Extract<WalkthroughAiProposalUnit, { kind: 'step' }>;

function isStepUnit(unit: WalkthroughAiProposalUnit | null): unit is StepUnit {
  return unit?.kind === 'step';
}

function unitValueToStepInput(unit: StepUnit): WalkthroughStepInput {
  const v = unit.value;
  return {
    id: v.id,
    ordinal: v.ordinal,
    heading: v.heading,
    bodyMarkdown: v.bodyMarkdown,
    route: v.route ?? v.anchor?.targetRoute ?? null,
    imageUrl: v.imageUrl ?? null,
    imageAlt: v.imageAlt ?? null,
    ctaLabel: v.ctaLabel ?? null,
    ctaRoute: v.ctaRoute ?? null,
    anchor: v.anchor ?? null,
  };
}

/** Strip the anchor so the step renders as a centered modal (no coachmark). */
function asCenteredUnit(unit: StepUnit): StepUnit {
  return { ...unit, value: { ...unit.value, anchor: null } };
}

export const AiStepBuilderModal: React.FC<AiStepBuilderModalProps> = ({
  projectId,
  existingDraft,
  stepCount,
  onInsert,
  onClose,
}) => {
  const anchorsQuery = useWalkthroughAnchors();
  const generateMutation = useGenerateWalkthroughAiStep();
  const validateMutation = useValidateWalkthroughAiUnit();
  const { walkthroughGenerationModel } = useWalkthroughsAiOptions();

  const [intent, setIntent] = useState('');
  const [policyPreset, setPolicyPreset] = useState<WalkthroughAiPolicyPresetId>(
    DEFAULT_WALKTHROUGH_AI_POLICY_PRESET,
  );
  const [proposedUnit, setProposedUnit] = useState<WalkthroughAiProposalUnit | null>(null);
  const [acceptedUnit, setAcceptedUnit] = useState<StepUnit | null>(null);
  const [useCentered, setUseCentered] = useState(false);
  const [imageConfirmed, setImageConfirmed] = useState(false);
  const [insertPosition, setInsertPosition] = useState(stepCount);
  const [statusMessage, setStatusMessage] = useState('');
  const [isError, setIsError] = useState(false);

  const selectedPolicy = resolveWalkthroughAiPolicyPreset(policyPreset);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const anchorLabel = (key: string | undefined): string | null => {
    if (!key) return null;
    return anchorsQuery.data?.find((a) => a.key === key)?.label ?? key;
  };

  const positionOptions = useMemo(() => {
    const options: Array<{ value: number; label: string }> = [];
    options.push({ value: 0, label: stepCount === 0 ? 'As the first step' : 'At the beginning' });
    for (let k = 1; k <= stepCount; k += 1) {
      options.push({
        value: k,
        label: k === stepCount ? `After step ${k} (at the end)` : `After step ${k}`,
      });
    }
    return options;
  }, [stepCount]);

  const proposedStep = isStepUnit(proposedUnit) ? proposedUnit.value : null;
  const isBusy = generateMutation.isPending || validateMutation.isPending;

  const handleGenerate = async () => {
    if (!projectId.trim()) {
      setIsError(true);
      setStatusMessage('Select at least one project target before generating a step.');
      return;
    }
    const trimmed = intent.trim();
    if (!trimmed) {
      setIsError(true);
      setStatusMessage('Describe what the new step should cover.');
      return;
    }
    setIsError(false);
    setStatusMessage('Generating step…');
    setAcceptedUnit(null);
    try {
      const model = walkthroughGenerationModel.trim();
      const result = await generateMutation.mutateAsync({
        projectId,
        intent: trimmed,
        policyPreset,
        ...(model ? { model } : {}),
        existingDraft,
      });
      setProposedUnit(result.unit);
      setUseCentered(!isStepUnit(result.unit) || !result.unit.value.anchor?.key);
      setImageConfirmed(false);
      setStatusMessage('Step generated. Review it, then accept or reject.');
    } catch (err) {
      setIsError(true);
      const base = err instanceof Error ? err.message : 'Generation failed. Nothing was added to the walkthrough.';
      setStatusMessage(`${base} You can close this and build the step by hand with “Add step”.`);
    }
  };

  const handleAccept = async () => {
    if (!isStepUnit(proposedUnit)) return;
    const unit = useCentered ? asCenteredUnit(proposedUnit) : proposedUnit;
    setIsError(false);
    try {
      const result = await validateMutation.mutateAsync({
        projectId,
        unit,
        imageConfirmed,
      });
      if (!isStepUnit(result.normalizedUnit)) {
        throw new Error('Unexpected non-step unit returned from validation.');
      }
      setAcceptedUnit(result.normalizedUnit);
      setInsertPosition(stepCount);
      setStatusMessage('Step accepted. Choose where to insert it, then click Insert step.');
    } catch (err) {
      setIsError(true);
      setStatusMessage(err instanceof Error ? err.message : 'Validation failed.');
    }
  };

  const handleReject = () => {
    setProposedUnit(null);
    setAcceptedUnit(null);
    setUseCentered(false);
    setImageConfirmed(false);
    setIsError(false);
    setStatusMessage('Proposal discarded. Edit the description and generate again.');
  };

  const handleInsert = () => {
    if (!acceptedUnit) return;
    onInsert(insertPosition, unitValueToStepInput(acceptedUnit));
    onClose();
  };

  const presets = Object.values(WALKTHROUGH_AI_POLICY_PRESETS);
  const imageCandidate = proposedStep?.imageCandidatePath ?? proposedStep?.imageUrl ?? null;

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- backdrop click-to-dismiss; Escape handled separately (matches lifecycle dialog)
    <div
      className={styles.dialogOverlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby="ai-step-builder-title"
      {...{ 'data-testid': 'ai-step-builder-modal' }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={`${styles.dialog} ${styles.dialogWide}`}>
        <div>
          <h3 id="ai-step-builder-title" className={styles.dialogTitle}>
            Build a step with AI
          </h3>
          <p className={styles.dialogBody}>
            Describe the one step you want to add. The AI proposes a single step; nothing is added
            until you accept it and choose where to insert it.
          </p>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="ai-step-policy">
            Generation policy
          </label>
          <select
            id="ai-step-policy"
            className={styles.select}
            value={policyPreset}
            disabled={isBusy}
            onChange={(event) => setPolicyPreset(event.target.value as WalkthroughAiPolicyPresetId)}
            {...{ 'data-testid': 'ai-step-policy' }}
          >
            {presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label} — {preset.description}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="ai-step-intent">
            What should this step cover?
          </label>
          <textarea
            id="ai-step-intent"
            className={styles.textarea}
            placeholder="Example: Show where to click Regenerate to refresh a design module doc from source."
            maxLength={selectedPolicy.maxIntentLength}
            value={intent}
            disabled={isBusy}
            onChange={(event) => setIntent(event.target.value)}
            {...{ 'data-testid': 'ai-step-intent' }}
          />
        </div>

        <div className={styles.dialogActions}>
          <button
            type="button"
            className={styles.buttonPrimary}
            disabled={isBusy}
            onClick={handleGenerate}
            {...{ 'data-testid': 'ai-step-generate' }}
          >
            {generateMutation.isPending
              ? 'Generating…'
              : proposedUnit
                ? 'Regenerate step'
                : 'Generate step'}
          </button>
        </div>

        <p
          className={isError ? styles.fieldError : styles.statusMessage}
          aria-live="polite"
          {...{ 'data-testid': 'ai-step-status' }}
        >
          {statusMessage || 'Describe the step, then generate a proposal.'}
        </p>

        {proposedStep ? (
          <section className={styles.stepCard} {...{ 'data-testid': 'ai-step-proposal' }}>
            <div className={styles.stepHeader}>
              <h4 className={styles.stepTitle}>{proposedStep.heading || 'Proposed step'}</h4>
            </div>

            <div className={styles.preview}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {proposedStep.bodyMarkdown || '_No content_'}
              </ReactMarkdown>
            </div>

            {proposedStep.anchor?.key && !useCentered ? (
              <span className={styles.aiBadge} {...{ 'data-testid': 'ai-step-anchor-badge' }}>
                Anchor: {anchorLabel(proposedStep.anchor.key)} ({proposedStep.anchor.targetRoute},{' '}
                {proposedStep.anchor.placement})
              </span>
            ) : (
              <span className={styles.aiBadge} {...{ 'data-testid': 'ai-step-centered-badge' }}>
                Centered step (no coachmark)
              </span>
            )}

            {proposedStep.anchor?.key ? (
              <div className={styles.field}>
                <label className={styles.label}>
                  <input
                    type="checkbox"
                    checked={useCentered}
                    disabled={isBusy || !!acceptedUnit}
                    onChange={(event) => setUseCentered(event.target.checked)}
                    {...{ 'data-testid': 'ai-step-use-centered' }}
                  />{' '}
                  Use a centered step instead (ignore the suggested anchor)
                </label>
              </div>
            ) : null}

            {imageCandidate ? (
              <div className={styles.field}>
                <img className={styles.previewImage} src={imageCandidate} alt={proposedStep.imageAlt ?? ''} />
                <label className={styles.label}>
                  <input
                    type="checkbox"
                    checked={imageConfirmed}
                    disabled={isBusy || !!acceptedUnit}
                    onChange={(event) => setImageConfirmed(event.target.checked)}
                    {...{ 'data-testid': 'ai-step-image-confirm' }}
                  />{' '}
                  Include image {imageCandidate}
                </label>
              </div>
            ) : null}

            {!acceptedUnit ? (
              <div className={styles.dialogActions}>
                <button
                  type="button"
                  className={styles.button}
                  disabled={isBusy}
                  onClick={handleReject}
                  {...{ 'data-testid': 'ai-step-reject' }}
                >
                  Reject
                </button>
                <button
                  type="button"
                  className={styles.buttonPrimary}
                  disabled={isBusy}
                  onClick={handleAccept}
                  {...{ 'data-testid': 'ai-step-accept' }}
                >
                  {validateMutation.isPending ? 'Checking…' : 'Accept'}
                </button>
              </div>
            ) : (
              <div className={styles.positionRow}>
                <div className={styles.field}>
                  <label className={styles.label} htmlFor="ai-step-position">
                    Where should this step go?
                  </label>
                  <select
                    id="ai-step-position"
                    className={styles.select}
                    value={insertPosition}
                    onChange={(event) => setInsertPosition(Number(event.target.value))}
                    {...{ 'data-testid': 'ai-step-position' }}
                  >
                    {positionOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  className={styles.buttonPrimary}
                  onClick={handleInsert}
                  {...{ 'data-testid': 'ai-step-insert' }}
                >
                  Insert step
                </button>
              </div>
            )}
          </section>
        ) : null}

        <div className={styles.dialogActions}>
          <button
            type="button"
            className={styles.button}
            onClick={onClose}
            {...{ 'data-testid': 'ai-step-cancel' }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
