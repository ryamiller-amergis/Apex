import React, { useEffect, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { skillNameFromPath } from '../../shared/skillPaths';
import type { CloudAgentSkillChoice } from '../../shared/types/devWorkbench';
import {
  CLOUD_AGENT_CUSTOM_PROMPT_MAX_CHARS,
  SITE_ISSUE_MAX_IMAGE_BYTES,
  SITE_ISSUE_MAX_IMAGES,
  type SiteIssueImage,
  type SiteIssueImageType,
} from '../../shared/utils/cloudAgentLaunch';
import { useDialogFocus } from '../hooks/useDialogFocus';
import styles from './CloudAgentLaunchDialog.module.css';

const schema = z.object({
  skillPath: z.string().min(1, 'Choose a skill'),
  model: z.string().min(1, 'Choose a model'),
  task: z.string(),
  customPrompt: z.string().max(
    CLOUD_AGENT_CUSTOM_PROMPT_MAX_CHARS,
    `Custom prompt must be ${CLOUD_AGENT_CUSTOM_PROMPT_MAX_CHARS} characters or fewer.`,
  ),
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
  taskLabel?: string;
  emptyTaskMessage?: string;
  /** Site reports hide these. My Work still lets a developer change them. */
  chooseSkillAndModel?: boolean;
  /** When the pickers start hidden, shows a link that reveals them. */
  allowChangingSkillAndModel?: boolean;
  defaultTask?: string;
  taskRows?: number;
  /** My Work start and retry. Site reports already collect the task. */
  allowCustomPrompt?: boolean;
  defaultCustomPrompt?: string;
  allowImages?: boolean;
  imageHint?: string;
  loading: boolean;
  loadError: string | null;
  pending: boolean;
  error: string | null;
  onClose: () => void;
  'data-testid'?: string;
  onConfirm: (value: {
    skillPath: string;
    model: string;
    task: string;
    images?: SiteIssueImage[];
    customPrompt?: string;
  }) => void;
}

export const CloudAgentLaunchDialog: React.FC<CloudAgentLaunchDialogProps> = ({
  title,
  reason,
  skills,
  models,
  defaultSkillPath,
  defaultModel,
  requireTask,
  taskLabel = 'Task',
  emptyTaskMessage = 'Describe the task',
  chooseSkillAndModel = true,
  allowChangingSkillAndModel = false,
  defaultTask = '',
  taskRows = 5,
  allowCustomPrompt = false,
  defaultCustomPrompt = '',
  allowImages = false,
  imageHint = 'PNG, JPEG, or WebP. Up to 3 images, 400 KB each.',
  loading,
  loadError,
  pending,
  error,
  onClose,
  onConfirm,
  'data-testid': dataTestId = 'cloud-agent-launch-dialog',
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

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [images, setImages] = useState<SiteIssueImage[]>([]);
  const [imageError, setImageError] = useState<string | null>(null);
  const [showChoices, setShowChoices] = useState(chooseSkillAndModel);
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors },
  } = useForm<LaunchFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      skillPath: defaultSkillPath,
      model: defaultModel,
      task: defaultTask,
      customPrompt: defaultCustomPrompt,
    },
  });

  useEffect(() => {
    reset({
      skillPath: defaultSkillPath,
      model: defaultModel,
      task: defaultTask,
      customPrompt: defaultCustomPrompt,
    });
    setImages([]);
    setImageError(null);
  }, [defaultCustomPrompt, defaultModel, defaultSkillPath, defaultTask, reset]);

  const dialogRef = useDialogFocus<HTMLDivElement>(true, onClose);

  const addImages = async (fileList: FileList | null) => {
    const files = Array.from(fileList ?? []);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (files.length === 0) return;
    const next = [...images];
    let error: string | null = null;
    for (const file of files) {
      if (next.length >= SITE_ISSUE_MAX_IMAGES) {
        error = `Add up to ${SITE_ISSUE_MAX_IMAGES} screenshots.`;
        break;
      }
      const mimeType: SiteIssueImageType | null = file.type === 'image/png' || file.type === 'image/jpeg' || file.type === 'image/webp'
        ? file.type
        : null;
      if (!mimeType) {
        error = 'Screenshots must be PNG, JPEG, or WebP.';
        continue;
      }
      if (file.size > SITE_ISSUE_MAX_IMAGE_BYTES) {
        error = 'Each screenshot must be 400 KB or smaller.';
        continue;
      }
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      next.push({ name: file.name, mimeType, data });
    }
    setImages(next);
    setImageError(error);
  };

  const submit = handleSubmit((values) => {
    if (requireTask && !values.task.trim()) {
      setError('task', { message: emptyTaskMessage });
      return;
    }
    const customPrompt = (values.customPrompt ?? '').trim();
    onConfirm({
      skillPath: values.skillPath,
      model: values.model,
      task: values.task.trim(),
      ...(allowImages ? { images } : {}),
      ...(allowCustomPrompt && customPrompt ? { customPrompt } : {}),
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
        ref={dialogRef}
        className={styles.modal}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cloud-agent-launch-title"
        data-testid={dataTestId}
      >
        <div className={styles.header}>
          <h2 id="cloud-agent-launch-title" className={styles.title}>{title}</h2>
          <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close" data-testid="cloud-agent-launch-close">
            ×
          </button>
        </div>
        <form className={styles.body} onSubmit={submit} data-testid="cloud-agent-launch-form">
          {loading ? <p className={styles.reason}>{showChoices ? 'Loading skills…' : 'Loading…'}</p> : null}
          {loadError ? <p className={styles.error} role="alert">{loadError}</p> : null}
          {reason ? <p className={styles.reason}>{reason}</p> : null}
          {allowCustomPrompt ? (
            <label className={styles.field}>
              <span className={styles.label}>Custom prompt</span>
              <span className={styles.hint}>
                Optional. Added to the agent instructions for this run.
              </span>
              <textarea
                className={styles.textarea}
                rows={4}
                placeholder="Extra instructions for this run"
                {...register('customPrompt')}
                data-testid="cloud-agent-launch-custom-prompt"
              />
              {errors.customPrompt ? <span className={styles.error}>{errors.customPrompt.message}</span> : null}
            </label>
          ) : (
            <input type="hidden" {...register('customPrompt')} data-testid="cloud-agent-launch-custom-prompt-hidden" />
          )}
          {requireTask ? (
            <label className={styles.field}>
              <span className={styles.label}>{taskLabel}</span>
              <textarea
                className={styles.textarea}
                rows={taskRows}
                {...register('task')}
                data-testid="cloud-agent-launch-task"
              />
              {errors.task ? <span className={styles.error}>{errors.task.message}</span> : null}
            </label>
          ) : null}
          {allowImages ? (
            <div className={styles.images}>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                hidden
                data-testid="cloud-agent-launch-images"
                onChange={(event) => { void addImages(event.target.files); }}
              />
              <button
                type="button"
                className={styles.secondary}
                onClick={() => fileInputRef.current?.click()}
                data-testid="cloud-agent-launch-add-file"
              >
                Add file
              </button>
              <p className={styles.reason}>{imageHint}</p>
              {images.length > 0 ? (
                <div className={styles.imageList}>
                  {images.map((image, index) => (
                    <span key={`${image.name}-${index}`} className={styles.imageChip}>
                      <img src={`data:${image.mimeType};base64,${image.data}`} alt="" />
                      <span>{image.name}</span>
                      <button
                        type="button"
                        aria-label={`Remove ${image.name}`}
                        onClick={() => setImages((current) => current.filter((_, itemIndex) => itemIndex !== index))}
                        data-testid={`cloud-agent-launch-remove-image-${index}`}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
              {imageError ? <p className={styles.error} role="alert">{imageError}</p> : null}
            </div>
          ) : null}
          {!showChoices && allowChangingSkillAndModel ? (
            <button
              type="button"
              className={styles.linkButton}
              onClick={() => setShowChoices(true)}
              data-testid="cloud-agent-launch-show-skill"
            >
              Choose a skill and model
            </button>
          ) : null}
          {showChoices ? (
          <>
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
          </>
          ) : (
            <>
              <input type="hidden" {...register('skillPath')} data-testid="cloud-agent-launch-skill-hidden" />
              <input type="hidden" {...register('model')} data-testid="cloud-agent-launch-model-hidden" />
            </>
          )}
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
          <div className={styles.actions}>
            <button type="button" className={styles.secondary} onClick={onClose} data-testid="cloud-agent-launch-cancel">
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
