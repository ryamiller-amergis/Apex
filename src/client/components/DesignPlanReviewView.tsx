import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useAppShell } from '../hooks/useAppShell';
import {
  useDesignPlan,
  useSaveDesignPlan,
  useRegenerateDesignPlan,
  useGeneratePrototypesFromPlan,
} from '../hooks/useDesignPlan';
import { usePrototypeAssignments } from '../hooks/useDesignPrototypes';
import {
  usePageScreenshot,
  usePageScreenshotStatuses,
  useUploadPageScreenshot,
  useDeletePageScreenshot,
} from '../hooks/usePageScreenshots';
import type { PageScreenshot } from '../../server/services/pageScreenshotService';
import { designPlanStatusLabel } from '../../shared/types/designPlan';
import type {
  DesignPlanFeature,
  UiLayoutPattern,
  UiMockDecision,
} from '../../shared/types/designPlan';
import { normaliseUrlToRoute } from '../../shared/utils/routeNormalization';
import {
  buildUpdatePageGenerateHelperText,
  collectUpdatePageScreenshotGaps,
  splitTargetRoutes,
} from '../../shared/utils/updatePageScreenshotGaps';
import styles from './DesignPlanReviewView.module.css';

const LAYOUT_PATTERNS: UiLayoutPattern[] = [
  'table', 'calendar', 'dashboard', 'form', 'detail-page', 'wizard', 'modal', 'drawer', 'widget',
];
const DECISIONS: UiMockDecision[] = ['new-page', 'update-page', 'no-ui'];

const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;

interface PageScreenshotFieldProps {
  route: string | undefined;
  disabled: boolean;
}

const PageScreenshotField: React.FC<PageScreenshotFieldProps> = ({ route, disabled }) => {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploadSuccess, setUploadSuccess] = useState(false);
  // Local state holds the most recent upload so the thumbnail shows immediately
  // without depending on cache invalidation timing.
  const [localScreenshot, setLocalScreenshot] = useState<PageScreenshot | null>(null);
  const [localRemoved, setLocalRemoved] = useState(false);
  const [expandedImage, setExpandedImage] = useState(false);

  const normalised = route?.trim() ? normaliseUrlToRoute(route) : undefined;
  const { data: fetched, isLoading } = usePageScreenshot(normalised);
  const uploadMutation = useUploadPageScreenshot();
  const deleteMutation = useDeletePageScreenshot();
  const resolvedDisplay = normalised ?? '';

  // Prefer local state: after upload use local copy; after remove show nothing
  // until the server query confirms deletion; fall back to server query.
  const screenshot = localRemoved ? undefined : (localScreenshot ?? fetched);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_SCREENSHOT_BYTES) {
      alert('Screenshot must be under 2 MB');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
      const mediaType = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
      const url = normalised || route || '';
      uploadMutation.mutate({ url, imageBase64: base64, mediaType }, {
        onSuccess: (data) => {
          setLocalScreenshot(data);
          setLocalRemoved(false);
          setUploadSuccess(true);
          setTimeout(() => setUploadSuccess(false), 4000);
        },
        onError: () => {
          alert('Upload failed. Please try again.');
        },
      });
    };
    reader.readAsDataURL(file);
    if (fileRef.current) fileRef.current.value = '';
  }, [normalised, route, uploadMutation]);

  if (!normalised) {
    return (
      <div className={styles.screenshotSection}>
        <div className={styles.field}>
          <span className={styles.label}>Page Screenshot (required)</span>
          <span className={styles.screenshotRequired}>
            Enter the existing page address above, then upload a screenshot of that page.
          </span>
        </div>
      </div>
    );
  }

  return (
    <>
    <div className={styles.screenshotSection}>
      {resolvedDisplay && (
        <span className={styles.resolvedRoute}>Screenshot is stored for: {resolvedDisplay}</span>
      )}

      <div className={styles.field}>
        <span className={styles.label}>
          Page Screenshot {screenshot ? '(on file)' : '(required)'}
        </span>

        {uploadSuccess && (
          <div className={styles.screenshotSuccess}>
            Screenshot uploaded for {normalised}
          </div>
        )}

        {isLoading ? (
          <span className={styles.muted}>Checking for existing screenshot…</span>
        ) : screenshot ? (
          <div className={styles.screenshotPreview}>
            <button
              type="button"
              className={styles.screenshotThumbBtn}
              data-testid="design-plan-screenshot-expand-btn"
              onClick={() => setExpandedImage(true)}
              aria-label="Expand screenshot"
            >
              <img
                src={`data:${screenshot.mediaType};base64,${screenshot.imageBase64}`}
                alt={`Screenshot of ${screenshot.route}`}
                className={styles.screenshotThumb}
              />
            </button>
            <div className={styles.screenshotMeta}>
              <span className={styles.muted}>
                Uploaded {new Date(screenshot.updatedAt).toLocaleDateString()}
              </span>
              {!disabled && (
                <div className={styles.screenshotActions}>
                  <button
                    type="button"
                    className={styles.secondaryBtn}
                    data-testid="design-plan-screenshot-replace-btn"
                    onClick={() => fileRef.current?.click()}
                    disabled={uploadMutation.isPending}
                  >
                    {uploadMutation.isPending ? 'Uploading…' : 'Replace'}
                  </button>
                  <button
                    type="button"
                    className={styles.secondaryBtn}
                    data-testid="design-plan-screenshot-remove-btn"
                    onClick={() => deleteMutation.mutate({ id: screenshot.id, route: screenshot.route }, {
                      onSuccess: () => {
                        setLocalScreenshot(null);
                        setLocalRemoved(true);
                      },
                    })}
                    disabled={deleteMutation.isPending}
                  >
                    Remove
                  </button>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className={styles.screenshotUpload}>
            <button
              type="button"
              className={styles.secondaryBtn}
              data-testid="design-plan-screenshot-upload-btn"
              onClick={() => fileRef.current?.click()}
              disabled={disabled || uploadMutation.isPending}
            >
              {uploadMutation.isPending ? 'Uploading…' : 'Upload Page Screenshot'}
            </button>
            <span className={styles.screenshotRequired}>
              Screenshot required for {normalised}
            </span>
          </div>
        )}

        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg"
          style={{ display: 'none' }}
          data-testid="design-plan-screenshot-file-input"
          onChange={handleFileChange}
        />
      </div>
    </div>

    {expandedImage && screenshot && (
      <div
        className={styles.imageOverlay}
        data-testid="design-plan-screenshot-preview-overlay"
        onClick={() => setExpandedImage(false)}
        role="dialog"
        aria-modal="true"
        aria-label="Screenshot preview"
      >
        <button
          type="button"
          className={styles.imageOverlayClose}
          data-testid="design-plan-screenshot-preview-close-btn"
          onClick={(e) => { e.stopPropagation(); setExpandedImage(false); }}
          aria-label="Close preview"
        >
          ✕
        </button>
        <img
          src={`data:${screenshot.mediaType};base64,${screenshot.imageBase64}`}
          alt={`Screenshot of ${screenshot.route}`}
          className={styles.imageOverlayImg}
          data-testid="design-plan-screenshot-preview-img"
          onClick={(e) => e.stopPropagation()}
        />
      </div>
    )}
    </>
  );
};

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

  const updatePageRoutes = useMemo(
    () => edited
      .filter((feature) => feature.decision === 'update-page')
      .flatMap((feature) => splitTargetRoutes(feature.targetRoute).map((raw) => normaliseUrlToRoute(raw))),
    [edited],
  );
  const screenshotStatus = usePageScreenshotStatuses(updatePageRoutes);
  const { gaps: updatePageScreenshotGaps, isChecking: isCheckingScreenshots } = useMemo(
    () => collectUpdatePageScreenshotGaps(edited, (route) => screenshotStatus.get(route)),
    [edited, screenshotStatus],
  );
  const generateHelperText = useMemo(
    () => buildUpdatePageGenerateHelperText(updatePageScreenshotGaps, isCheckingScreenshots),
    [updatePageScreenshotGaps, isCheckingScreenshots],
  );
  const generateBlockedByScreenshot = updatePageScreenshotGaps.length > 0 || isCheckingScreenshots;

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

    if (generateBlockedByScreenshot) {
      if (generateHelperText) alert(generateHelperText);
      return;
    }

    if (dirty) {
      await savePlan.mutateAsync({ planId: plan.id, prdId, features: edited });
      setDirty(false);
    }
    await generatePrototypes.mutateAsync({ planId: plan.id, prdId });
    navigate(`/backlog/design-prototypes/${prdId}`);
  }, [plan, prdId, dirty, edited, savePlan, generatePrototypes, navigate, generateBlockedByScreenshot, generateHelperText]);

  if (isLoading) {
    return <div className={styles.container}><p className={styles.muted}>Loading design plan…</p></div>;
  }

  if (error || !plan) {
    return (
      <div className={styles.container}>
        <button className={styles.backBtn} data-testid="design-plan-back-btn" onClick={() => navigate(`/backlog/prd/${prdId}`)} type="button">← Back to PRD</button>
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
          <button className={styles.backBtn} data-testid="design-plan-back-btn" onClick={() => navigate(`/backlog/prd/${prdId}`)} type="button">← Back to PRD</button>
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
                  {canEditPlan ? (
                    <label className={styles.decisionField}>
                      <span className={styles.label}>Decision</span>
                      <select
                        className={styles.select}
                        data-testid={`design-plan-decision-select-${feature.featureIndex}`}
                        value={feature.decision}
                        disabled={busy}
                        onChange={(e) => updateFeature(index, { decision: e.target.value as UiMockDecision })}
                      >
                        {DECISIONS.map((d) => <option key={d} value={d}>{d}</option>)}
                      </select>
                    </label>
                  ) : (
                    <span className={styles.decisionPill}>{feature.decision}</span>
                  )}
                </div>

                <label className={styles.briefField}>
                  <span className={styles.briefLabel}>Design Brief</span>
                  <textarea
                    className={styles.briefTextarea}
                    data-testid={`design-plan-brief-textarea-${feature.featureIndex}`}
                    value={feature.designBrief ?? ''}
                    rows={10}
                    placeholder="Describe the screen layout, key interactions, and user flow in plain English. The prototype generator will follow this brief."
                    disabled={!canEditPlan || busy}
                    onChange={(e) => updateFeature(index, { designBrief: e.target.value })}
                  />
                </label>

                {feature.decision === 'update-page' && (
                  <div className={styles.updatePageSection}>
                    <div className={styles.fieldRow}>
                      <label className={styles.field}>
                        <span className={styles.label}>Existing page address (required)</span>
                        <input
                          className={styles.input}
                          data-testid={`design-plan-target-route-input-${feature.featureIndex}`}
                          value={feature.targetRoute ?? ''}
                          placeholder="e.g. /Timecard/Entry or dev.mymaxview.com/Timecard/Entry"
                          disabled={!canEditPlan || busy}
                          onChange={(e) => updateFeature(index, { targetRoute: e.target.value || undefined })}
                        />
                      </label>
                      <label className={styles.field}>
                        <span className={styles.label}>Page title</span>
                        <input
                          className={styles.input}
                          data-testid={`design-plan-page-title-input-${feature.featureIndex}`}
                          value={feature.targetPageTitle ?? ''}
                          disabled={!canEditPlan || busy}
                          onChange={(e) => updateFeature(index, { targetPageTitle: e.target.value || undefined })}
                        />
                      </label>
                    </div>
                    {splitTargetRoutes(feature.targetRoute).length > 0
                      ? splitTargetRoutes(feature.targetRoute).map((r) => (
                        <PageScreenshotField
                          key={r}
                          route={r}
                          disabled={!canEditPlan || busy}
                        />
                      ))
                      : (
                        <PageScreenshotField
                          route={undefined}
                          disabled={!canEditPlan || busy}
                        />
                      )}
                  </div>
                )}

                <button
                  className={styles.detailsToggle}
                  data-testid={`design-plan-details-toggle-${feature.featureIndex}`}
                  type="button"
                  onClick={() => toggleDetails(index)}
                >
                  {expandedDetails.has(index) ? '▾' : '▸'} Technical Details
                </button>

                {expandedDetails.has(index) && (
                  <div className={styles.detailsSection}>
                    <div className={styles.fieldRow}>
                      <label className={styles.field}>
                        <span className={styles.label}>Layout pattern</span>
                        <select
                          className={styles.select}
                          data-testid={`design-plan-layout-select-${feature.featureIndex}`}
                          value={feature.layoutPattern ?? ''}
                          disabled={!canEditPlan || busy}
                          onChange={(e) => updateFeature(index, { layoutPattern: (e.target.value || undefined) as UiLayoutPattern | undefined })}
                        >
                          <option value="">(none)</option>
                          {LAYOUT_PATTERNS.map((l) => <option key={l} value={l}>{l}</option>)}
                        </select>
                      </label>
                    </div>

                    <label className={styles.field}>
                      <span className={styles.label}>Primary components (comma-separated)</span>
                      <input
                        className={styles.input}
                        data-testid={`design-plan-components-input-${feature.featureIndex}`}
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
                        data-testid={`design-plan-states-input-${feature.featureIndex}`}
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
                                data-testid={`design-plan-pbi-contribution-input-${feature.featureIndex}-${pbiIndex}`}
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
                        data-testid={`design-plan-rationale-textarea-${feature.featureIndex}`}
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
                        data-testid={`design-plan-notes-textarea-${feature.featureIndex}`}
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
            <div className={styles.footerBlock}>
              {generateHelperText && (
                <p className={styles.generateHelper}>{generateHelperText}</p>
              )}
              <div className={styles.footer}>
                <button
                  className={styles.secondaryBtn}
                  data-testid="design-plan-regenerate-btn"
                  onClick={handleRegenerate}
                  type="button"
                  disabled={busy}
                >
                  Regenerate Plan
                </button>
                <button
                  className={styles.secondaryBtn}
                  data-testid="design-plan-save-btn"
                  onClick={handleSave}
                  type="button"
                  disabled={busy || !dirty}
                >
                  {savePlan.isPending ? 'Saving…' : 'Save Changes'}
                </button>
                <button
                  className={styles.primaryBtn}
                  data-testid="design-plan-generate-btn"
                  onClick={handleGenerate}
                  type="button"
                  disabled={busy || generateBlockedByScreenshot}
                >
                  {generatePrototypes.isPending ? 'Generating…' : 'Generate Designs →'}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default DesignPlanReviewView;
