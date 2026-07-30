import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {
  WalkthroughDefinition,
  WalkthroughPublishMode,
} from '../../shared/types/walkthrough';
import type { WalkthroughAnchorRegistryEntry } from '../../shared/walkthroughAnchors';
import { WALKTHROUGH_REGISTRY_PLACEMENTS } from '../../shared/walkthroughAnchors';
import { getAssetDescription } from '../../shared/walkthroughAssets';
import {
  useArchiveWalkthrough,
  useCreateWalkthrough,
  usePublishWalkthrough,
  useUnpublishWalkthrough,
  useUpdateWalkthrough,
  useWalkthroughAnchors,
  useWalkthroughDetail,
} from '../hooks/usePlatformAdminWalkthroughs';
import { usePlatformAdminGroups, usePlatformAdminProjects } from '../hooks/usePlatformAdmin';
import {
  createEmptyStep,
  createWalkthroughDraftFormSchema,
  draftFormToCreateCommand,
  type WalkthroughDraftFormValues,
} from '../utils/walkthroughAuthoringValidation';
import { WalkthroughAiDraftPanel } from './WalkthroughAiDraftPanel';
import { NumberStepper } from './NumberStepper';
import styles from './WalkthroughAuthoring.module.css';

interface ManualWalkthroughEditorProps {
  walkthroughId: string | null;
  onClose: () => void;
  onSaved?: (walkthrough: WalkthroughDefinition) => void;
}

interface WalkthroughLifecycleDialogProps {
  walkthrough: WalkthroughDefinition;
  /** Current form project targets — used for publish validation (may differ from last saved). */
  targetProjects: string[];
  isOpen: boolean;
  isPending: boolean;
  onClose: () => void;
  onPublish: (mode: WalkthroughPublishMode) => void;
  onUnpublish: () => void;
  onArchive: () => void;
}

function definitionToFormValues(walkthrough: WalkthroughDefinition): WalkthroughDraftFormValues {
  return {
    internalName: walkthrough.internalName,
    userTitle: walkthrough.userTitle,
    whyItMatters: walkthrough.whyItMatters,
    priority: walkthrough.priority,
    projects: [...walkthrough.targeting.projects],
    groupId: walkthrough.targeting.groupId ?? null,
    steps: walkthrough.steps.map((step) => ({
      id: step.id,
      heading: step.heading,
      bodyMarkdown: step.bodyMarkdown,
      route: step.route ?? step.anchor?.targetRoute ?? null,
      imageUrl: step.imageUrl ?? null,
      imageAlt: step.imageAlt ?? '',
      ctaLabel: step.ctaLabel ?? null,
      ctaRoute: step.ctaRoute ?? null,
      anchorKey: step.anchor?.key ?? '',
      anchorTargetRoute: step.anchor?.targetRoute ?? '',
      anchorPlacement: step.anchor?.placement ?? '',
    })),
  };
}

export const WalkthroughLifecycleDialog: React.FC<WalkthroughLifecycleDialogProps> = ({
  walkthrough,
  targetProjects,
  isOpen,
  isPending,
  onClose,
  onPublish,
  onUnpublish,
  onArchive,
}) => {
  const isPublished = walkthrough.lifecycle === 'published';
  const canFreshPublish =
    walkthrough.lifecycle === 'draft' || walkthrough.lifecycle === 'unpublished';
  const canUpdatePublish = isPublished;
  const canPublish = canFreshPublish || canUpdatePublish;
  const canUnpublish = isPublished;
  const canArchive = walkthrough.lifecycle !== 'archived';

  const [mode, setMode] = useState<WalkthroughPublishMode>(isPublished ? 'silent' : 'fresh');
  const [lifecycleError, setLifecycleError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset dialog controls when opened; pre-existing FEAT-003 pattern
    setMode(isPublished ? 'silent' : 'fresh');
    setLifecycleError(null);
  }, [isOpen, isPublished]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handlePublish = () => {
    if (!targetProjects.length) {
      setLifecycleError('Select at least one project target before publishing.');
      return;
    }
    setLifecycleError(null);
    onPublish(mode);
  };

  return (
    // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- backdrop click-to-dismiss; Escape handled separately; pre-existing FEAT-003 pattern
    <div
      className={styles.dialogOverlay}
      role="dialog"
      aria-modal="true"
      aria-labelledby="walkthrough-lifecycle-title"
      aria-describedby="walkthrough-lifecycle-desc"
      {...{ 'data-testid': 'walkthrough-lifecycle-dialog' }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={styles.dialog}>
        <h3 id="walkthrough-lifecycle-title" className={styles.dialogTitle}>
          Walkthrough lifecycle
        </h3>
        <p id="walkthrough-lifecycle-desc" className={styles.dialogBody}>
          Current status: <strong>{walkthrough.lifecycle}</strong>
          {isPublished
            ? ' Choose silent update to keep acknowledgements, or re-show to increment revision and re-arm the live audience.'
            : ' Publishing makes this Walkthrough available to members of the selected project(s) (and optional group when a single project is selected).'}
        </p>

        {canFreshPublish && (
          <div className={styles.modeOptions} role="radiogroup" aria-label="Publish mode">
            <label className={`${styles.modeOption} ${mode === 'fresh' ? styles.modeOptionSelected : ''}`}>
              <input
                type="radio"
                name="publish-mode"
                value="fresh"
                checked={mode === 'fresh'}
                onChange={() => setMode('fresh')}
                {...{ 'data-testid': 'walkthrough-update-mode-fresh' }}
              />
              <span>Publish as new walkthrough (revision 1)</span>
            </label>
          </div>
        )}

        {canUpdatePublish && (
          <div className={styles.modeOptions} role="radiogroup" aria-label="Update publish mode">
            <label
              className={`${styles.modeOption} ${mode === 'silent' ? styles.modeOptionSelected : ''}`}
              {...{ 'data-testid': 'walkthrough-update-mode-silent' }}
            >
              <input
                type="radio"
                name="publish-mode"
                value="silent"
                checked={mode === 'silent'}
                onChange={() => setMode('silent')}
                {...{ 'data-testid': 'walkthrough-update-mode-silent-radio' }}
              />
              <span>Silent update — preserve revision and suppression</span>
            </label>
            <label
              className={`${styles.modeOption} ${mode === 'reshow' ? styles.modeOptionSelected : ''}`}
              {...{ 'data-testid': 'walkthrough-update-mode-reshow' }}
            >
              <input
                type="radio"
                name="publish-mode"
                value="reshow"
                checked={mode === 'reshow'}
                onChange={() => setMode('reshow')}
                {...{ 'data-testid': 'walkthrough-update-mode-reshow-radio' }}
              />
              <span>Publish update &amp; re-show — increment revision once</span>
            </label>
          </div>
        )}

        {lifecycleError && (
          <p className={styles.fieldError} role="alert" {...{ 'data-testid': 'walkthrough-lifecycle-error' }}>
            {lifecycleError}
          </p>
        )}

        <div className={styles.dialogActions}>
          <button
            type="button"
            className={styles.button}
            onClick={onClose}
            disabled={isPending}
            {...{ 'data-testid': 'walkthrough-lifecycle-cancel' }}
          >
            Cancel
          </button>
          {canUnpublish && (
            <button
              type="button"
              className={styles.buttonDanger}
              {...{ 'data-testid': 'walkthrough-unpublish' }}
              disabled={isPending}
              onClick={onUnpublish}
            >
              Unpublish
            </button>
          )}
          {canArchive && (
            <button
              type="button"
              className={styles.buttonDanger}
              {...{ 'data-testid': 'walkthrough-archive' }}
              disabled={isPending}
              onClick={onArchive}
            >
              Archive (preserves history)
            </button>
          )}
          {canPublish && (
            <button
              type="button"
              className={styles.buttonPrimary}
              disabled={isPending}
              onClick={handlePublish}
              {...{ 'data-testid': 'walkthrough-lifecycle-confirm-publish' }}
            >
              {isPending ? 'Working…' : canUpdatePublish ? 'Confirm update' : 'Publish'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export const WalkthroughMarkdownPreview: React.FC<{ markdown: string; imageUrl?: string | null; imageAlt?: string }> = ({
  markdown,
  imageUrl,
  imageAlt,
}) => (
  <div className={styles.preview}>
    <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown || '_No content yet_'}</ReactMarkdown>
    {imageUrl ? (
      <img className={styles.previewImage} src={imageUrl} alt={imageAlt || ''} />
    ) : null}
  </div>
);

export const ManualWalkthroughEditor: React.FC<ManualWalkthroughEditorProps> = ({
  walkthroughId,
  onClose,
  onSaved,
}) => {
  const detailQuery = useWalkthroughDetail(walkthroughId);
  const anchorsQuery = useWalkthroughAnchors();
  const projectsQuery = usePlatformAdminProjects();
  const groupsQuery = usePlatformAdminGroups();
  const createMutation = useCreateWalkthrough();
  const updateMutation = useUpdateWalkthrough();
  const publishMutation = usePublishWalkthrough();
  const unpublishMutation = useUnpublishWalkthrough();
  const archiveMutation = useArchiveWalkthrough();

  const [lifecycleOpen, setLifecycleOpen] = useState(false);
  const [reorderAnnouncement, setReorderAnnouncement] = useState('');
  const [savedWalkthrough, setSavedWalkthrough] = useState<WalkthroughDefinition | null>(null);
  const loadedIdRef = useRef<string | null>(null);

  const defaultValues = useMemo<WalkthroughDraftFormValues>(
    () => ({
      internalName: '',
      userTitle: '',
      whyItMatters: '',
      priority: 0,
      projects: [],
      groupId: null,
      steps: [createEmptyStep(0)],
    }),
    [],
  );

  const {
    register,
    control,
    handleSubmit,
    watch,
    reset,
    setValue,
    formState: { errors, isDirty },
  } = useForm<WalkthroughDraftFormValues>({
    resolver: (values, context, options) =>
      zodResolver(createWalkthroughDraftFormSchema(anchorsQuery.data ?? []))(
        values,
        context,
        options,
      ),
    defaultValues,
  });

  const { fields, append, remove, move, replace } = useFieldArray({ control, name: 'steps' });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- RHF watch() identity; projectGroups must follow form projects
  const watchedProjects = watch('projects') ?? [];
  const watchedSteps = watch('steps');
  const watchedPriority = watch('priority');

  const projectGroups = useMemo(
    () =>
      watchedProjects.length === 1
        ? (groupsQuery.data ?? []).filter((group) => group.project === watchedProjects[0])
        : [],
    [groupsQuery.data, watchedProjects],
  );

  const catalogProjects = projectsQuery.data ?? [];

  const toggleProject = (projectName: string) => {
    const selected = new Set(watchedProjects);
    if (selected.has(projectName)) selected.delete(projectName);
    else selected.add(projectName);
    const next = catalogProjects.map((p) => p.name).filter((name) => selected.has(name));
    setValue('projects', next, { shouldDirty: true, shouldValidate: true });
    if (next.length !== 1) {
      setValue('groupId', null, { shouldDirty: true });
    }
  };

  const selectAllProjects = () => {
    setValue(
      'projects',
      catalogProjects.map((p) => p.name),
      { shouldDirty: true, shouldValidate: true },
    );
    setValue('groupId', null, { shouldDirty: true });
  };

  const clearAllProjects = () => {
    setValue('projects', [], { shouldDirty: true, shouldValidate: true });
    setValue('groupId', null, { shouldDirty: true });
  };

  const anchors = anchorsQuery.data ?? [];

  useEffect(() => {
    if (!walkthroughId || !detailQuery.data) return;
    if (loadedIdRef.current === walkthroughId) return;
    loadedIdRef.current = walkthroughId;
    reset(definitionToFormValues(detailQuery.data));
    setSavedWalkthrough(detailQuery.data);
  }, [walkthroughId, detailQuery.data, reset]);

  useEffect(() => {
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (isDirty) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirty]);

  const handleClose = useCallback(() => {
    if (isDirty && !window.confirm('Discard unsaved changes?')) return;
    onClose();
  }, [isDirty, onClose]);

  const handleAiMergeDraft = useCallback(
    (next: {
      internalName: string;
      userTitle: string;
      whyItMatters: string;
      steps: Array<{
        id?: string;
        ordinal: number;
        heading: string;
        bodyMarkdown: string;
        route?: string | null;
        imageUrl?: string | null;
        imageAlt?: string | null;
        ctaLabel?: string | null;
        ctaRoute?: string | null;
        anchor?: {
          key: string;
          targetRoute: string;
          placement:
            | 'top'
            | 'bottom'
            | 'left'
            | 'right'
            | 'top-start'
            | 'top-end'
            | 'bottom-start'
            | 'bottom-end';
        } | null;
      }>;
    }) => {
      setValue('internalName', next.internalName, { shouldDirty: true });
      setValue('userTitle', next.userTitle, { shouldDirty: true });
      setValue('whyItMatters', next.whyItMatters, { shouldDirty: true });
      // useFieldArray requires replace() — setValue('steps') leaves stale field rows (empty Step 1).
      replace(
        next.steps.length > 0
          ? next.steps.map((step, index) => ({
              id: step.id ?? `ai-${index}`,
              heading: step.heading,
              bodyMarkdown: step.bodyMarkdown,
              route: step.route ?? step.anchor?.targetRoute ?? null,
              imageUrl: step.imageUrl ?? null,
              imageAlt: step.imageAlt ?? '',
              ctaLabel: step.ctaLabel ?? null,
              ctaRoute: step.ctaRoute ?? null,
              anchorKey: step.anchor?.key ?? '',
              anchorTargetRoute: step.anchor?.targetRoute ?? '',
              anchorPlacement: step.anchor?.placement ?? '',
            }))
          : [createEmptyStep(0)],
      );
    },
    [replace, setValue],
  );

  const onSaveDraft = handleSubmit(async (values) => {
    const command = draftFormToCreateCommand(values);
    const effectiveId = walkthroughId ?? savedWalkthrough?.id ?? null;
    if (effectiveId && savedWalkthrough) {
      const updated = await updateMutation.mutateAsync({
        id: effectiveId,
        ...command,
        expectedUpdatedAt: savedWalkthrough.updatedAt,
      });
      setSavedWalkthrough(updated);
      reset(definitionToFormValues(updated));
      onSaved?.(updated);
      return;
    }
    const created = await createMutation.mutateAsync(command);
    setSavedWalkthrough(created);
    loadedIdRef.current = created.id;
    reset(definitionToFormValues(created));
    onSaved?.(created);
  });

  const currentWalkthrough = savedWalkthrough ?? detailQuery.data ?? null;
  const isSaving = createMutation.isPending || updateMutation.isPending;
  const lifecyclePending =
    publishMutation.isPending || unpublishMutation.isPending || archiveMutation.isPending;

  const validationMessages = useMemo(() => {
    const messages: string[] = [];
    const collect = (obj: Record<string, unknown>, prefix = '') => {
      for (const [key, value] of Object.entries(obj)) {
        const path = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === 'object' && 'message' in (value as object)) {
          messages.push(`${path}: ${(value as { message?: string }).message}`);
        } else if (value && typeof value === 'object') {
          collect(value as Record<string, unknown>, path);
        }
      }
    };
    collect(errors as Record<string, unknown>);
    return messages;
  }, [errors]);

  const handleMoveStep = (index: number, direction: 'up' | 'down') => {
    const target = direction === 'up' ? index - 1 : index + 1;
    if (target < 0 || target >= fields.length) return;
    move(index, target);
    setReorderAnnouncement(`Moved step ${index + 1} ${direction}`);
  };

  const handleAnchorKeyChange = (index: number, key: string, registry: WalkthroughAnchorRegistryEntry[]) => {
    setValue(`steps.${index}.anchorKey`, key);
    const entry = registry.find((anchor) => anchor.key === key);
    if (entry) {
      setValue(`steps.${index}.anchorTargetRoute`, entry.targetRoute);
      // eslint-disable-next-line react-hooks/incompatible-library -- react-hook-form watch is required for current placement read; pre-existing FEAT-003 pattern
      if (!watch(`steps.${index}.anchorPlacement`)) {
        setValue(`steps.${index}.anchorPlacement`, entry.allowedPlacements[0] ?? 'bottom');
      }
    }
  };

  // Auto-populate imageAlt from curated asset registry when imageUrl is set but alt is empty
  const prevImageUrlsRef = useRef<string[]>([]);
  useEffect(() => {
    if (!watchedSteps) return;
    const currentUrls = watchedSteps.map((s) => s?.imageUrl?.trim() ?? '');
    const prev = prevImageUrlsRef.current;
    prevImageUrlsRef.current = currentUrls;
    for (let i = 0; i < currentUrls.length; i++) {
      const url = currentUrls[i];
      if (url && url !== (prev[i] ?? '') && !watchedSteps[i]?.imageAlt?.trim()) {
        const desc = getAssetDescription(url);
        if (desc) {
          setValue(`steps.${i}.imageAlt`, desc, { shouldDirty: true });
        }
      }
    }
  }, [watchedSteps, setValue]);

  if (walkthroughId && detailQuery.isLoading) {
    return <p className={styles.statusMessage}>Loading walkthrough…</p>;
  }

  if (walkthroughId && detailQuery.isError) {
    return (
      <p className={styles.statusMessage} role="alert">
        {detailQuery.error instanceof Error ? detailQuery.error.message : 'Failed to load walkthrough'}
      </p>
    );
  }

  return (
    <div className={styles.editor} {...{ 'data-testid': 'walkthrough-editor' }}>
      <div className={styles.header}>
        <div>
          <h2 className={styles.title}>
            {walkthroughId ? 'Edit Walkthrough' : 'Create Walkthrough'}
          </h2>
          <p className={styles.subtitle}>
            {currentWalkthrough
              ? `Status: ${currentWalkthrough.lifecycle} · Revision ${currentWalkthrough.revision}`
              : 'Draft changes are saved without publishing.'}
          </p>
        </div>
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.button}
            onClick={handleClose}
            {...{ 'data-testid': 'walkthrough-editor-back' }}
          >
            Back to catalog
          </button>
          <button
            type="button"
            className={styles.buttonPrimary}
            {...{ 'data-testid': 'walkthrough-save-draft' }}
            disabled={isSaving}
            onClick={onSaveDraft}
          >
            {isSaving ? 'Saving…' : 'Save draft'}
          </button>
          {currentWalkthrough && currentWalkthrough.lifecycle !== 'archived' && (
            <button
              type="button"
              className={styles.button}
              {...{ 'data-testid': 'walkthrough-publish' }}
              disabled={isSaving}
              onClick={() => setLifecycleOpen(true)}
            >
              Lifecycle…
            </button>
          )}
        </div>
      </div>

      {validationMessages.length > 0 && (
        <div className={styles.validationSummary} {...{ 'data-testid': 'walkthrough-validation-summary' }}>
          <p className={styles.validationSummaryTitle}>Fix validation errors before saving</p>
          <ul className={styles.validationList}>
            {validationMessages.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        </div>
      )}

      <section className={styles.section} aria-labelledby="walkthrough-metadata-title">
        <h3 id="walkthrough-metadata-title" className={styles.sectionTitle}>
          Metadata
        </h3>
        <div className={styles.fieldGrid}>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="internalName">Internal name</label>
            <input
              id="internalName"
              className={styles.input}
              {...register('internalName')}
              {...{ 'data-testid': 'walkthrough-internal-name' }}
            />
            {errors.internalName && <p className={styles.fieldError}>{errors.internalName.message}</p>}
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="userTitle">User title</label>
            <input
              id="userTitle"
              className={styles.input}
              {...register('userTitle')}
              {...{ 'data-testid': 'walkthrough-user-title' }}
            />
            {errors.userTitle && <p className={styles.fieldError}>{errors.userTitle.message}</p>}
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="priority">Priority</label>
            <NumberStepper
              id="priority"
              className={styles.priorityStepper}
              aria-label="Walkthrough priority"
              value={Number.isFinite(watchedPriority) ? watchedPriority : 0}
              min={0}
              max={999}
              step={1}
              onChange={(next) => setValue('priority', next, { shouldDirty: true, shouldValidate: true })}
              {...{ 'data-testid': 'walkthrough-priority' }}
            />
          </div>
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="whyItMatters">Why it matters</label>
          <textarea
            id="whyItMatters"
            className={styles.textarea}
            {...register('whyItMatters')}
            {...{ 'data-testid': 'walkthrough-why-it-matters' }}
          />
        </div>
      </section>

      <section className={styles.section} aria-labelledby="walkthrough-targeting-title">
        <h3 id="walkthrough-targeting-title" className={styles.sectionTitle}>
          Targeting
        </h3>
        <div className={styles.fieldGrid}>
          <div className={styles.field}>
            <span className={styles.label} id="walkthrough-projects-label">
              Projects
            </span>
            <div
              className={styles.projectPicker}
              role="group"
              aria-labelledby="walkthrough-projects-label"
              {...{ 'data-testid': 'walkthrough-project-target' }}
            >
              <div className={styles.projectPickerActions}>
                <button
                  type="button"
                  className={styles.button}
                  onClick={selectAllProjects}
                  disabled={catalogProjects.length === 0}
                  {...{ 'data-testid': 'walkthrough-projects-select-all' }}
                >
                  Select all
                </button>
                <button
                  type="button"
                  className={styles.button}
                  onClick={clearAllProjects}
                  disabled={watchedProjects.length === 0}
                  {...{ 'data-testid': 'walkthrough-projects-clear' }}
                >
                  Clear
                </button>
              </div>
              <ul className={styles.projectPickerList}>
                {catalogProjects.map((project) => {
                  const checked = watchedProjects.includes(project.name);
                  return (
                    <li key={project.id}>
                      <label className={styles.projectPickerOption}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleProject(project.name)}
                          {...{ 'data-testid': `walkthrough-project-option-${project.name}` }}
                        />
                        <span>{project.name}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
              {catalogProjects.length === 0 && (
                <p className={styles.projectPickerHint}>No projects available.</p>
              )}
            </div>
            {errors.projects && (
              <p className={styles.fieldError}>{errors.projects.message ?? 'Select at least one project'}</p>
            )}
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="groupId">Group (optional)</label>
            <select
              id="groupId"
              className={styles.select}
              {...register('groupId')}
              {...{ 'data-testid': 'walkthrough-group-target' }}
              disabled={watchedProjects.length !== 1}
            >
              <option value="">
                {watchedProjects.length === 1 ? 'All project users' : 'Select a single project to filter by group'}
              </option>
              {projectGroups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
            {errors.groupId && <p className={styles.fieldError}>{errors.groupId.message}</p>}
            {watchedProjects.length > 1 && (
              <p className={styles.projectPickerHint}>
                Group filters apply only when exactly one project is selected.
              </p>
            )}
          </div>
        </div>
      </section>

      <WalkthroughAiDraftPanel
        {...{ 'data-testid': 'walkthrough-ai-draft-panel' }}
        projectId={watchedProjects[0] ?? ''}
        currentDraft={{
          internalName: watch('internalName') || '',
          userTitle: watch('userTitle') || '',
          whyItMatters: watch('whyItMatters') || '',
          steps: (watchedSteps ?? []).map((step, index) => ({
            id: step.id,
            ordinal: index,
            heading: step.heading || '',
            bodyMarkdown: step.bodyMarkdown || '',
            route: step.route,
            imageUrl: step.imageUrl,
            imageAlt: step.imageAlt,
            ctaLabel: step.ctaLabel,
            ctaRoute: step.ctaRoute,
            anchor:
              step.anchorKey && step.anchorTargetRoute && step.anchorPlacement
                ? {
                    key: step.anchorKey,
                    targetRoute: step.anchorTargetRoute,
                    placement: step.anchorPlacement as
                      | 'top'
                      | 'bottom'
                      | 'left'
                      | 'right'
                      | 'top-start'
                      | 'top-end'
                      | 'bottom-start'
                      | 'bottom-end',
                  }
                : null,
          })),
        }}
        onMergeDraft={handleAiMergeDraft}
      />

      <section className={styles.section} aria-labelledby="walkthrough-steps-title">
        <div className={styles.stepHeader}>
          <h3 id="walkthrough-steps-title" className={styles.sectionTitle}>
            Steps ({fields.length}/20)
          </h3>
          <button
            type="button"
            className={styles.button}
            {...{ 'data-testid': 'walkthrough-step-add' }}
            disabled={fields.length >= 20}
            onClick={() => append(createEmptyStep(fields.length))}
          >
            Add step
          </button>
        </div>

        <p className={styles.reorderLive} aria-live="polite">
          {reorderAnnouncement}
        </p>

        <div className={styles.stepList}>
          {fields.map((field, index) => {
            const step = watchedSteps[index];
            const selectedAnchor = anchors.find((anchor) => anchor.key === step?.anchorKey);
            const allowedPlacements = selectedAnchor?.allowedPlacements ?? WALKTHROUGH_REGISTRY_PLACEMENTS;
            const stepErrors = errors.steps?.[index];

            return (
              <article
                key={field.id}
                className={styles.stepCard}
                {...{ 'data-testid': `walkthrough-step-${field.id}` }}
              >
                <div className={styles.stepHeader}>
                  <h4 className={styles.stepTitle}>Step {index + 1}</h4>
                  <div className={styles.stepActions}>
                    <button
                      type="button"
                      className={styles.iconButton}
                      {...{ 'data-testid': `walkthrough-step-move-up-${field.id}` }}
                      aria-label={`Move step ${index + 1} up`}
                      disabled={index === 0}
                      onClick={() => handleMoveStep(index, 'up')}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className={styles.iconButton}
                      {...{ 'data-testid': `walkthrough-step-move-down-${field.id}` }}
                      aria-label={`Move step ${index + 1} down`}
                      disabled={index === fields.length - 1}
                      onClick={() => handleMoveStep(index, 'down')}
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      className={styles.iconButton}
                      aria-label={`Remove step ${index + 1}`}
                      disabled={fields.length <= 1}
                      onClick={() => remove(index)}
                      {...{ 'data-testid': `walkthrough-step-remove-${field.id}` }}
                    >
                      ✕
                    </button>
                  </div>
                </div>

                <div className={styles.fieldGrid}>
                  <div className={styles.field}>
                    <label className={styles.label} htmlFor={`heading-${field.id}`}>Heading</label>
                    <input
                      id={`heading-${field.id}`}
                      className={styles.input}
                      {...register(`steps.${index}.heading`)}
                      {...{ 'data-testid': `walkthrough-step-heading-${field.id}` }}
                    />
                  </div>
                  <div className={styles.field}>
                    <label className={styles.label} htmlFor={`imageUrl-${field.id}`}>Image URL</label>
                    <input
                      id={`imageUrl-${field.id}`}
                      className={styles.input}
                      {...register(`steps.${index}.imageUrl`)}
                      {...{ 'data-testid': `walkthrough-step-image-url-${field.id}` }}
                    />
                    {stepErrors?.imageUrl && <p className={styles.fieldError}>{stepErrors.imageUrl.message}</p>}
                  </div>
                  {step?.imageUrl?.trim() && (
                    <div className={styles.field}>
                      <label className={styles.label} htmlFor={`imageAlt-${field.id}`}>Image alt text</label>
                      <input
                        id={`imageAlt-${field.id}`}
                        className={styles.input}
                        {...register(`steps.${index}.imageAlt`)}
                        {...{ 'data-testid': `walkthrough-step-image-alt-${field.id}` }}
                      />
                      {stepErrors?.imageAlt && <p className={styles.fieldError}>{stepErrors.imageAlt.message}</p>}
                    </div>
                  )}
                </div>

                <div className={styles.field}>
                  <label className={styles.label} htmlFor={`body-${field.id}`}>Body (Markdown)</label>
                  <textarea
                    id={`body-${field.id}`}
                    className={styles.textarea}
                    {...register(`steps.${index}.bodyMarkdown`)}
                    {...{ 'data-testid': `walkthrough-step-body-${field.id}` }}
                  />
                </div>

                <WalkthroughMarkdownPreview
                  markdown={step?.bodyMarkdown ?? ''}
                  imageUrl={step?.imageUrl}
                  imageAlt={step?.imageAlt}
                />

                <div className={styles.fieldGrid}>
                  <div className={styles.field}>
                    <label className={styles.label} htmlFor={`ctaLabel-${field.id}`}>CTA label</label>
                    <input
                      id={`ctaLabel-${field.id}`}
                      className={styles.input}
                      {...register(`steps.${index}.ctaLabel`)}
                      {...{ 'data-testid': `walkthrough-step-cta-label-${field.id}` }}
                    />
                    {stepErrors?.ctaLabel && <p className={styles.fieldError}>{stepErrors.ctaLabel.message}</p>}
                  </div>
                  <div className={styles.field}>
                    <label className={styles.label} htmlFor={`ctaRoute-${field.id}`}>CTA route</label>
                    <input
                      id={`ctaRoute-${field.id}`}
                      className={styles.input}
                      {...register(`steps.${index}.ctaRoute`)}
                      {...{ 'data-testid': `walkthrough-step-cta-route-${field.id}` }}
                    />
                    {stepErrors?.ctaRoute && <p className={styles.fieldError}>{stepErrors.ctaRoute.message}</p>}
                  </div>
                </div>

                <div className={styles.fieldGrid}>
                  <div className={styles.field}>
                    <label className={styles.label} htmlFor={`anchorKey-${field.id}`}>Anchor</label>
                    <select
                      id={`anchorKey-${field.id}`}
                      className={styles.select}
                      value={step?.anchorKey ?? ''}
                      {...{ 'data-testid': `walkthrough-anchor-key-${field.id}` }}
                      onChange={(event) => handleAnchorKeyChange(index, event.target.value, anchors)}
                    >
                      <option value="">No anchor (centered)</option>
                      {anchors.map((anchor) => (
                        <option key={anchor.key} value={anchor.key}>
                          {anchor.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  {step?.anchorKey && (
                    <>
                      <div className={styles.field}>
                        <label className={styles.label} htmlFor={`anchorRoute-${field.id}`}>Anchor route</label>
                        <input
                          id={`anchorRoute-${field.id}`}
                          className={styles.input}
                          readOnly
                          {...register(`steps.${index}.anchorTargetRoute`)}
                          {...{ 'data-testid': `walkthrough-anchor-route-${field.id}` }}
                        />
                      </div>
                      <div className={styles.field}>
                        <label className={styles.label} htmlFor={`anchorPlacement-${field.id}`}>Placement</label>
                        <select
                          id={`anchorPlacement-${field.id}`}
                          className={styles.select}
                          {...register(`steps.${index}.anchorPlacement`)}
                          {...{ 'data-testid': `walkthrough-anchor-placement-${field.id}` }}
                        >
                          {allowedPlacements.map((placement) => (
                            <option key={placement} value={placement}>
                              {placement}
                            </option>
                          ))}
                        </select>
                      </div>
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </section>

      {currentWalkthrough && (
        // data-testid-exempt — dialog root already exposes walkthrough-lifecycle-dialog when open
        <WalkthroughLifecycleDialog
          walkthrough={currentWalkthrough}
          targetProjects={watchedProjects}
          isOpen={lifecycleOpen}
          isPending={lifecyclePending}
          onClose={() => setLifecycleOpen(false)}
          onPublish={async (mode) => {
            const values = watch();
            const published = await publishMutation.mutateAsync({
              id: currentWalkthrough.id,
              mode,
              targeting: {
                projects: values.projects,
                groupId: values.projects.length === 1 ? values.groupId || null : null,
              },
              expectedUpdatedAt: currentWalkthrough.updatedAt,
            });
            setSavedWalkthrough(published);
            reset(definitionToFormValues(published));
            setLifecycleOpen(false);
          }}
          onUnpublish={async () => {
            const result = await unpublishMutation.mutateAsync({
              id: currentWalkthrough.id,
              expectedUpdatedAt: currentWalkthrough.updatedAt,
            });
            setSavedWalkthrough(result);
            reset(definitionToFormValues(result));
            setLifecycleOpen(false);
          }}
          onArchive={async () => {
            const result = await archiveMutation.mutateAsync({
              id: currentWalkthrough.id,
              expectedUpdatedAt: currentWalkthrough.updatedAt,
            });
            setSavedWalkthrough(result);
            reset(definitionToFormValues(result));
            setLifecycleOpen(false);
          }}
        />
      )}
    </div>
  );
};
