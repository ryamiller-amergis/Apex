import React, { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { skillNameFromPath } from '../../shared/skillPaths';
import type { CloudAgentSkillChoice } from '../../shared/types/devWorkbench';
import styles from './CloudAgentLaunchDialog.module.css';

const schema = z.object({
  skillPath: z.string().min(1, 'Choose a skill'),
  model: z.string().min(1, 'Choose a model'),
  task: z.string(),
});

type LaunchFormValues = z.infer<typeof schema>;

interface CloudAgentLaunchDialogProps {
  title: string;
  reason: string;
  skills: CloudAgentSkillChoice[];
  models: { id: string; displayName: string }[];
  defaultSkillPath: string;
  defaultModel: string;
  requireTask: boolean;
  loading: boolean;
  loadError: string | null;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (value: { skillPath: string; model: string; task: string }) => void;
}

export const CloudAgentLaunchDialog: React.FC<CloudAgentLaunchDialogProps> = ({
  title,
  reason,
  skills,
  models,
  defaultSkillPath,
  defaultModel,
  requireTask,
  loading,
  loadError,
  pending,
  error,
  onClose,
  onConfirm,
}) => {
  const skillChoices = skills.some((skill) => skill.path === defaultSkillPath) || !defaultSkillPath
    ? skills
    : [
      {
        name: skillNameFromPath(defaultSkillPath) ?? 'Development skill',
        path: defaultSkillPath,
        description: '',
      },
      ...skills,
    ];
  const modelChoices = models.some((model) => model.id === defaultModel) || !defaultModel
    ? models
    : [{ id: defaultModel, displayName: defaultModel }, ...models];

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors },
  } = useForm<LaunchFormValues>({
    resolver: zodResolver(schema),
    defaultValues: { skillPath: defaultSkillPath, model: defaultModel, task: '' },
  });

  useEffect(() => {
    reset({ skillPath: defaultSkillPath, model: defaultModel, task: '' });
  }, [defaultModel, defaultSkillPath, reset]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = handleSubmit((values) => {
    if (requireTask && !values.task.trim()) {
      setError('task', { message: 'Describe the task' });
      return;
    }
    onConfirm({
      skillPath: values.skillPath,
      model: values.model,
      task: values.task.trim(),
    });
  });

  return (
    <div
      className={styles.overlay}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cloud-agent-launch-title"
        data-testid="cloud-agent-launch-dialog"
      >
        <div className={styles.header}>
          <h2 id="cloud-agent-launch-title" className={styles.title}>{title}</h2>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        <form className={styles.body} onSubmit={submit}>
          {loading ? <p className={styles.reason}>Loading skills…</p> : null}
          {loadError ? <p className={styles.error} role="alert">{loadError}</p> : null}
          {reason ? <p className={styles.reason}>{reason}</p> : null}
          <label className={styles.field}>
            <span className={styles.label}>Skill</span>
            <select
              className={styles.select}
              {...register('skillPath')}
              data-testid="cloud-agent-launch-skill"
            >
              {skillChoices.map((skill) => (
                <option key={skill.path} value={skill.path}>
                  {skill.name}
                </option>
              ))}
            </select>
            {errors.skillPath ? <span className={styles.error}>{errors.skillPath.message}</span> : null}
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Model</span>
            <select
              className={styles.select}
              {...register('model')}
              data-testid="cloud-agent-launch-model"
            >
              {modelChoices.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.displayName}
                </option>
              ))}
            </select>
            {errors.model ? <span className={styles.error}>{errors.model.message}</span> : null}
          </label>
          {requireTask ? (
            <label className={styles.field}>
              <span className={styles.label}>Task</span>
              <textarea
                className={styles.textarea}
                rows={5}
                {...register('task')}
                data-testid="cloud-agent-launch-task"
              />
              {errors.task ? <span className={styles.error}>{errors.task.message}</span> : null}
            </label>
          ) : null}
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
          <div className={styles.actions}>
            <button type="button" className={styles.secondary} onClick={onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className={styles.primary}
              disabled={pending || loading || Boolean(loadError)}
              data-testid="cloud-agent-launch-confirm"
            >
              {pending ? 'Starting…' : 'Launch'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
