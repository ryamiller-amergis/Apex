import React, { useState } from 'react';
import type { EffortLevel } from '../../shared/types/effort';
import type { AdminEvaluationModelSource } from '../../shared/types/workflowEvaluationAdmin';
import { useAvailableModels } from '../hooks/useProjectSkillConfig';
import {
  useEvaluationModelSettings,
  useUpdateEvaluationModelSettings,
} from '../hooks/useWorkflowEvaluationsAdmin';
import gridStyles from './DataGrid.module.css';
import styles from './WorkflowEvaluationModelSettings.module.css';

export interface WorkflowEvaluationModelSettingsProps {
  project: string;
}

function sourceText(source: AdminEvaluationModelSource): string {
  switch (source) {
    case 'evaluation':
      return 'set here';
    case 'prd_validation':
      return 'PRD Validation model in Project Settings';
    case 'app_default':
      return 'app default model';
    default: {
      const unhandled: never = source;
      return unhandled;
    }
  }
}

export const WorkflowEvaluationModelSettings: React.FC<WorkflowEvaluationModelSettingsProps> = ({ project }) => {
  const settingsQuery = useEvaluationModelSettings(project);
  const modelsQuery = useAvailableModels();
  const update = useUpdateEvaluationModelSettings(project);
  const settings = settingsQuery.data;
  const [draftModel, setDraftModel] = useState<string | null>(null);
  const [draftEffort, setDraftEffort] = useState<EffortLevel | '' | null>(null);

  if (settingsQuery.isLoading) {
    return <p className={gridStyles.loading}>Loading evaluation model…</p>;
  }
  if (settingsQuery.isError || !settings) {
    return (
      <p className={gridStyles.error} role="alert">
        Could not load the evaluation model{settingsQuery.error ? `: ${settingsQuery.error.message}` : ''}.
      </p>
    );
  }

  const models = modelsQuery.data ?? [];
  const modelName = (id: string) => models.find((m) => m.id === id)?.displayName || id;
  const model = draftModel ?? settings.model ?? '';
  const effort = draftEffort ?? settings.effort ?? '';
  const dirty = model !== (settings.model ?? '') || effort !== (settings.effort ?? '');
  const disabled = !settings.hasSkillConfig || update.isPending;

  const onSave = () => {
    update.mutate(
      { model: model || null, effort: effort || null },
      {
        onSuccess: () => {
          setDraftModel(null);
          setDraftEffort(null);
        },
      },
    );
  };

  return (
    <div className={styles.panel} {...{ 'data-testid': 'workflow-evaluation-model-settings' }}>
      <div className={styles.text}>
        <h3 className={styles.title}>Evaluation model</h3>
        <p className={gridStyles.hint}>
          Every judge that reviews Quality feedback in this project uses this model.
          Leave it empty to use the PRD Validation model.
        </p>
        {!settings.hasSkillConfig && (
          <p className={styles.note} {...{ 'data-testid': 'workflow-evaluation-model-no-config' }}>
            Add a default skill configuration in Project Settings before choosing a model.
          </p>
        )}
        {settings.effective && (
          <p className={styles.note} {...{ 'data-testid': 'workflow-evaluation-model-effective' }}>
            Judges now use {modelName(settings.effective.model)}
            {settings.effective.effort ? ` at ${settings.effective.effort} effort` : ''}
            {' '}({sourceText(settings.effective.source)}).
          </p>
        )}
      </div>
      <div className={styles.controls}>
        <label className={styles.field}>
          <span className={styles.label}>Model</span>
          <select
            className={styles.select}
            value={model}
            onChange={(e) => setDraftModel(e.target.value)}
            disabled={disabled || modelsQuery.isLoading}
            {...{ 'data-testid': 'workflow-evaluation-model-select' }}
          >
            <option value="">Use PRD Validation model</option>
            {settings.model && !models.some((m) => m.id === settings.model) && (
              <option value={settings.model}>{settings.model}</option>
            )}
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.displayName || m.id}</option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Effort</span>
          <select
            className={styles.select}
            value={effort}
            onChange={(e) => setDraftEffort(e.target.value as EffortLevel | '')}
            disabled={disabled}
            {...{ 'data-testid': 'workflow-evaluation-effort-select' }}
          >
            <option value="">Use PRD Validation effort</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </label>
        <button
          type="button"
          className={`${gridStyles.button} ${gridStyles.buttonPrimary}`}
          onClick={onSave}
          disabled={disabled || !dirty}
          {...{ 'data-testid': 'workflow-evaluation-model-save' }}
        >
          {update.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
      {update.isError && (
        <p className={gridStyles.error} role="alert">Could not save: {update.error.message}</p>
      )}
    </div>
  );
};
