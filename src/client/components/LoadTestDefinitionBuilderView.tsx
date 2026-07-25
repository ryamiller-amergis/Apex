import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useAppShell } from '../hooks/useAppShell';
import {
  LoadTestApiError,
  useCreateLoadTest,
  useDeleteLoadTest,
  useLoadTest,
  useUpdateLoadTest,
} from '../hooks/useLoadTests';
import { useLoadTestTargets } from '../hooks/useLoadTestTargets';
import {
  defaultLoadTestBuilderValues,
  loadTestBuilderFormSchema,
  type LoadTestBuilderFormValues,
} from '../utils/loadTestBuilderSchema';
import {
  compileGuidedFormToK6,
  needsConfirmBeforeRegenerate,
} from '../utils/loadTestScriptCompile';
import type {
  CreateLoadTestDefinitionInput,
  LoadTestDefinition,
  LoadTestScriptSource,
} from '../../shared/types/loadTest';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import { ConfirmRegenerateScriptModal } from './ConfirmRegenerateScriptModal';
import { LoadTestAiModePlaceholder } from './LoadTestAiModePlaceholder';
import { LoadTestBuilderModeTabs, type BuilderMode } from './LoadTestBuilderModeTabs';
import { LoadTestGuidedForm } from './LoadTestGuidedForm';
import { LoadTestRawScriptEditor } from './LoadTestRawScriptEditor';
import styles from './LoadTestDefinitionBuilderView.module.css';

interface LoadTestDefinitionBuilderViewProps {
  project: string;
  definitionId?: string | null;
}

function definitionToFormValues(def: LoadTestDefinition): LoadTestBuilderFormValues {
  const secretEntries = Object.entries(def.secretRefs ?? {});
  return {
    ...defaultLoadTestBuilderValues,
    name: def.name,
    description: def.description ?? '',
    requirementId: def.requirementRef?.id ?? '',
    requirementLabel: def.requirementRef?.displayLabel ?? '',
    targetId: '', // resolved after targets load via URL match
    flowType: def.flowType,
    steps:
      def.flowType === 'multi_step'
        ? [{ method: 'GET', path: '/', extractions: [] }]
        : [{ method: 'GET', path: '/', extractions: [] }],
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
}) => {
  const navigate = useNavigate();
  const { can } = useAppShell();
  const canManage = can('load-test:manage');
  const readOnly = !canManage;

  const isNew = !definitionId;
  const { data: definition, isLoading: defLoading } = useLoadTest(project, definitionId);
  const { data: targets = [], isLoading: targetsLoading } = useLoadTestTargets(project);
  const createMutation = useCreateLoadTest(project);
  const updateMutation = useUpdateLoadTest(project);
  const deleteMutation = useDeleteLoadTest(project);

  const [mode, setMode] = useState<BuilderMode>('guided');
  const [scriptSource, setScriptSource] = useState<LoadTestScriptSource>('form_builder');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [showRegenerateConfirm, setShowRegenerateConfirm] = useState(false);
  const [pendingMode, setPendingMode] = useState<BuilderMode | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [aiNotice, setAiNotice] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    getValues,
    formState: { errors, isDirty },
  } = useForm<LoadTestBuilderFormValues>({
    resolver: zodResolver(loadTestBuilderFormSchema) as Resolver<LoadTestBuilderFormValues>,
    defaultValues: defaultLoadTestBuilderValues,
  });

  const scriptValue = watch('script') ?? '';

  useEffect(() => {
    if (!definition) return;
    const values = definitionToFormValues(definition);
    const matched = targets.find(
      (t) => t.baseUrl === definition.targetUrl && t.environmentLabel === definition.environment,
    );
    if (matched) values.targetId = matched.id;
    reset(values);
    setMode(values.mode);
    setScriptSource(definition.scriptSource);
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
    if (next === 'ai') {
      setAiNotice(true);
      return;
    }
    if (next === 'guided' && mode === 'raw' && needsConfirmBeforeRegenerate(scriptSource)) {
      setPendingMode(next);
      setShowRegenerateConfirm(true);
      return;
    }
    setMode(next);
    setValue('mode', next);
  };

  const confirmRegenerate = () => {
    applyGuidedCompileToScript();
    if (pendingMode) {
      setMode(pendingMode);
      setValue('mode', pendingMode);
    }
    setPendingMode(null);
    setShowRegenerateConfirm(false);
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
    }

    const secretRefs =
      values.secretRefKey?.trim() && values.secretRefValue?.trim()
        ? { [values.secretRefKey.trim()]: values.secretRefValue.trim() }
        : null;

    return {
      name: values.name.trim(),
      description: values.description?.trim() || null,
      requirementRef: {
        kind: 'ado_work_item',
        id: values.requirementId.trim(),
        displayLabel: values.requirementLabel?.trim() || undefined,
        projectId: project,
      },
      targetUrl: target.baseUrl,
      environment: target.environmentLabel,
      engine: 'k6',
      flowType,
      scriptSource: nextSource,
      script,
      loadProfile,
      clientThresholds,
      secretRefs,
    };
  };

  const onSave = handleSubmit(async (values) => {
    if (readOnly) return;
    setSaveError(null);
    try {
      const payload = buildPayload({ ...values, mode });
      if (isNew) {
        const created = await createMutation.mutateAsync(payload);
        navigate(`/load-tests/${created.id}`);
      } else if (definitionId) {
        await updateMutation.mutateAsync({ id: definitionId, input: payload });
        setScriptSource(payload.scriptSource ?? scriptSource);
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
  });

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
          {canManage && (
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

      {aiNotice && (
        <div className={styles.infoBanner} role="status">
          AI generate is not available yet. Use Guided or Raw script modes.
        </div>
      )}

      <LoadTestBuilderModeTabs
        mode={mode}
        disabled={readOnly}
        onChange={requestModeChange}
        onAiAttempt={() => setAiNotice(true)}
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

        {mode === 'ai' && <LoadTestAiModePlaceholder />}
      </div>

      {isDirty && canManage && (
        <p className={styles.dirtyHint} aria-live="polite">
          Unsaved changes
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
