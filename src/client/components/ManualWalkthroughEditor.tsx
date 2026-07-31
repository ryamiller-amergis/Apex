import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {
  WalkthroughDefinition,
  WalkthroughPublishMode,
  WalkthroughStepInput,
} from '../../shared/types/walkthrough';
import type { WalkthroughAnchorRegistryEntry } from '../../shared/walkthroughAnchors';
import { WALKTHROUGH_REGISTRY_PLACEMENTS } from '../../shared/walkthroughAnchors';
import { getAssetDescription } from '../../shared/walkthroughAssets';
import { listWalkthroughRoutes } from '../../shared/walkthroughRoutes';
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
import { AiStepBuilderModal } from './AiStepBuilderModal';
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
          Publish walkthrough
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
  const [aiStepOpen, setAiStepOpen] = useState(false);
  const [stepsInfoOpen, setStepsInfoOpen] = useState(false);
  const [anchorRouteFilterByStepId, setAnchorRouteFilterByStepId] = useState<Record<string, string>>({});
  const [anchorSearchByStepId, setAnchorSearchByStepId] = useState<Record<string, string>>({});
  const [ctaRouteSearchByStepId, setCtaRouteSearchByStepId] = useState<Record<string, string>>({});
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

  const { fields, append, insert, remove, move, replace } = useFieldArray({ control, name: 'steps' });
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

  const anchors = useMemo(() => anchorsQuery.data ?? [], [anchorsQuery.data]);
  const walkthroughRoutes = useMemo(() => listWalkthroughRoutes(), []);

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

  const handleAiInsertStep = useCallback(
    (index: number, step: WalkthroughStepInput) => {
      insert(
        index,
        {
          id: step.id ?? `ai-${Date.now()}`,
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
        },
        { shouldFocus: true },
      );
      setReorderAnnouncement(`Inserted AI-generated step at position ${index + 1}`);
    },
    [insert],
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
      // Keep step route aligned with the catalog entry so save validation cannot
      // fail with a route/anchor mismatch after the author picks a different anchor.
      setValue(`steps.${index}.route`, entry.targetRoute);
      // eslint-disable-next-line react-hooks/incompatible-library -- react-hook-form watch is required for current placement read; pre-existing FEAT-003 pattern
      const currentPlacement = watch(`steps.${index}.anchorPlacement`);
      if (
        !currentPlacement ||
        !(entry.allowedPlacements as readonly string[]).includes(currentPlacement)
      ) {
        setValue(`steps.${index}.anchorPlacement`, entry.allowedPlacements[0] ?? 'bottom');
      }
    } else {
      setValue(`steps.${index}.anchorTargetRoute`, '');
      setValue(`steps.${index}.anchorPlacement`, '');
    }
  };

  // Catalog placement options can change after a walkthrough is saved. Reconcile
  // stale form values so the visible default is also the value submitted on save.
  useEffect(() => {
    if (!watchedSteps || anchors.length === 0) return;
    watchedSteps.forEach((step, index) => {
      if (!step?.anchorKey || !step.anchorPlacement) return;
      const entry = anchors.find((anchor) => anchor.key === step.anchorKey);
      if (
        !entry ||
        (entry.allowedPlacements as readonly string[]).includes(step.anchorPlacement)
      ) return;
      setValue(
        `steps.${index}.anchorPlacement`,
        entry.allowedPlacements[0] ?? 'bottom',
        { shouldDirty: true, shouldValidate: true },
      );
    });
  }, [anchors, setValue, watchedSteps]);

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
            {currentWalkthrough && isDirty
              ? ' · Unsaved changes — save your draft before publishing.'
              : ''}
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
              disabled={isSaving || isDirty}
              title={isDirty ? 'Save your draft before publishing' : undefined}
              onClick={() => setLifecycleOpen(true)}
            >
              Publish…
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
          <div className={styles.stepHeaderTitle}>
            <h3 id="walkthrough-steps-title" className={styles.sectionTitle}>
              Steps ({fields.length}/20)
            </h3>
            <button
              type="button"
              className={styles.infoButton}
              aria-expanded={stepsInfoOpen}
              aria-controls="walkthrough-steps-info"
              aria-label="What do these step fields do?"
              title="What do these step fields do?"
              {...{ 'data-testid': 'walkthrough-steps-info-toggle' }}
              onClick={() => setStepsInfoOpen((open) => !open)}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z" />
                <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533L8.93 6.588zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z" />
              </svg>
            </button>
          </div>
          <div className={styles.stepActions}>
            <button
              type="button"
              className={styles.button}
              {...{ 'data-testid': 'walkthrough-step-add' }}
              disabled={fields.length >= 20}
              onClick={() => append(createEmptyStep(fields.length))}
            >
              Add step
            </button>
            <button
              type="button"
              className={styles.buttonPrimary}
              {...{ 'data-testid': 'walkthrough-step-ai-build' }}
              disabled={fields.length >= 20}
              onClick={() => setAiStepOpen(true)}
            >
              Build with AI
            </button>
          </div>
        </div>

        {stepsInfoOpen && (
          <div
            id="walkthrough-steps-info"
            className={styles.infoPanel}
            role="note"
            {...{ 'data-testid': 'walkthrough-steps-info-panel' }}
          >
            <p className={styles.infoPanelIntro}>
              Each step becomes one card in the live walkthrough. Users move through them with
              <strong> Back / Next</strong>, and every field below maps to what they see in the app:
            </p>
            <dl className={styles.infoPanelList}>
              <div>
                <dt>Heading</dt>
                <dd>The bold title at the top of the coachmark/modal card.</dd>
              </div>
              <div>
                <dt>Body (Markdown)</dt>
                <dd>The explanatory text under the heading. Markdown (bold, code, links) is rendered live.</dd>
              </div>
              <div>
                <dt>Anchor</dt>
                <dd>
                  The specific on-screen element the card points at and highlights. Leave it as
                  <em> No anchor</em> to show a centered modal instead of a pinned coachmark.
                </dd>
              </div>
              <div>
                <dt>Hidden anchors (modals, menus, and tabs)</dt>
                <dd>
                  AI can select a hidden target, but the reveal action is configured on that target
                  in <strong>Walkthroughs → Anchor Management</strong>. Edit the target anchor and
                  add approved, active <strong>Opener anchors</strong> in click order. For example,
                  <code>design-module-add-btn</code> opens the dialog containing
                  <code> design-module-save-btn</code>. If a step unexpectedly appears centered,
                  verify its opener anchors, save the anchor, then reopen the walkthrough.
                </dd>
              </div>
              <div>
                <dt>Anchor route</dt>
                <dd>The in-app page the user is taken to for this step so the anchored element is visible.</dd>
              </div>
              <div>
                <dt>Placement</dt>
                <dd>
                  Which side of the anchor the card prefers (top / right / bottom / left). If that side is
                  off-screen, the walkthrough auto-repositions to keep the card fully visible.
                </dd>
              </div>
              <div>
                <dt>CTA label &amp; CTA route</dt>
                <dd>An optional action button on the card (e.g. “Go to Design Module”) that navigates in-app when clicked.</dd>
              </div>
              <div>
                <dt>Image URL &amp; alt text</dt>
                <dd>An optional image shown inside the card; alt text is required for accessibility when an image is set.</dd>
              </div>
              <div>
                <dt>Step order</dt>
                <dd>Use the ↑ / ↓ controls to reorder. The first step is what users see when the walkthrough launches.</dd>
              </div>
            </dl>
          </div>
        )}

        <p className={styles.reorderLive} aria-live="polite">
          {reorderAnnouncement}
        </p>

        <div className={styles.stepList}>
          {fields.map((field, index) => {
            const step = watchedSteps[index];
            const selectedAnchor = anchors.find((anchor) => anchor.key === step?.anchorKey);
            const allowedPlacements = selectedAnchor?.allowedPlacements ?? WALKTHROUGH_REGISTRY_PLACEMENTS;
            const anchorRouteFilter = anchorRouteFilterByStepId[field.id] ?? '';
            const anchorSearch = (anchorSearchByStepId[field.id] ?? '').trim().toLowerCase();
            const matchingAnchors = anchors
              .filter((anchor) => !anchorRouteFilter || anchor.targetRoute === anchorRouteFilter)
              .filter((anchor) => {
                if (!anchorSearch) return true;
                return [
                  anchor.label,
                  anchor.key,
                  anchor.testId,
                  anchor.targetRoute,
                  ...(anchor.smartTags ?? []),
                ]
                  .join(' ')
                  .toLowerCase()
                  .includes(anchorSearch);
              })
              .slice()
              .sort((a, b) => a.label.localeCompare(b.label));
            const visibleAnchors =
              selectedAnchor && !matchingAnchors.some((anchor) => anchor.key === selectedAnchor.key)
                ? [selectedAnchor, ...matchingAnchors]
                : matchingAnchors;
            const anchorRouteOptions = Array.from(
              new Set(anchors.map((anchor) => anchor.targetRoute).filter(Boolean)),
            ).sort();
            const ctaRouteSearch = (ctaRouteSearchByStepId[field.id] ?? '')
              .trim()
              .toLowerCase();
            const matchingCtaRoutes = walkthroughRoutes.filter((entry) => {
              if (!ctaRouteSearch) return true;
              return `${entry.label} ${entry.route}`.toLowerCase().includes(ctaRouteSearch);
            });
            const selectedCtaRoute = walkthroughRoutes.find(
              (entry) => entry.route === step?.ctaRoute,
            );
            const visibleCtaRoutes =
              selectedCtaRoute &&
              !matchingCtaRoutes.some((entry) => entry.route === selectedCtaRoute.route)
                ? [selectedCtaRoute, ...matchingCtaRoutes]
                : matchingCtaRoutes;
            const stepErrors = errors.steps?.[index];
            const hasCtaLabel = Boolean(step?.ctaLabel?.trim());
            const hasCtaRoute = Boolean(step?.ctaRoute?.trim());
            // Live nudge so the "both or neither" rule never blocks a save by surprise.
            const ctaIncomplete = hasCtaLabel !== hasCtaRoute;

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

                <div className={styles.subsection}>
                  <h4 className={styles.subsectionTitle}>In-step button</h4>
                  {ctaIncomplete ? (
                    <p
                      className={styles.fieldWarning}
                      {...{ 'data-testid': `walkthrough-step-cta-hint-${field.id}` }}
                    >
                      {hasCtaLabel
                        ? 'Pick a CTA route to turn this into a button, or clear the label to skip it.'
                        : 'Add a CTA label to turn this into a button, or set the route back to “No CTA link”.'}
                    </p>
                  ) : (
                    <p className={styles.fieldHint}>
                      Optional: set a CTA <strong>label</strong> and <strong>route</strong> together to show an
                      in-step button that takes users to that page. Leave both empty for no button.
                    </p>
                  )}
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
                  <div className={styles.pickerFilters}>
                    <label className={styles.field} htmlFor={`ctaRouteSearch-${field.id}`}>
                      <span className={styles.label}>Search CTA routes</span>
                      <input
                        id={`ctaRouteSearch-${field.id}`}
                        type="search"
                        className={styles.input}
                        placeholder="Route name or path…"
                        value={ctaRouteSearchByStepId[field.id] ?? ''}
                        onChange={(event) =>
                          setCtaRouteSearchByStepId((previous) => ({
                            ...previous,
                            [field.id]: event.target.value,
                          }))
                        }
                        {...{ 'data-testid': `walkthrough-step-cta-route-search-${field.id}` }}
                      />
                    </label>
                  </div>
                  <div className={styles.field}>
                    <label className={styles.label} htmlFor={`ctaRoute-${field.id}`}>CTA route</label>
                    <select
                      id={`ctaRoute-${field.id}`}
                      className={styles.selectFull}
                      {...register(`steps.${index}.ctaRoute`)}
                      {...{ 'data-testid': `walkthrough-step-cta-route-${field.id}` }}
                    >
                      <option value="">No CTA link</option>
                      {visibleCtaRoutes.map((entry) => (
                        <option key={entry.route} value={entry.route}>
                          {entry.label} ({entry.route})
                        </option>
                      ))}
                    </select>
                    {matchingCtaRoutes.length === 0 && !selectedCtaRoute ? (
                      <p className={styles.pickerEmpty}>No CTA routes match this search.</p>
                    ) : null}
                    {stepErrors?.ctaRoute && <p className={styles.fieldError}>{stepErrors.ctaRoute.message}</p>}
                  </div>
                </div>

                <div className={styles.subsection}>
                  <h4 className={styles.subsectionTitle}>Coachmark target</h4>
                  <p className={styles.fieldHint}>
                    Pin this step to an approved UI element, or leave the anchor empty for a centered modal step.
                  </p>
                  <div className={styles.pickerFilters}>
                    <label className={styles.field} htmlFor={`anchorRouteFilter-${field.id}`}>
                      <span className={styles.label}>Filter anchors by route</span>
                      <select
                        id={`anchorRouteFilter-${field.id}`}
                        className={styles.select}
                        value={anchorRouteFilter}
                        onChange={(event) =>
                          setAnchorRouteFilterByStepId((previous) => ({
                            ...previous,
                            [field.id]: event.target.value,
                          }))
                        }
                        {...{
                          'data-testid': `walkthrough-anchor-route-filter-${field.id}`,
                        }}
                      >
                        <option value="">All routes</option>
                        {anchorRouteOptions.map((route) => {
                          const routeEntry = walkthroughRoutes.find(
                            (entry) => entry.route === route,
                          );
                          return (
                            <option key={route} value={route}>
                              {routeEntry?.label ?? route} ({route})
                            </option>
                          );
                        })}
                      </select>
                    </label>
                    <label className={styles.field} htmlFor={`anchorSearch-${field.id}`}>
                      <span className={styles.label}>Search anchors</span>
                      <input
                        id={`anchorSearch-${field.id}`}
                        type="search"
                        className={styles.input}
                        placeholder="Label, key, test ID, or tag…"
                        value={anchorSearchByStepId[field.id] ?? ''}
                        onChange={(event) =>
                          setAnchorSearchByStepId((previous) => ({
                            ...previous,
                            [field.id]: event.target.value,
                          }))
                        }
                        {...{ 'data-testid': `walkthrough-anchor-search-${field.id}` }}
                      />
                    </label>
                  </div>
                  <div className={styles.field}>
                    <label className={styles.label} htmlFor={`anchorKey-${field.id}`}>Anchor</label>
                    <select
                      id={`anchorKey-${field.id}`}
                      className={styles.selectFull}
                      value={step?.anchorKey ?? ''}
                      {...{ 'data-testid': `walkthrough-anchor-key-${field.id}` }}
                      onChange={(event) => handleAnchorKeyChange(index, event.target.value, anchors)}
                    >
                      <option value="">No anchor (centered)</option>
                      {visibleAnchors.map((anchor) => (
                        <option key={anchor.key} value={anchor.key} title={`${anchor.label} (${anchor.key})`}>
                          {anchor.label} ({anchor.key})
                        </option>
                      ))}
                    </select>
                    {matchingAnchors.length === 0 && !selectedAnchor ? (
                      <p className={styles.pickerEmpty}>No approved anchors match these filters.</p>
                    ) : null}
                  </div>
                  {step?.anchorKey ? (
                    <div className={styles.anchorDetails}>
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
                      <div className={styles.field}>
                        <label className={styles.label} htmlFor={`anchorRoute-${field.id}`}>Anchor route</label>
                        <input
                          id={`anchorRoute-${field.id}`}
                          className={styles.inputReadonly}
                          readOnly
                          {...register(`steps.${index}.anchorTargetRoute`)}
                          {...{ 'data-testid': `walkthrough-anchor-route-${field.id}` }}
                        />
                      </div>
                    </div>
                  ) : null}
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

      {aiStepOpen && (
        // data-testid-exempt — AiStepBuilderModal root already sets data-testid
        <AiStepBuilderModal
          projectId={watchedProjects[0] ?? ''}
          stepCount={fields.length}
          existingDraft={{
            internalName: watch('internalName') || '',
            userTitle: watch('userTitle') || '',
            whyItMatters: watch('whyItMatters') || '',
            steps: (watchedSteps ?? []).map((step, index) => ({
              id: step.id,
              ordinal: index,
              heading: step.heading || '',
              bodyMarkdown: step.bodyMarkdown || '',
              route: step.route ?? step.anchorTargetRoute ?? null,
              imageUrl: step.imageUrl ?? null,
              imageAlt: step.imageAlt ?? null,
              ctaLabel: step.ctaLabel ?? null,
              ctaRoute: step.ctaRoute ?? null,
              anchor:
                step.anchorKey && step.anchorTargetRoute && step.anchorPlacement
                  ? {
                      key: step.anchorKey,
                      targetRoute: step.anchorTargetRoute,
                      placement: step.anchorPlacement as NonNullable<
                        WalkthroughStepInput['anchor']
                      >['placement'],
                    }
                  : null,
            })),
          }}
          onInsert={handleAiInsertStep}
          onClose={() => setAiStepOpen(false)}
        />
      )}
    </div>
  );
};
