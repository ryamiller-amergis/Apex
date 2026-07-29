import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ApexWorkItemDraft } from '../../shared/types/apexWorkItem';
import type { FeatureRequest } from '../../shared/types/featureRequest';
import { useApexWorkItemOwners, useGenerateDrafts, useCreateFromDrafts } from '../hooks/useApexWorkItems';
import { formatGwtAcText } from '../utils/formatGwtAc';
import styles from './ApexGenerateWorkItemsWizard.module.css';

type Phase = 'intent' | 'generating' | 'review' | 'creating' | 'success';

const GENERATING_STEPS = [
  'Analyzing feature request…',
  'Drafting descriptions…',
  'Writing acceptance checks…',
  'Finishing up…',
];

interface ApexGenerateWorkItemsWizardProps {
  featureRequest: FeatureRequest;
  onClose: () => void;
}

export const ApexGenerateWorkItemsWizard: React.FC<ApexGenerateWorkItemsWizardProps> = ({
  featureRequest,
  onClose,
}) => {
  const navigate = useNavigate();
  const { data: owners = [] } = useApexWorkItemOwners();
  const generateMutation = useGenerateDrafts();
  const createMutation = useCreateFromDrafts();

  const [phase, setPhase] = useState<Phase>('intent');
  const [ownerId, setOwnerId] = useState<string>('');
  const [grain, setGrain] = useState<'single' | 'small-set'>('small-set');
  const [drafts, setDrafts] = useState<ApexWorkItemDraft[]>([]);
  const [generatingStep, setGeneratingStep] = useState(0);
  const [createdCount, setCreatedCount] = useState(0);
  const stepIntervalRef = useRef<number | null>(null);

  useEffect(() => {
    if (owners.length > 0 && !ownerId) setOwnerId(owners[0].oid);
  }, [owners, ownerId]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); },
    [onClose],
  );
  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const handleGenerate = async () => {
    setPhase('generating');
    setGeneratingStep(0);
    stepIntervalRef.current = window.setInterval(() => {
      setGeneratingStep((p) => (p < GENERATING_STEPS.length - 1 ? p + 1 : p));
    }, 900);
    try {
      const res = await generateMutation.mutateAsync({
        featureRequestId: featureRequest.id,
        ownerId,
        grain,
      });
      clearInterval(stepIntervalRef.current!);
      setDrafts(res.drafts);
      setPhase('review');
    } catch {
      clearInterval(stepIntervalRef.current!);
      setPhase('intent');
    }
  };

  const updateDraftTitle = (id: string, title: string) =>
    setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, title } : d)));

  const updateDraftOutcome = (id: string, outcome: string) =>
    setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, outcome } : d)));

  const handleCreate = async () => {
    setPhase('creating');
    try {
      const created = await createMutation.mutateAsync({
        featureRequestId: featureRequest.id,
        ownerId,
        drafts: drafts.map((d) => ({
          title: d.title,
          outcome: d.outcome,
          type: d.type,
          status: 'ready',
          ownerId,
          acceptanceCriteria: d.acceptanceCriteria,
        })) as Parameters<typeof createMutation.mutateAsync>[0]['drafts'],
      });
      setCreatedCount(created.length);
      setPhase('success');
    } catch {
      setPhase('review');
    }
  };

  const isIntent = phase === 'intent';
  const isReview = phase === 'review';

  return (
    <div className={styles.overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={styles.modal} role="dialog" aria-modal aria-label="Generate Work Items">

        {/* Step indicator */}
        <div className={styles.steps}>
          {(['intent', 'review', 'success'] as Phase[]).map((s, i, arr) => {
            const phaseIndex = ['intent', 'generating', 'review', 'creating', 'success'].indexOf(phase);
            const isActive = (s === 'review' && (phase === 'review' || phase === 'creating'))
              || (s === 'success' && phase === 'success')
              || (s === 'intent' && (phase === 'intent' || phase === 'generating'));
            const isDone = phaseIndex > ['intent', 'generating', 'review', 'creating', 'success'].indexOf(s === 'review' ? 'creating' : s === 'success' ? 'success' : 'generating');
            return (
              <React.Fragment key={s}>
                <div className={`${styles.step} ${isActive ? styles.stepActive : ''} ${isDone && !isActive ? styles.stepDone : ''}`}>
                  <div className={styles.stepNum}>
                    {isDone && !isActive ? '✓' : i + 1}
                  </div>
                  {s === 'intent' ? 'Setup' : s === 'review' ? 'Review' : 'Done'}
                </div>
                {i < arr.length - 1 && <div className={styles.stepLine} />}
              </React.Fragment>
            );
          })}
        </div>

        {/* Header */}
        <div className={styles.header}>
          <div className={styles.headerText}>
            <h2 className={styles.title}>Generate Work Items</h2>
            <p className={styles.subtitle}>
              AI will draft work items from this feature request for your review before creating them.
            </p>
          </div>
          <button className={styles.closeBtn} onClick={onClose} aria-label="Close">
            <svg width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" viewBox="0 0 14 14">
              <path d="M2 2l10 10M12 2L2 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        {phase === 'generating' && (
          <div className={styles.generatingState}>
            <div className={styles.generatingSpinner} />
            <div className={styles.generatingStep} key={generatingStep}>
              {GENERATING_STEPS[generatingStep]}
            </div>
          </div>
        )}

        {phase === 'creating' && (
          <div className={styles.generatingState}>
            <div className={styles.generatingSpinner} />
            <div className={styles.generatingStep}>Creating {drafts.length} work items…</div>
          </div>
        )}

        {phase === 'success' && (
          <div className={styles.successState}>
            <div className={styles.successIcon}>
              <svg width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                <path d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <div className={styles.successCount}>{createdCount}</div>
            <div className={styles.successText}>work items created on the board</div>
          </div>
        )}

        {isIntent && (
          <div className={styles.body}>
            {/* FR context */}
            <div className={styles.frCard}>
              <div className={styles.frCardLabel}>Feature Request</div>
              <p className={styles.frTitle}>{featureRequest.title}</p>
              <p className={styles.frDesc}>{featureRequest.request}</p>
            </div>

            {/* Owner */}
            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel}>Assign to</label>
              <select
                className={styles.fieldSelect}
                value={ownerId}
                onChange={(e) => setOwnerId(e.target.value)}
              >
                {owners.map((o) => (
                  <option key={o.oid} value={o.oid}>{o.displayName}</option>
                ))}
              </select>
            </div>

            {/* Grain */}
            <div className={styles.fieldGroup}>
              <label className={styles.fieldLabel}>Number of work items to generate</label>
              <div className={styles.grainOptions}>
                <button
                  type="button"
                  className={`${styles.grainOption} ${grain === 'single' ? styles.grainOptionActive : ''}`}
                  onClick={() => setGrain('single')}
                >
                  <span className={styles.grainLabel}>Single item</span>
                  <span className={styles.grainHint}>1 focused work item</span>
                </button>
                <button
                  type="button"
                  className={`${styles.grainOption} ${grain === 'small-set' ? styles.grainOptionActive : ''}`}
                  onClick={() => setGrain('small-set')}
                >
                  <span className={styles.grainLabel}>Small set</span>
                  <span className={styles.grainHint}>2–4 decomposed items</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {isReview && (
          <div className={styles.body}>
            <div className={styles.draftsHeader}>
              <span className={styles.draftsTitle}>Review & edit before creating</span>
              <button
                className={styles.regenerateBtn}
                onClick={handleGenerate}
                disabled={generateMutation.isPending}
              >
                Regenerate
              </button>
            </div>
            <div className={styles.draftList}>
              {drafts.map((draft) => (
                <div key={draft.id} className={styles.draftCard}>
                  <div className={styles.draftCardHeader}>
                    <span
                      className={`${styles.draftTypeChip} ${
                        draft.type === 'PBI' ? styles.draftTypePBI
                          : draft.type === 'TBI' ? styles.draftTypeTBI
                          : styles.draftTypeBug
                      }`}
                    >
                      {draft.type}
                    </span>
                  </div>
                  <input
                    className={styles.draftTitleInput}
                    value={draft.title}
                    onChange={(e) => updateDraftTitle(draft.id, e.target.value)}
                    placeholder="Work item title"
                  />
                  <textarea
                    className={styles.draftOutcomeInput}
                    value={draft.outcome}
                    onChange={(e) => updateDraftOutcome(draft.id, e.target.value)}
                    rows={2}
                    placeholder={'As a <role>\nI want <capability>\nSo that <benefit>'}
                  />
                  {draft.acceptanceCriteria.length > 0 && (
                    <div className={styles.draftAcList}>
                      {draft.acceptanceCriteria.map((ac, i) => (
                        <div key={i} className={styles.draftAcItem}>
                          <span className={styles.draftAcBullet}>◦</span>
                          <span>{formatGwtAcText(ac.text)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className={styles.footer}>
          <div className={styles.footerSpacer} />
          {phase === 'success' ? (
            <>
              <button className={styles.btnSecondary} onClick={onClose}>Close</button>
              <button className={styles.btnPrimary} onClick={() => navigate('/work-board')}>
                Open Work Board
              </button>
            </>
          ) : isReview ? (
            <>
              <button className={styles.btnSecondary} onClick={() => setPhase('intent')}>
                Back
              </button>
              <button
                className={styles.btnPrimary}
                onClick={handleCreate}
                disabled={drafts.length === 0}
              >
                Create {drafts.length} Work Items
              </button>
            </>
          ) : isIntent ? (
            <>
              <button className={styles.btnSecondary} onClick={onClose}>Cancel</button>
              <button
                className={styles.btnPrimary}
                onClick={handleGenerate}
                disabled={!ownerId}
              >
                Generate with AI
              </button>
            </>
          ) : null}
        </div>

      </div>
    </div>
  );
};
