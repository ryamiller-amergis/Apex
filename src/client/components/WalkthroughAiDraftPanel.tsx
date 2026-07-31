import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  DEFAULT_WALKTHROUGH_AI_POLICY_PRESET,
  mergeAcceptedUnitsIntoDraft,
  resolveWalkthroughAiPolicyPreset,
  type WalkthroughAiEditableDraftSlice,
  type WalkthroughAiPolicyPresetId,
  type WalkthroughAiProposal,
  type WalkthroughAiProposalUnit,
  type WalkthroughAiUnitDecision,
} from '../../shared/types/walkthroughAiDraft';
import type { WalkthroughGenerationProvenance } from '../../shared/types/walkthrough';
import {
  useGenerateWalkthroughAiDraft,
  useRedoWalkthroughAiUnit,
  useValidateWalkthroughAiUnit,
  useWalkthroughAiPolicyPresets,
  useWalkthroughAnchorMatches,
  useStartAnchorDiscovery,
  type WalkthroughAnchorMatchCandidate,
} from '../hooks/useWalkthroughAiDraft';
import { useWalkthroughAnchors } from '../hooks/usePlatformAdminWalkthroughs';
import { useCreateManualAnchor } from '../hooks/usePlatformAdminAnchorRegistry';
import { useWalkthroughsAiOptions } from '../contexts/WalkthroughsAiOptionsContext';
import type { WalkthroughAnchorDiscoveryProposal } from '../../shared/types/walkthroughAnchorDiscovery';
import type { WalkthroughRegistryPlacement } from '../../shared/walkthroughAnchors';
import styles from './WalkthroughAiDraft.module.css';

interface WalkthroughAiDraftPanelProps {
  projectId: string;
  currentDraft: WalkthroughAiEditableDraftSlice;
  onMergeDraft: (next: WalkthroughAiEditableDraftSlice) => void;
  /** Landmark id for pre-commit / E2E; defaults to design-spec value. */
  'data-testid'?: string;
}

interface IntentFormValues {
  intent: string;
  policyPreset: WalkthroughAiPolicyPresetId;
}

function unitTitle(unit: WalkthroughAiProposalUnit): string {
  if (unit.kind === 'walkthrough-fields') {
    return 'Walkthrough fields';
  }
  return unit.value.heading || 'Step';
}

export const WalkthroughAiDraftPanel: React.FC<WalkthroughAiDraftPanelProps> = ({
  projectId,
  currentDraft,
  onMergeDraft,
  'data-testid': testId = 'walkthrough-ai-draft-panel',
}) => {
  const presetsQuery = useWalkthroughAiPolicyPresets();
  const generateMutation = useGenerateWalkthroughAiDraft();
  const redoMutation = useRedoWalkthroughAiUnit();
  const validateMutation = useValidateWalkthroughAiUnit();
  const matchesMutation = useWalkthroughAnchorMatches();
  const discoveryMutation = useStartAnchorDiscovery();
  const createManualAnchor = useCreateManualAnchor();
  const anchorsQuery = useWalkthroughAnchors();
  const {
    walkthroughGenerationModel,
    walkthroughGenerationSkillPath,
    anchorDiscoveryModel,
    anchorDiscoverySkillPath,
  } = useWalkthroughsAiOptions();

  const anchorLabel = (key: string | undefined): string | null => {
    if (!key) return null;
    return anchorsQuery.data?.find((a) => a.key === key)?.label ?? key;
  };

  const [proposal, setProposal] = useState<WalkthroughAiProposal | null>(null);
  const [decisions, setDecisions] = useState<Record<string, WalkthroughAiUnitDecision>>({});
  const [acceptedNormalized, setAcceptedNormalized] = useState<WalkthroughAiProposalUnit[]>([]);
  const [statusMessage, setStatusMessage] = useState('');
  const [unitErrors, setUnitErrors] = useState<Record<string, string>>({});
  const [redoingUnitId, setRedoingUnitId] = useState<string | null>(null);
  const [provenance, setProvenance] = useState<WalkthroughGenerationProvenance | null>(null);
  const [pickerOpenForUnitId, setPickerOpenForUnitId] = useState<string | null>(null);
  const [rankedByUnitId, setRankedByUnitId] = useState<
    Record<string, WalkthroughAnchorMatchCandidate[]>
  >({});
  const [discoveryByUnitId, setDiscoveryByUnitId] = useState<
    Record<string, WalkthroughAnchorDiscoveryProposal[]>
  >({});
  const [busyUnitId, setBusyUnitId] = useState<string | null>(null);
  const reviewHeadingRef = useRef<HTMLHeadingElement | null>(null);

  const [policyPreset, setPolicyPreset] = useState<WalkthroughAiPolicyPresetId>(
    DEFAULT_WALKTHROUGH_AI_POLICY_PRESET,
  );
  const selectedPolicy = resolveWalkthroughAiPolicyPreset(policyPreset);

  const intentSchema = useMemo(
    () =>
      z.object({
        intent: z
          .string()
          .trim()
          .min(1, 'Intent statement is required')
          .max(
            selectedPolicy.maxIntentLength,
            `Intent must be at most ${selectedPolicy.maxIntentLength} characters`,
          ),
        policyPreset: z.enum(['A', 'B', 'C']),
      }),
    [selectedPolicy.maxIntentLength],
  );

  const {
    register,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm<IntentFormValues>({
    resolver: zodResolver(intentSchema),
    defaultValues: {
      intent: '',
      policyPreset: DEFAULT_WALKTHROUGH_AI_POLICY_PRESET,
    },
  });

  const proposalId = proposal?.proposalId;
  useEffect(() => {
    if (!proposalId) return;
    reviewHeadingRef.current?.focus();
  }, [proposalId]);

  const onGenerate = handleSubmit(async (values) => {
    if (!projectId.trim()) {
      setStatusMessage('Select at least one project target before generating an AI draft.');
      return;
    }
    setStatusMessage('Generating draft…');
    setUnitErrors({});
    try {
      const model = walkthroughGenerationModel.trim();
      const skillPath = walkthroughGenerationSkillPath.trim();
      const result = await generateMutation.mutateAsync({
        projectId,
        intent: values.intent,
        policyPreset: values.policyPreset,
        ...(model ? { model } : {}),
        ...(skillPath ? { skillPath } : {}),
        existingDraft: {
          internalName: currentDraft.internalName,
          userTitle: currentDraft.userTitle,
          whyItMatters: currentDraft.whyItMatters,
          steps: currentDraft.steps,
        },
      });
      setProposal(result.proposal);
      setProvenance(result.proposal.generationProvenance ?? null);
      const initial: Record<string, WalkthroughAiUnitDecision> = {};
      for (const unit of result.proposal.units) {
        initial[unit.unitId] = { status: 'pending', imageConfirmed: false };
      }
      setDecisions(initial);
      setAcceptedNormalized([]);
      setStatusMessage('Draft generated. Review each unit before merging.');
    } catch (err) {
      setStatusMessage(
        err instanceof Error ? err.message : 'Generation failed. The editable draft was not changed.',
      );
    }
  });

  const updateDecision = (unitId: string, patch: Partial<WalkthroughAiUnitDecision>) => {
    setDecisions((prev) => ({
      ...prev,
      [unitId]: { ...prev[unitId], ...patch },
    }));
  };

  const applyAnchorToStepUnit = (
    unitId: string,
    anchor: {
      key: string;
      targetRoute: string;
      placement: WalkthroughRegistryPlacement;
    },
  ) => {
    setProposal((prev) => {
      if (!prev) return prev;
      const steps = prev.steps.map((step) => {
        if (`step-${step.id}` !== unitId) return step;
        return {
          ...step,
          route: step.route ?? anchor.targetRoute,
          anchor: {
            key: anchor.key,
            targetRoute: anchor.targetRoute,
            placement: anchor.placement,
          },
          anchorMatch: {
            score: 1,
            belowThreshold: false,
            hasAnchor: true,
            routeCompatible: true,
            matchedTags: step.anchorMatch?.matchedTags ?? [],
          },
        };
      });
      const units = prev.units.map((unit) => {
        if (unit.unitId !== unitId || unit.kind !== 'step') return unit;
        const step = steps.find((s) => `step-${s.id}` === unitId);
        return step ? { ...unit, value: step } : unit;
      });
      return { ...prev, steps, units };
    });
  };

  const handleChooseExisting = async (unit: Extract<WalkthroughAiProposalUnit, { kind: 'step' }>) => {
    setBusyUnitId(unit.unitId);
    setPickerOpenForUnitId(unit.unitId);
    try {
      const result = await matchesMutation.mutateAsync({
        heading: unit.value.heading,
        body: unit.value.bodyMarkdown,
        route: unit.value.route ?? unit.value.anchor?.targetRoute ?? null,
        intent: null,
      });
      setRankedByUnitId((prev) => ({
        ...prev,
        [unit.unitId]: result.rankedCandidates,
      }));
    } catch (err) {
      setUnitErrors((prev) => ({
        ...prev,
        [unit.unitId]:
          err instanceof Error ? err.message : 'Failed to load ranked anchor matches.',
      }));
    } finally {
      setBusyUnitId(null);
    }
  };

  const handleFindWithAi = async (unit: Extract<WalkthroughAiProposalUnit, { kind: 'step' }>) => {
    setBusyUnitId(unit.unitId);
    try {
      const model = anchorDiscoveryModel.trim();
      const skillPath = anchorDiscoverySkillPath.trim();
      const result = await discoveryMutation.mutateAsync({
        heading: unit.value.heading,
        body: unit.value.bodyMarkdown,
        route: unit.value.route ?? unit.value.anchor?.targetRoute ?? null,
        ...(model ? { model } : {}),
        ...(skillPath ? { skillPath } : {}),
      });
      setDiscoveryByUnitId((prev) => ({
        ...prev,
        [unit.unitId]: result.proposals,
      }));
    } catch (err) {
      setUnitErrors((prev) => ({
        ...prev,
        [unit.unitId]:
          err instanceof Error ? err.message : 'Anchor discovery failed.',
      }));
    } finally {
      setBusyUnitId(null);
    }
  };

  const handleImportDiscovered = async (
    unit: Extract<WalkthroughAiProposalUnit, { kind: 'step' }>,
    proposalItem: WalkthroughAnchorDiscoveryProposal,
  ) => {
    setBusyUnitId(unit.unitId);
    try {
      const created = await createManualAnchor.mutateAsync({
        anchorKey: proposalItem.anchorKey,
        testId: proposalItem.testId,
        label: proposalItem.label,
        suggestedRoute: proposalItem.suggestedRoute,
        approvedRoute: proposalItem.suggestedRoute,
        allowedPlacements: proposalItem.allowedPlacements,
        smartTags: proposalItem.smartTags,
        sourceLocations: proposalItem.sourceLocations,
        reviewStatus: 'approved',
        isActive: true,
      });
      const placement =
        (created.allowedPlacements[0] as WalkthroughRegistryPlacement | undefined) ??
        proposalItem.allowedPlacements[0] ??
        'bottom';
      applyAnchorToStepUnit(unit.unitId, {
        key: created.anchorKey,
        targetRoute:
          created.approvedRoute ??
          created.suggestedRoute ??
          proposalItem.suggestedRoute ??
          unit.value.route ??
          '/',
        placement,
      });
      setStatusMessage(`Imported anchor “${created.label}” and selected it for this step.`);
    } catch (err) {
      setUnitErrors((prev) => ({
        ...prev,
        [unit.unitId]:
          err instanceof Error ? err.message : 'Failed to import discovered anchor.',
      }));
    } finally {
      setBusyUnitId(null);
    }
  };

  const handleAccept = async (unit: WalkthroughAiProposalUnit) => {
    if (!projectId.trim()) return;
    const imageConfirmed = decisions[unit.unitId]?.imageConfirmed === true;
    try {
      const result = await validateMutation.mutateAsync({
        projectId,
        unit,
        imageConfirmed,
      });
      setAcceptedNormalized((prev) => {
        const without = prev.filter((u) => u.unitId !== unit.unitId);
        return [...without, result.normalizedUnit];
      });
      updateDecision(unit.unitId, { status: 'accepted' });
      setUnitErrors((prev) => {
        const next = { ...prev };
        delete next[unit.unitId];
        return next;
      });
      setStatusMessage(`Accepted “${unitTitle(unit)}”.`);
    } catch (err) {
      setUnitErrors((prev) => ({
        ...prev,
        [unit.unitId]: err instanceof Error ? err.message : 'Validation failed',
      }));
    }
  };

  const handleReject = (unit: WalkthroughAiProposalUnit) => {
    updateDecision(unit.unitId, { status: 'rejected' });
    setAcceptedNormalized((prev) => prev.filter((u) => u.unitId !== unit.unitId));
    setStatusMessage(`Rejected “${unitTitle(unit)}”.`);
  };

  const handleRedo = async (unit: WalkthroughAiProposalUnit) => {
    if (!proposal) return;
    setRedoingUnitId(unit.unitId);
    setUnitErrors((prev) => {
      const next = { ...prev };
      delete next[unit.unitId];
      return next;
    });
    try {
      const result = await redoMutation.mutateAsync({
        projectId,
        proposalId: proposal.proposalId,
        generationContextVersion: proposal.generationContextVersion,
        unit,
        policyPreset,
      });
      setProposal((prev) => {
        if (!prev) return prev;
        const units = prev.units.map((u) => (u.unitId === unit.unitId ? result.unit : u));
        if (result.unit.kind === 'step') {
          const nextStep = result.unit.value;
          return {
            ...prev,
            units,
            steps: prev.steps.map((s) => (s.id === nextStep.id ? nextStep : s)),
          };
        }
        return {
          ...prev,
          units,
          walkthroughFields: result.unit.value,
        };
      });
      updateDecision(unit.unitId, { status: 'pending', imageConfirmed: false });
      setAcceptedNormalized((prev) => prev.filter((u) => u.unitId !== unit.unitId));
      setStatusMessage(`Redid “${unitTitle(unit)}”. Review the new proposal.`);
    } catch (err) {
      setUnitErrors((prev) => ({
        ...prev,
        [unit.unitId]:
          err instanceof Error
            ? err.message
            : 'Redo failed. The previous proposal remains available.',
      }));
      setStatusMessage('Redo failed. The previous proposal remains available.');
    } finally {
      setRedoingUnitId(null);
    }
  };

  const handleApplyAccepted = () => {
    if (!proposal) return;
    const merged = mergeAcceptedUnitsIntoDraft(currentDraft, decisions, acceptedNormalized);
    onMergeDraft(merged);
    setStatusMessage('Accepted proposals merged into the editable draft. Save when ready.');
  };

  const presets = presetsQuery.data?.presets ?? [
    resolveWalkthroughAiPolicyPreset('A'),
    resolveWalkthroughAiPolicyPreset('B'),
    resolveWalkthroughAiPolicyPreset('C'),
  ];

  return (
    <section
      className={styles.panel}
      aria-labelledby="walkthrough-ai-panel-title"
      {...{ 'data-testid': testId }}
    >
      <div>
        <h3 id="walkthrough-ai-panel-title" className={styles.panelTitle}>
          AI-assisted draft
        </h3>
        <p className={styles.panelHint}>
          Generate a staged proposal from an intent statement. Nothing merges until you accept each
          unit. Images require a separate confirmation.
        </p>
      </div>

      <form onSubmit={onGenerate} {...{ 'data-testid': 'walkthrough-ai-intent-form' }}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="walkthrough-ai-policy-preset">
            Generation policy
          </label>
          <select
            id="walkthrough-ai-policy-preset"
            className={styles.select}
            {...register('policyPreset', {
              onChange: (event) => {
                const value = event.target.value as WalkthroughAiPolicyPresetId;
                setPolicyPreset(value);
                setValue('policyPreset', value);
              },
            })}
            disabled={generateMutation.isPending}
            {...{ 'data-testid': 'walkthrough-ai-policy-preset' }}
          >
            {presets.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label} — {preset.description}
              </option>
            ))}
          </select>
          <p className={styles.panelHint}>
            Limits for this run: intent {selectedPolicy.maxIntentLength} chars · redo feedback{' '}
            {selectedPolicy.maxRedoFeedbackLength} chars · timeout {selectedPolicy.timeoutMs / 1000}s
            · auto-retries {selectedPolicy.retries}. Default is Balanced (A).
          </p>
        </div>

        <p className={styles.panelHint} {...{ 'data-testid': 'walkthrough-ai-options-hint' }}>
          Skill and agent model come from Platform Admin → Walkthroughs → Options
          {walkthroughGenerationSkillPath
            ? ` (skill: ${walkthroughGenerationSkillPath.split('/').slice(-2).join('/')}`
            : ''}
          {walkthroughGenerationModel.trim()
            ? `; model: ${walkthroughGenerationModel.trim()}`
            : ''}
          {walkthroughGenerationSkillPath ? ')' : ''}.
        </p>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="walkthrough-ai-intent">
            Intent statement
          </label>
          <textarea
            id="walkthrough-ai-intent"
            className={styles.textarea}
            placeholder="Example: Introduce the new Walkthroughs feature to Apex project members…"
            {...register('intent')}
            disabled={generateMutation.isPending}
            {...{ 'data-testid': 'walkthrough-ai-intent' }}
          />
          {errors.intent && <p className={styles.fieldError}>{errors.intent.message}</p>}
        </div>

        <div className={styles.actions}>
          <button
            type="submit"
            className={styles.buttonPrimary}
            disabled={generateMutation.isPending}
            {...{ 'data-testid': 'walkthrough-ai-generate' }}
          >
            {generateMutation.isPending ? 'Generating…' : 'Generate draft'}
          </button>
        </div>
      </form>

      <p
        className={generateMutation.isError || Object.keys(unitErrors).length ? styles.statusError : styles.status}
        aria-live="polite"
        {...{ 'data-testid': 'walkthrough-ai-status' }}
      >
        {statusMessage || 'Provide an intent to generate a staged proposal.'}
      </p>

      {provenance && (
        <div
          className={styles.unitCard}
          {...{ 'data-testid': 'walkthrough-ai-provenance' }}
        >
          <strong>Generation provenance</strong>
          <div className={styles.proposedBlock}>
            <div>Provider: {provenance.provider}</div>
            <div>Model: {provenance.model}</div>
            <div>Skill: {provenance.skillPath}</div>
            <div>Generated: {new Date(provenance.generatedAt).toLocaleString()}</div>
            {provenance.runId && <div>Run ID: {provenance.runId}</div>}
            {provenance.threadId && <div>Thread ID: {provenance.threadId}</div>}
          </div>
        </div>
      )}

      {proposal ? (
        <div
          className={styles.review}
          {...{ 'data-testid': 'walkthrough-proposal-review' }}
        >
          <h4
            ref={reviewHeadingRef}
            tabIndex={-1}
            className={styles.reviewHeading}
          >
            Staged proposal review
          </h4>

          {proposal.units.map((unit) => {
            const decision = decisions[unit.unitId] ?? { status: 'pending' as const };
            const badgeClass =
              decision.status === 'accepted'
                ? styles.badgeAccepted
                : decision.status === 'rejected'
                  ? styles.badgeRejected
                  : styles.badge;
            const imagePath =
              unit.kind === 'step'
                ? (unit.imageCandidatePath ?? unit.value.imageCandidatePath ?? unit.value.imageUrl)
                : null;
            const isBusy =
              redoingUnitId === unit.unitId ||
              validateMutation.isPending ||
              busyUnitId === unit.unitId;

            return (
              <article
                key={unit.unitId}
                className={styles.unitCard}
                {...{
                  'data-testid':
                    unit.kind === 'walkthrough-fields'
                      ? 'walkthrough-proposal-fields'
                      : `walkthrough-proposal-step-${unit.value.id}`,
                }}
              >
                <div className={styles.unitMeta}>
                  <strong>{unitTitle(unit)}</strong>
                  <span className={badgeClass}>{decision.status}</span>
                </div>

                {unit.kind === 'walkthrough-fields' ? (
                  <div className={styles.proposedBlock}>
                    <div>Internal name: {unit.value.internalName}</div>
                    <div>User title: {unit.value.userTitle}</div>
                    <div>Why it matters: {unit.value.whyItMatters}</div>
                  </div>
                ) : (
                  <div className={styles.proposedBlock}>
                    <div>{unit.value.bodyMarkdown}</div>
                    {unit.value.anchor?.key ? (
                      <div>
                        Anchor: {anchorLabel(unit.value.anchor.key)} ({unit.value.anchor.targetRoute}
                        , {unit.value.anchor.placement})
                      </div>
                    ) : null}
                    {unit.value.anchorMatch ? (
                      <div
                        className={
                          unit.value.anchorMatch.belowThreshold
                            ? styles.anchorMatchBadgeLow
                            : styles.anchorMatchBadge
                        }
                        {...{
                          'data-testid': `walkthrough-proposal-${unit.unitId}-anchor-match`,
                        }}
                      >
                        Match score {unit.value.anchorMatch.score.toFixed(2)}
                        {unit.value.anchorMatch.belowThreshold ? ' · low confidence' : ''}
                      </div>
                    ) : null}
                    {(!unit.value.anchor?.key || unit.value.anchorMatch?.belowThreshold) &&
                    decision.status !== 'accepted' ? (
                      <div
                        className={styles.anchorMatchWarning}
                        role="status"
                        {...{
                          'data-testid': `walkthrough-proposal-${unit.unitId}-anchor-low-confidence`,
                        }}
                      >
                        Low confidence — pick or find an anchor
                      </div>
                    ) : null}
                    {decision.status !== 'accepted' ? (
                      <div className={styles.anchorTools}>
                        <div className={styles.actions}>
                          <button
                            type="button"
                            className={styles.button}
                            disabled={isBusy}
                            onClick={() => handleChooseExisting(unit)}
                            {...{
                              'data-testid': `walkthrough-proposal-${unit.unitId}-choose-anchor`,
                            }}
                          >
                            Choose existing anchor
                          </button>
                          <button
                            type="button"
                            className={styles.button}
                            disabled={isBusy}
                            onClick={() => handleFindWithAi(unit)}
                            {...{
                              'data-testid': `walkthrough-proposal-${unit.unitId}-find-anchor-ai`,
                            }}
                          >
                            {busyUnitId === unit.unitId && discoveryMutation.isPending
                              ? 'Finding…'
                              : 'Find matches with AI'}
                          </button>
                        </div>
                        {pickerOpenForUnitId === unit.unitId ? (
                          <div
                            className={styles.anchorPicker}
                            {...{
                              'data-testid': `walkthrough-proposal-${unit.unitId}-anchor-picker`,
                            }}
                          >
                            <label
                              className={styles.label}
                              htmlFor={`walkthrough-proposal-${unit.unitId}-anchor-select`}
                            >
                              Ranked catalog anchors
                            </label>
                            <select
                              id={`walkthrough-proposal-${unit.unitId}-anchor-select`}
                              className={styles.select}
                              defaultValue=""
                              disabled={isBusy}
                              onChange={(event) => {
                                const key = event.target.value;
                                if (!key) return;
                                const ranked = rankedByUnitId[unit.unitId] ?? [];
                                const match = ranked.find((c) => c.anchorKey === key);
                                const catalog = anchorsQuery.data?.find((a) => a.key === key);
                                const placement = (match?.allowedPlacements[0] ??
                                  catalog?.allowedPlacements?.[0] ??
                                  'bottom') as WalkthroughRegistryPlacement;
                                const targetRoute =
                                  match?.approvedRoute ??
                                  catalog?.targetRoute ??
                                  unit.value.route ??
                                  '/';
                                applyAnchorToStepUnit(unit.unitId, {
                                  key,
                                  targetRoute,
                                  placement,
                                });
                              }}
                              {...{
                                'data-testid': `walkthrough-proposal-${unit.unitId}-anchor-select`,
                              }}
                            >
                              <option value="">Select an anchor…</option>
                              {(rankedByUnitId[unit.unitId] ?? []).map((candidate) => (
                                <option key={candidate.anchorKey} value={candidate.anchorKey}>
                                  {candidate.label} ({candidate.score.toFixed(2)})
                                </option>
                              ))}
                              {(anchorsQuery.data ?? [])
                                .filter(
                                  (a) =>
                                    !(rankedByUnitId[unit.unitId] ?? []).some(
                                      (c) => c.anchorKey === a.key,
                                    ),
                                )
                                .map((a) => (
                                  <option key={`catalog-${a.key}`} value={a.key}>
                                    {a.label} (catalog)
                                  </option>
                                ))}
                            </select>
                          </div>
                        ) : null}
                        {(discoveryByUnitId[unit.unitId] ?? []).length > 0 ? (
                          <div
                            className={styles.discoveryList}
                            {...{
                              'data-testid': `walkthrough-proposal-${unit.unitId}-discovery-results`,
                            }}
                          >
                            {(discoveryByUnitId[unit.unitId] ?? []).map((item) => (
                              <div
                                key={item.anchorKey}
                                className={styles.discoveryItem}
                                {...{
                                  'data-testid': `walkthrough-proposal-${unit.unitId}-discovery-${item.anchorKey}`,
                                }}
                              >
                                <strong>{item.label}</strong>
                                <span>
                                  {item.anchorKey} · confidence {item.confidence.toFixed(2)}
                                </span>
                                <span>{item.rationale}</span>
                                <button
                                  type="button"
                                  className={styles.buttonPrimary}
                                  disabled={isBusy}
                                  onClick={() => handleImportDiscovered(unit, item)}
                                  {...{
                                    'data-testid': `walkthrough-proposal-${unit.unitId}-import-${item.anchorKey}`,
                                  }}
                                >
                                  Import &amp; select
                                </button>
                              </div>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                    {imagePath ? (
                      <div className={styles.imageCandidate}>
                        <img
                          className={styles.imagePreview}
                          src={imagePath}
                          alt={`Suggested preview for ${unit.value.heading}`}
                          onError={(event) => {
                            (event.currentTarget as HTMLImageElement).alt =
                              'Broken image candidate';
                          }}
                        />
                        <label className={styles.checkboxRow}>
                          <input
                            type="checkbox"
                            checked={decision.imageConfirmed === true}
                            disabled={decision.status === 'accepted' || isBusy}
                            onChange={(event) =>
                              updateDecision(unit.unitId, {
                                imageConfirmed: event.target.checked,
                              })
                            }
                            {...{ 'data-testid': `walkthrough-proposal-${unit.unitId}-image-confirm` }}
                          />
                          Confirm image path {imagePath} before acceptance
                        </label>
                      </div>
                    ) : (
                      <div>No image suggested</div>
                    )}
                  </div>
                )}

                {unitErrors[unit.unitId] ? (
                  <p className={styles.fieldError} role="alert">
                    {unitErrors[unit.unitId]}
                  </p>
                ) : null}

                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.buttonPrimary}
                    disabled={isBusy || decision.status === 'accepted'}
                    aria-label={`Accept ${unitTitle(unit)}`}
                    onClick={() => handleAccept(unit)}
                    {...{ 'data-testid': `walkthrough-proposal-${unit.unitId}-accept` }}
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    className={styles.button}
                    disabled={isBusy}
                    aria-label={`Reject ${unitTitle(unit)}`}
                    onClick={() => handleReject(unit)}
                    {...{ 'data-testid': `walkthrough-proposal-${unit.unitId}-reject` }}
                  >
                    Reject
                  </button>
                  <button
                    type="button"
                    className={styles.button}
                    disabled={isBusy}
                    aria-label={`Redo ${unitTitle(unit)}`}
                    onClick={() => handleRedo(unit)}
                    {...{ 'data-testid': `walkthrough-proposal-${unit.unitId}-redo` }}
                  >
                    {redoingUnitId === unit.unitId ? 'Redoing…' : 'Ask AI to redo'}
                  </button>
                </div>
              </article>
            );
          })}

          <div className={styles.actions}>
            <button
              type="button"
              className={styles.buttonPrimary}
              onClick={handleApplyAccepted}
              {...{ 'data-testid': 'walkthrough-ai-apply-accepted' }}
            >
              Merge accepted into draft
            </button>
          </div>
        </div>
      ) : null}
    </section>
  );
};
