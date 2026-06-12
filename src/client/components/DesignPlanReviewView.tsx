import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAppShell } from '../hooks/useAppShell';
import {
  useDesignPlan,
  useSaveDesignPlan,
  useRegenerateDesignPlan,
  useGeneratePrototypesFromPlan,
} from '../hooks/useDesignPlan';
import { usePrototypeAssignments } from '../hooks/useDesignPrototypes';
import { designPlanStatusLabel } from '../../shared/types/designPlan';
import type {
  DesignPlanFeature,
  UiLayoutPattern,
  UiMockDecision,
} from '../../shared/types/designPlan';
import styles from './DesignPlanReviewView.module.css';

const LAYOUT_PATTERNS: UiLayoutPattern[] = [
  'table', 'calendar', 'dashboard', 'form', 'detail-page', 'wizard', 'modal', 'drawer', 'widget',
];
const DECISIONS: UiMockDecision[] = ['new-page', 'update-page', 'no-ui'];

const DesignPlanReviewView: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { can, userId, isAdmin } = useAppShell();

  const prdId = location.pathname.split('/').pop() ?? '';

  const { data, isLoading, error } = useDesignPlan(prdId);
  const { data: assignments = [] } = usePrototypeAssignments(prdId);

  const savePlan = useSaveDesignPlan();
  const regeneratePlan = useRegenerateDesignPlan();
  const generatePrototypes = useGeneratePrototypesFromPlan();

  const [edited, setEdited] = useState<DesignPlanFeature[]>([]);
  const [dirty, setDirty] = useState(false);
  const [expandedDetails, setExpandedDetails] = useState<Set<number>>(new Set());

  const plan = data?.plan ?? null;

  const isAssignedApprover = useMemo(
    () => assignments.some((a) => a.approverUserId === userId),
    [assignments, userId],
  );
  const canEditPlan = can('design-prototypes:review') && (isAssignedApprover || isAdmin);

  useEffect(() => {
    if (plan && !dirty) {
      setEdited(plan.features);
    }
  }, [plan, dirty]);

  const updateFeature = useCallback((index: number, patch: Partial<DesignPlanFeature>) => {
    setEdited((prev) => prev.map((f, i) => (i === index ? { ...f, ...patch } : f)));
    setDirty(true);
  }, []);

  const updatePbiContribution = useCallback((featureIndex: number, pbiIndex: number, contribution: string) => {
    setEdited((prev) => prev.map((f, i) => {
      if (i !== featureIndex) return f;
      const pbiContributions = f.pbiContributions.map((c, j) => (j === pbiIndex ? { ...c, contribution } : c));
      return { ...f, pbiContributions };
    }));
    setDirty(true);
  }, []);

  const toggleDetails = useCallback((index: number) => {
    setExpandedDetails((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  const handleSave = useCallback(async () => {
    if (!plan) return;
    await savePlan.mutateAsync({ planId: plan.id, prdId, features: edited });
    setDirty(false);
  }, [plan, prdId, edited, savePlan]);

  const handleRegenerate = useCallback(async () => {
    if (!plan) return;
    setDirty(false);
    await regeneratePlan.mutateAsync({ planId: plan.id, prdId });
  }, [plan, prdId, regeneratePlan]);

  const handleGenerate = useCallback(async () => {
    if (!plan) return;
    if (dirty) {
      await savePlan.mutateAsync({ planId: plan.id, prdId, features: edited });
      setDirty(false);
    }
    await generatePrototypes.mutateAsync({ planId: plan.id, prdId });
    navigate(`/backlog/design-prototypes/${prdId}`);
  }, [plan, prdId, dirty, edited, savePlan, generatePrototypes, navigate]);

  if (isLoading) {
    return <div className={styles.container}><p className={styles.muted}>Loading design plan…</p></div>;
  }

  if (error || !plan) {
    return (
      <div className={styles.container}>
        <button className={styles.backBtn} onClick={() => navigate(`/backlog/prd/${prdId}`)} type="button">← Back to PRD</button>
        <p className={styles.muted}>No design plan found for this PRD yet.</p>
      </div>
    );
  }

  const isGenerating = plan.status === 'generating';
  const busy = savePlan.isPending || regeneratePlan.isPending || generatePrototypes.isPending;
  const statusBadgeClass = styles[`badge_${plan.status}`] ?? '';

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div>
          <button className={styles.backBtn} onClick={() => navigate(`/backlog/prd/${prdId}`)} type="button">← Back to PRD</button>
          <h2 className={styles.title}>Design Brief</h2>
          <p className={styles.muted}>
            Review and edit the design brief for each feature below. Edit the text directly — the prototype
            generator will follow your brief exactly. When you're happy with the plan, hit "Generate Designs".
          </p>
        </div>
        <div className={styles.headerActions}>
          <span className={`${styles.badge} ${statusBadgeClass}`}>
            {designPlanStatusLabel(plan.status)}
          </span>
        </div>
      </div>

      {data?.stale && (
        <div className={styles.warning}>
          The PRD backlog changed since this plan was generated. Consider regenerating the plan.
        </div>
      )}

      {!canEditPlan && (
        <div className={styles.info}>
          You can view this plan, but only assigned design reviewers can edit it or generate designs.
        </div>
      )}

      {plan.status === 'generation_failed' && (
        <div className={styles.warning}>
          Plan generation failed{plan.generationError ? `: ${plan.generationError}` : ''}.
          {canEditPlan && ' Use Regenerate Plan to try again.'}
        </div>
      )}

      {isGenerating ? (
        <div className={styles.generating}>
          <span className={styles.spinner} aria-hidden="true" />
          <p className={styles.muted}>Generating the design brief…</p>
        </div>
      ) : (
        <>
          <div className={styles.features}>
            {edited.map((feature, index) => (
              <div key={feature.featureIndex} className={styles.card}>
                <div className={styles.cardHeader}>
                  <h3 className={styles.featureName}>{feature.featureName}</h3>
                  <span className={styles.decisionPill}>{feature.decision}</span>
                </div>

                <label className={styles.briefField}>
                  <span className={styles.briefLabel}>Design Brief</span>
                  <textarea
                    className={styles.briefTextarea}
                    value={feature.designBrief ?? ''}
                    rows={10}
                    placeholder="Describe the screen layout, key interactions, and user flow in plain English. The prototype generator will follow this brief."
                    disabled={!canEditPlan || busy}
                    onChange={(e) => updateFeature(index, { designBrief: e.target.value })}
                  />
                </label>

                <button
                  className={styles.detailsToggle}
                  type="button"
                  onClick={() => toggleDetails(index)}
                >
                  {expandedDetails.has(index) ? '▾' : '▸'} Technical Details
                </button>

                {expandedDetails.has(index) && (
                  <div className={styles.detailsSection}>
                    <div className={styles.fieldRow}>
                      <label className={styles.field}>
                        <span className={styles.label}>Decision</span>
                        <select
                          className={styles.select}
                          value={feature.decision}
                          disabled={!canEditPlan || busy}
                          onChange={(e) => updateFeature(index, { decision: e.target.value as UiMockDecision })}
                        >
                          {DECISIONS.map((d) => <option key={d} value={d}>{d}</option>)}
                        </select>
                      </label>

                      <label className={styles.field}>
                        <span className={styles.label}>Layout pattern</span>
                        <select
                          className={styles.select}
                          value={feature.layoutPattern ?? ''}
                          disabled={!canEditPlan || busy}
                          onChange={(e) => updateFeature(index, { layoutPattern: (e.target.value || undefined) as UiLayoutPattern | undefined })}
                        >
                          <option value="">(none)</option>
                          {LAYOUT_PATTERNS.map((l) => <option key={l} value={l}>{l}</option>)}
                        </select>
                      </label>
                    </div>

                    {feature.decision === 'update-page' && (
                      <div className={styles.fieldRow}>
                        <label className={styles.field}>
                          <span className={styles.label}>Target route</span>
                          <input
                            className={styles.input}
                            value={feature.targetRoute ?? ''}
                            placeholder="/existing-route"
                            disabled={!canEditPlan || busy}
                            onChange={(e) => updateFeature(index, { targetRoute: e.target.value || undefined })}
                          />
                        </label>
                        <label className={styles.field}>
                          <span className={styles.label}>Page title</span>
                          <input
                            className={styles.input}
                            value={feature.targetPageTitle ?? ''}
                            disabled={!canEditPlan || busy}
                            onChange={(e) => updateFeature(index, { targetPageTitle: e.target.value || undefined })}
                          />
                        </label>
                      </div>
                    )}

                    <label className={styles.field}>
                      <span className={styles.label}>Primary components (comma-separated)</span>
                      <input
                        className={styles.input}
                        value={feature.primaryComponents.join(', ')}
                        disabled={!canEditPlan || busy}
                        onChange={(e) => updateFeature(index, {
                          primaryComponents: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                        })}
                      />
                    </label>

                    <label className={styles.field}>
                      <span className={styles.label}>States (comma-separated)</span>
                      <input
                        className={styles.input}
                        value={feature.states.join(', ')}
                        disabled={!canEditPlan || busy}
                        onChange={(e) => updateFeature(index, {
                          states: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                        })}
                      />
                    </label>

                    {feature.pbiContributions.length > 0 && (
                      <div className={styles.field}>
                        <span className={styles.label}>PBI contributions</span>
                        <div className={styles.pbiList}>
                          {feature.pbiContributions.map((c, pbiIndex) => (
                            <div key={`${feature.featureIndex}-${c.pbiTitle}-${pbiIndex}`} className={styles.pbiRow}>
                              <span className={styles.pbiTitle}>{c.pbiTitle}</span>
                              <input
                                className={styles.input}
                                value={c.contribution}
                                placeholder="How this PBI appears in the UI"
                                disabled={!canEditPlan || busy}
                                onChange={(e) => updatePbiContribution(index, pbiIndex, e.target.value)}
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <label className={styles.field}>
                      <span className={styles.label}>Rationale</span>
                      <textarea
                        className={styles.textarea}
                        value={feature.rationale}
                        rows={2}
                        disabled={!canEditPlan || busy}
                        onChange={(e) => updateFeature(index, { rationale: e.target.value })}
                      />
                    </label>

                    <label className={styles.field}>
                      <span className={styles.label}>Notes for generation</span>
                      <textarea
                        className={styles.textarea}
                        value={feature.notes ?? ''}
                        rows={2}
                        placeholder="Anything the generator must honor"
                        disabled={!canEditPlan || busy}
                        onChange={(e) => updateFeature(index, { notes: e.target.value || undefined })}
                      />
                    </label>
                  </div>
                )}
              </div>
            ))}
          </div>

          {canEditPlan && (
            <div className={styles.footer}>
              <button
                className={styles.secondaryBtn}
                onClick={handleRegenerate}
                type="button"
                disabled={busy}
              >
                Regenerate Plan
              </button>
              <button
                className={styles.secondaryBtn}
                onClick={handleSave}
                type="button"
                disabled={busy || !dirty}
              >
                {savePlan.isPending ? 'Saving…' : 'Save Changes'}
              </button>
              <button
                className={styles.primaryBtn}
                onClick={handleGenerate}
                type="button"
                disabled={busy}
              >
                {generatePrototypes.isPending ? 'Generating…' : 'Generate Designs →'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default DesignPlanReviewView;
