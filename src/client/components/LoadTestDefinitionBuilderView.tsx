import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm, useWatch, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useAppShell } from '../hooks/useAppShell';
import {
  LoadTestApiError,
  useCreateLoadTest,
  useDeleteLoadTest,
  useLoadTest,
  useUpdateLoadTest,
} from '../hooks/useLoadTests';
import {
  LoadTestRunApiError,
  useEnqueueRun,
} from '../hooks/useLoadTestRuns';
import { useLoadTestTargets } from '../hooks/useLoadTestTargets';
import { useProjectRepoConfigs } from '../hooks/useProjectRepoConfigs';
import {
  defaultLoadTestBuilderValues,
  loadTestBuilderFormSchema,
  type LoadTestBuilderFormValues,
} from '../utils/loadTestBuilderSchema';
import {
  compileGuidedFormToK6,
  flowStepsToGuidedForm,
  needsConfirmBeforeRegenerate,
  toFlowSteps,
} from '../utils/loadTestScriptCompile';
import type {
  CreateLoadTestDefinitionInput,
  LoadTestDefinition,
  LoadTestScriptSource,
} from '../../shared/types/loadTest';
import type { LoadTestAiGenerateResult } from '../../shared/types/loadTestAi';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import { ConfirmRegenerateScriptModal } from './ConfirmRegenerateScriptModal';
import { LoadTestAiGeneratePanel } from './LoadTestAiGeneratePanel';
import { LoadTestBuilderModeTabs, type BuilderMode } from './LoadTestBuilderModeTabs';
import { LoadTestDefinitionRunsPanel } from './LoadTestDefinitionRunsPanel';
import { LoadTestGuidedForm } from './LoadTestGuidedForm';
import { LoadTestRawScriptEditor } from './LoadTestRawScriptEditor';
import styles from './LoadTestDefinitionBuilderView.module.css';

export type LoadTestDefinitionSection = 'definition' | 'runs';

interface LoadTestDefinitionBuilderViewProps {
  project: string;
  definitionId?: string | null;
  /** Which top-level section to show for an existing definition. Defaults to definition. */
  section?: LoadTestDefinitionSection;
}

function definitionToFormValues(def: LoadTestDefinition): LoadTestBuilderFormValues {
  const secretEntries = Object.entries(def.secretRefs ?? {});
  const restoredSteps =
    def.flowSteps && def.flowSteps.length > 0
      ? flowStepsToGuidedForm(def.flowSteps)
      : [{ method: 'GET', path: '/health', extractions: [] }];
  return {
    ...defaultLoadTestBuilderValues,
    name: def.name,
    description: def.description ?? '',
    targetId: '', // resolved after targets load via URL match
    flowType: def.flowType,
    steps: restoredSteps,
    loadProfile: {
      vus: def.loadProfile.vus,
      durationMinutes: def.loadProfile.durationMinutes,
      rpsCap: def.loadProfile.rpsCap,
    },
    clientThresholds:
      def.clientThresholds.length > 0
        ? def.clientThresholds
        : defaultLoadTestBuilderValues.clientThresholds,
    secretRefKey: secretEntries[0]?.[0] ?? '',
    secretRefValue: secretEntries[0]?.[1] ?? '',
    script: def.script,
    mode: def.scriptSource === 'raw' ? 'raw' : 'guided',
  };
}

export const LoadTestDefinitionBuilderView: React.FC<LoadTestDefinitionBuilderViewProps> = ({
  project,
  definitionId = null,
  section = 'definition',
}) => {
  const navigate = useNavigate();
  const { can } = useAppShell();
  const canManage = can('load-test:manage');
  const canRun = can('load-test:run');
  const readOnly = !canManage;

  const isNew = !definitionId;
  const activeSection: LoadTestDefinitionSection =
    !isNew && section === 'runs' ? 'runs' : 'definition';
  const { data: definition, isLoading: defLoading } = useLoadTest(project, definitionId);
  const { data: targets = [], isLoading: targetsLoading } = useLoadTestTargets(project);
  const { data: repoConfigs = [] } = useProjectRepoConfigs(project);

  // AC-2: AI generate is only available once the project has at least one connected repo.
  const hasConnectedRepo = repoConfigs.some((config) => Boolean(config.skillRepo?.trim()));

  const [mode, setMode] = useState<BuilderMode>('guided');
  const [scriptSource, setScriptSource] = useState<LoadTestScriptSource>('form_builder');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showRegenerateConfirm, setShowRegenerateConfirm] = useState(false);
  const [pendingMode, setPendingMode] = useState<BuilderMode | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  // Track which definition we've hydrated local UI state from. Adjust during
  // render (React-recommended) instead of setState-in-effect.
  const [hydratedDefinitionId, setHydratedDefinitionId] = useState<string | null | undefined>(
    undefined,
  );
  const loadedDefinitionId = definition?.id ?? null;

  if (hydratedDefinitionId !== loadedDefinitionId) {
    setHydratedDefinitionId(loadedDefinitionId);
    if (definition) {
      const values = definitionToFormValues(definition);
      setMode(values.mode);
      setScriptSource(definition.scriptSource);
    } else {
      setMode('guided');
      setScriptSource('form_builder');
    }
  }

  const createMutation = useCreateLoadTest(project);
  const updateMutation = useUpdateLoadTest(project);
  const deleteMutation = useDeleteLoadTest(project);
  const enqueueMutation = useEnqueueRun(project);

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    control,
    getValues,
    formState: { errors, isDirty },
  } = useForm<LoadTestBuilderFormValues>({
    resolver: zodResolver(loadTestBuilderFormSchema) as Resolver<LoadTestBuilderFormValues>,
    defaultValues: defaultLoadTestBuilderValues,
  });

  const scriptValue = useWatch({ control, name: 'script' }) ?? '';

  useEffect(() => {
    if (!definition) return;
    const values = definitionToFormValues(definition);
    const matched = targets.find(
      (t) => t.baseUrl === definition.targetUrl && t.environmentLabel === definition.environment,
    );
    if (matched) values.targetId = matched.id;
    reset(values);
  }, [definition, targets, reset]);

  const applyGuidedCompileToScript = () => {
    const values = getValues();
    const compiled = compileGuidedFormToK6({
      flowType: values.flowType,
      steps: values.steps,
      loadProfile: values.loadProfile,
      clientThresholds: values.clientThresholds,
    });
    setValue('script', compiled.script, { shouldDirty: true });
    setScriptSource('form_builder');
  };

  const requestModeChange = (next: BuilderMode) => {
    if (next === 'guided' && mode === 'raw' && needsConfirmBeforeRegenerate(scriptSource)) {
      setPendingMode(next);
      setShowRegenerateConfirm(true);
      return;
    }
    setMode(next);
    // Authoring-tab switches are not definition edits — don't block Run.
    setValue('mode', next, { shouldDirty: false });
  };

  const confirmRegenerate = () => {
    applyGuidedCompileToScript();
    if (pendingMode) {
      setMode(pendingMode);
      setValue('mode', pendingMode, { shouldDirty: false });
    }
    setPendingMode(null);
    setShowRegenerateConfirm(false);
  };

  // FEAT-011 / PBI-014 AC-0, BR-005 — apply an AI-generated result into shared form
  // state. Never auto-saves or auto-enqueues; the author reviews before Save.
  const handleAiApply = (result: LoadTestAiGenerateResult) => {
    setValue('script', result.script, { shouldDirty: true });
    setValue(
      'clientThresholds',
      result.suggested_thresholds.length > 0
        ? result.suggested_thresholds
        : defaultLoadTestBuilderValues.clientThresholds,
      { shouldDirty: true },
    );
    setScriptSource('ai_generated');
  };

  const buildPayload = (values: LoadTestBuilderFormValues): CreateLoadTestDefinitionInput => {
    const target = targets.find((t) => t.id === values.targetId);
    if (!target) {
      throw new Error('Select an allowlisted target');
    }

    let script = values.script ?? '';
    let nextSource: LoadTestScriptSource = scriptSource;
    const flowType = values.flowType;
    let loadProfile = values.loadProfile;
    let clientThresholds = values.clientThresholds;

    if (mode === 'guided' || (mode === 'raw' && scriptSource !== 'raw' && !script.trim())) {
      const compiled = compileGuidedFormToK6({
        flowType: values.flowType,
        steps: values.steps,
        loadProfile: values.loadProfile,
        clientThresholds: values.clientThresholds,
      });
      script = compiled.script;
      loadProfile = compiled.loadProfile;
      clientThresholds = compiled.clientThresholds;
      nextSource = 'form_builder';
    } else if (mode === 'raw') {
      nextSource = 'raw';
    } else if (mode === 'ai' && !script.trim()) {
      // No AI result generated yet — fall back to the compiled guided script rather
      // than persisting blank content (out of scope: auto-enqueue after generation).
      const compiled = compileGuidedFormToK6({
        flowType: values.flowType,
        steps: values.steps,
        loadProfile: values.loadProfile,
        clientThresholds: values.clientThresholds,
      });
      script = compiled.script;
      loadProfile = compiled.loadProfile;
      clientThresholds = compiled.clientThresholds;
      nextSource = 'form_builder';
    } else if (mode === 'ai') {
      nextSource = 'ai_generated';
    }

    const secretRefs =
      values.secretRefKey?.trim() && values.secretRefValue?.trim()
        ? { [values.secretRefKey.trim()]: values.secretRefValue.trim() }
        : null;

    return {
      name: values.name.trim(),
      description: values.description?.trim() || null,
      targetUrl: target.baseUrl,
      environment: target.environmentLabel,
      engine: 'k6',
      flowType,
      scriptSource: nextSource,
      script,
      loadProfile,
      clientThresholds,
      flowSteps:
        nextSource === 'form_builder' || mode === 'guided'
          ? toFlowSteps(values.steps)
          : null,
      secretRefs,
    };
  };

  const onSave = handleSubmit(
    async (values) => {
      if (readOnly) return;
      setSaveError(null);
      try {
        const payload = buildPayload({ ...values, mode });
        if (isNew) {
          const created = await createMutation.mutateAsync(payload);
          navigate(`/load-tests/${created.id}`);
        } else if (definitionId) {
          await updateMutation.mutateAsync({ id: definitionId, input: payload });
          const nextSource = payload.scriptSource ?? scriptSource;
          setScriptSource(nextSource);
          // Clear dirty immediately — do not wait on query invalidate/refetch,
          // which can leave Run disabled with no toast after a successful save.
          reset({
            ...values,
            name: payload.name,
            description: payload.description ?? '',
            script: payload.script,
            loadProfile: payload.loadProfile,
            clientThresholds: payload.clientThresholds,
            mode,
          });
        }
      } catch (err) {
        const message =
          err instanceof LoadTestApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Failed to save load test';
        setSaveError(message);
        // Keep dirty form editable — do not reset
      }
    },
    (formErrors) => {
      const first =
        formErrors.targetId?.message ??
        formErrors.name?.message ??
        formErrors.script?.message ??
        formErrors.loadProfile?.vus?.message ??
        formErrors.loadProfile?.durationMinutes?.message ??
        formErrors.clientThresholds?.message ??
        formErrors.secretRefValue?.message ??
        formErrors.steps?.message ??
        'Fix the highlighted fields before saving';
      setSaveError(String(first));
    },
  );

  const onDelete = async () => {
    if (!definitionId || readOnly) return;
    try {
      await deleteMutation.mutateAsync(definitionId);
      navigate('/load-tests');
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to delete');
      setShowDeleteConfirm(false);
    }
  };

  const onRun = async () => {
    if (!definitionId || !canRun || isDirty) return;
    setSaveError(null);
    try {
      const run = await enqueueMutation.mutateAsync({ definitionId });
      navigate(`/load-tests/runs/${run.id}`);
    } catch (err) {
      const message =
        err instanceof LoadTestRunApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Failed to start load test run';
      setSaveError(message);
    }
  };

  if (!isNew && defLoading) {
    return (
      <div className={styles.page} data-testid="load-test-builder">
        <div className={styles.skeleton} aria-busy="true" />
      </div>
    );
  }

  return (
    <div className={styles.page} data-testid="load-test-builder">
      <div className={styles.header}>
        <div>
          <button type="button" className={styles.backBtn} onClick={() => navigate('/load-tests')}>
            ← Back to list
          </button>
          <h1 className={styles.title}>{isNew ? 'New load test' : definition?.name ?? 'Load test'}</h1>
        </div>
        <div className={styles.actions}>
          {canManage && !isNew && (
            <button
              type="button"
              className={styles.deleteBtn}
              data-testid="load-test-delete-btn"
              onClick={() => setShowDeleteConfirm(true)}
            >
              Delete
            </button>
          )}
          {canRun && !isNew && (
            <button
              type="button"
              className={styles.runBtn}
              data-testid="load-test-run-btn"
              onClick={onRun}
              disabled={isDirty || enqueueMutation.isPending}
              title={isDirty ? 'Save changes before running' : undefined}
            >
              {enqueueMutation.isPending ? 'Starting…' : 'Run'}
            </button>
          )}
          {canManage && activeSection === 'definition' && (
            <button
              type="button"
              className={styles.saveBtn}
              data-testid="load-test-save-btn"
              onClick={onSave}
              disabled={createMutation.isPending || updateMutation.isPending}
            >
              {createMutation.isPending || updateMutation.isPending ? 'Saving…' : 'Save'}
            </button>
          )}
        </div>
      </div>

      {!isNew && (
        <div
          className={styles.sectionTabs}
          role="tablist"
          aria-label="Load test sections"
          data-testid="load-test-section-tabs"
        >
          <button
            type="button"
            role="tab"
            id="load-test-section-definition"
            aria-selected={activeSection === 'definition'}
            className={`${styles.sectionTab} ${activeSection === 'definition' ? styles.sectionTabActive : ''}`}
            data-testid="load-test-section-definition"
            onClick={() => navigate(`/load-tests/${definitionId}`)}
          >
            Definition
          </button>
          <button
            type="button"
            role="tab"
            id="load-test-section-runs"
            aria-selected={activeSection === 'runs'}
            className={`${styles.sectionTab} ${activeSection === 'runs' ? styles.sectionTabActive : ''}`}
            data-testid="load-test-section-runs"
            onClick={() => navigate(`/load-tests/${definitionId}/runs`)}
          >
            Runs
          </button>
        </div>
      )}

      {readOnly && (
        <div
          className={styles.readonlyBanner}
          data-testid="load-test-builder-readonly-banner"
          role="status"
        >
          You have view-only access. Save and run-manage actions are unavailable.
        </div>
      )}

      {saveError && (
        <div className={styles.errorToast} role="alert" data-testid="load-test-builder-error-toast">
          {saveError}
        </div>
      )}

      {activeSection === 'runs' && definitionId ? (
        <LoadTestDefinitionRunsPanel project={project} definitionId={definitionId} />
      ) : (
        <>
      <LoadTestBuilderModeTabs
        mode={mode}
        disabled={readOnly}
        aiDisabled={readOnly}
        aiDisabledReason="You have view-only access. Save and run-manage actions are unavailable."
        onChange={requestModeChange}
      />

      <div id="load-test-mode-panel" role="tabpanel">
        {mode === 'guided' && (
          <>
            <LoadTestGuidedForm
              register={register}
              errors={errors}
              setValue={setValue}
              watch={watch}
              targets={targets}
              targetsLoading={targetsLoading}
              readOnly={readOnly}
            />
            {canManage && scriptSource === 'raw' && (
              <button
                type="button"
                className={styles.secondaryBtn}
                onClick={() => {
                  if (needsConfirmBeforeRegenerate(scriptSource)) {
                    setPendingMode('guided');
                    setShowRegenerateConfirm(true);
                  } else {
                    applyGuidedCompileToScript();
                  }
                }}
              >
                Re-apply guided form to script
              </button>
            )}
          </>
        )}

        {mode === 'raw' && (
          <LoadTestRawScriptEditor
            value={scriptValue}
            readOnly={readOnly}
            error={errors.script?.message}
            onChange={(next) => {
              setValue('script', next, { shouldDirty: true });
              setScriptSource('raw');
              setValue('mode', 'raw');
            }}
          />
        )}

        {mode === 'ai' && (
          <LoadTestAiGeneratePanel
            project={project}
            connected={hasConnectedRepo}
            canManage={canManage}
            needsConfirm={needsConfirmBeforeRegenerate(scriptSource)}
            onApply={handleAiApply}
          />
        )}
      </div>

      {isDirty && canManage && activeSection === 'definition' && (
        <p className={styles.dirtyHint} aria-live="polite" data-testid="load-test-dirty-hint">
          Unsaved changes — save before running
        </p>
      )}

      {showRegenerateConfirm && (
        <ConfirmRegenerateScriptModal
          onCancel={() => {
            setShowRegenerateConfirm(false);
            setPendingMode(null);
          }}
          onConfirm={confirmRegenerate}
        />
      )}
        </>
      )}

      {showDeleteConfirm && definition && (
        <ConfirmDeleteModal
          title="Delete load test"
          itemName={definition.name}
          isPending={deleteMutation.isPending}
          onCancel={() => setShowDeleteConfirm(false)}
          onConfirm={onDelete}
        />
      )}
    </div>
  );
};

export default LoadTestDefinitionBuilderView;
