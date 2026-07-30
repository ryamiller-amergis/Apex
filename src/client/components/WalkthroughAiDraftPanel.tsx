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
} from '../hooks/useWalkthroughAiDraft';
import { useWalkthroughAnchors } from '../hooks/usePlatformAdminWalkthroughs';
import {
  useAvailableModels,
  useProjectSkillConfig,
} from '../hooks/useProjectSkillConfig';
import { useSkillList, useSkillRepos } from '../hooks/useChatThreads';
import styles from './WalkthroughAiDraft.module.css';

const DEFAULT_WALKTHROUGH_GENERATION_SKILL_PATH =
  '.cursor/skills/walkthrough-generation/SKILL.md';
const APEX_REPOSITORY_PROJECT = 'Apex';

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
  cursorModel: string;
  skillPath: string;
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
  const anchorsQuery = useWalkthroughAnchors();

  const anchorLabel = (key: string | undefined): string | null => {
    if (!key) return null;
    return anchorsQuery.data?.find((a) => a.key === key)?.label ?? key;
  };
  const modelsQuery = useAvailableModels();
  const skillConfigQuery = useProjectSkillConfig(APEX_REPOSITORY_PROJECT);
  const skillConfig = skillConfigQuery.data;
  const skillReposQuery = useSkillRepos(
    APEX_REPOSITORY_PROJECT,
    skillConfig?.skillProvider,
  );
  const skillRepo =
    skillConfig?.skillRepo ||
    skillReposQuery.data?.find(
      (repo) => repo.name.toLowerCase() === APEX_REPOSITORY_PROJECT.toLowerCase(),
    )?.name ||
    skillReposQuery.data?.[0]?.name ||
    null;
  const skillBranch =
    skillConfig?.skillBranch ||
    skillReposQuery.data?.find((repo) => repo.name === skillRepo)?.defaultBranch;
  const skillsQuery = useSkillList(
    APEX_REPOSITORY_PROJECT,
    skillRepo,
    skillBranch,
    skillConfig?.skillProvider,
  );

  const [proposal, setProposal] = useState<WalkthroughAiProposal | null>(null);
  const [decisions, setDecisions] = useState<Record<string, WalkthroughAiUnitDecision>>({});
  const [acceptedNormalized, setAcceptedNormalized] = useState<WalkthroughAiProposalUnit[]>([]);
  const [statusMessage, setStatusMessage] = useState('');
  const [unitErrors, setUnitErrors] = useState<Record<string, string>>({});
  const [redoingUnitId, setRedoingUnitId] = useState<string | null>(null);
  const [provenance, setProvenance] = useState<WalkthroughGenerationProvenance | null>(null);
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
        cursorModel: z.string(),
        skillPath: z.string(),
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
      cursorModel: '',
      skillPath: DEFAULT_WALKTHROUGH_GENERATION_SKILL_PATH,
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
      const result = await generateMutation.mutateAsync({
        projectId,
        intent: values.intent,
        policyPreset: values.policyPreset,
        ...(values.cursorModel?.trim() ? { model: values.cursorModel.trim() } : {}),
        ...(values.skillPath?.trim() ? { skillPath: values.skillPath.trim() } : {}),
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

        <div className={styles.field}>
          <label className={styles.label} htmlFor="walkthrough-ai-cursor-model">
            Cursor model (optional)
          </label>
          <select
            id="walkthrough-ai-cursor-model"
            className={styles.select}
            {...register('cursorModel')}
            disabled={generateMutation.isPending}
            {...{ 'data-testid': 'walkthrough-ai-cursor-model' }}
          >
            <option value="">Project/default Cursor model</option>
            {(modelsQuery.data ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="walkthrough-ai-skill-path">
            Skill
          </label>
          <select
            id="walkthrough-ai-skill-path"
            className={styles.select}
            {...register('skillPath')}
            disabled={generateMutation.isPending || skillsQuery.isLoading}
            {...{ 'data-testid': 'walkthrough-ai-skill-path' }}
          >
            <option value={DEFAULT_WALKTHROUGH_GENERATION_SKILL_PATH}>
              Walkthrough generation (default)
            </option>
            {(skillsQuery.data ?? [])
              .filter((skill) => skill.path !== DEFAULT_WALKTHROUGH_GENERATION_SKILL_PATH)
              .map((skill) => (
                <option key={skill.id} value={skill.path}>
                  {skill.name}
                </option>
              ))}
          </select>
          <p className={styles.panelHint}>
            Choose from the skills available through the Apex project repository connection.
          </p>
        </div>

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
            const isBusy = redoingUnitId === unit.unitId || validateMutation.isPending;

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
