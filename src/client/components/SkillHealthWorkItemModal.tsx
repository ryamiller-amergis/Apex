import React, { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import styles from './SkillHealthWorkItemModal.module.css';
import { useCreateSkillHealthWorkItem } from '../hooks/useSkillHealth';
import {
  SKILL_HEALTH_WORK_ITEM_DESCRIPTION_MAX,
  SKILL_HEALTH_WORK_ITEM_TITLE_MAX,
  allowedWorkItemDestinations,
  defaultWorkItemDestination,
  type SkillHealthWorkItemDestination,
  type SkillHealthWorkItemTarget,
} from '../../shared/types/skillHealth';

const workItemSchema = z.object({
  destination: z.enum(['apex-backlog', 'project-ado']),
  title: z.string().trim().min(1, 'A title is required').max(SKILL_HEALTH_WORK_ITEM_TITLE_MAX),
  description: z.string().trim().min(1, 'A description is required').max(SKILL_HEALTH_WORK_ITEM_DESCRIPTION_MAX),
});

type FormValues = z.infer<typeof workItemSchema>;

export function destinationLabel(destination: SkillHealthWorkItemDestination, project: string): string {
  switch (destination) {
    case 'apex-backlog':
      return 'Apex Backlog (foundation Skill)';
    case 'project-ado':
      return `${project} Azure DevOps`;
    default: {
      const unreachable: never = destination;
      return unreachable;
    }
  }
}

interface SkillHealthWorkItemModalProps {
  skill: SkillHealthWorkItemTarget;
  initialTitle: string;
  initialDescription: string;
  onClose: () => void;
}

export const SkillHealthWorkItemModal: React.FC<SkillHealthWorkItemModalProps> = ({
  skill,
  initialTitle,
  initialDescription,
  onClose,
}) => {
  const createWorkItem = useCreateSkillHealthWorkItem();
  const destinations = allowedWorkItemDestinations(skill.project);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(workItemSchema),
    defaultValues: {
      destination: defaultWorkItemDestination(skill.project),
      title: initialTitle,
      description: initialDescription,
    },
  });

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const onSubmit = (values: FormValues) => {
    createWorkItem.mutate({
      project: skill.project,
      destination: values.destination,
      artifactKind: skill.artifactKind,
      skillPath: skill.skillPath,
      title: values.title,
      description: values.description,
    });
  };

  const created = createWorkItem.data;

  return (
    <div
      className={styles.overlay}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="skill-health-work-item-title"
      data-testid="skill-health-work-item-modal"
    >
      {created ? (
        <div className={styles.card}>
          <h2 className={styles.title} id="skill-health-work-item-title">
            Work item created
          </h2>
          {created.url ? (
            <p className={styles.text} data-testid="skill-health-work-item-created">
              Created{' '}
              <a href={created.url} target="_blank" rel="noreferrer" data-testid="skill-health-work-item-link">
                #{created.id}
              </a>{' '}
              in {created.project} Azure DevOps.
            </p>
          ) : (
            <p className={styles.text} data-testid="skill-health-work-item-created">
              Filed to the Apex Backlog.
            </p>
          )}
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.btnConfirm}
              onClick={onClose}
              data-testid="skill-health-work-item-done"
            >
              Done
            </button>
          </div>
        </div>
      ) : (
        <form className={styles.card} onSubmit={handleSubmit(onSubmit)} data-testid="skill-health-work-item-form">
          <h2 className={styles.title} id="skill-health-work-item-title">
            Create work item
          </h2>
          <p className={styles.hint}>
            {skill.project} · {skill.skillPath ?? 'App default Skill'}
          </p>

          <div className={styles.fieldGroup}>
            <label className={styles.label} htmlFor="skill-health-work-item-destination">
              File to
            </label>
            {destinations.length > 1 ? (
              <select
                id="skill-health-work-item-destination"
                className={styles.input}
                data-testid="skill-health-work-item-destination"
                {...register('destination')}
              >
                {destinations.map((destination) => (
                  <option key={destination} value={destination}>
                    {destinationLabel(destination, skill.project)}
                  </option>
                ))}
              </select>
            ) : (
              <span id="skill-health-work-item-destination" className={styles.text}>
                {destinationLabel(destinations[0], skill.project)}
              </span>
            )}
            <span className={styles.hint}>
              Azure DevOps items are created as you. Pick the Apex Backlog when the fix belongs in the shared Skill.
            </span>
          </div>

          <div className={styles.fieldGroup}>
            <label className={styles.label} htmlFor="skill-health-work-item-title-input">
              Title
            </label>
            <input
              id="skill-health-work-item-title-input"
              className={`${styles.input} ${errors.title ? styles.inputError : ''}`}
              data-testid="skill-health-work-item-title"
              {...register('title')}
            />
            {errors.title && <span className={styles.errorMsg}>{errors.title.message}</span>}
          </div>

          <div className={styles.fieldGroup}>
            <label className={styles.label} htmlFor="skill-health-work-item-description">
              Description
            </label>
            <textarea
              id="skill-health-work-item-description"
              className={`${styles.input} ${styles.textarea} ${errors.description ? styles.inputError : ''}`}
              rows={10}
              data-testid="skill-health-work-item-description"
              {...register('description')}
            />
            {errors.description && <span className={styles.errorMsg}>{errors.description.message}</span>}
          </div>

          {createWorkItem.error && (
            <p className={styles.errorMsg} role="alert">
              {createWorkItem.error.message}
            </p>
          )}

          <div className={styles.actions}>
            <button
              type="button"
              className={styles.btnCancel}
              onClick={onClose}
              disabled={createWorkItem.isPending}
              data-testid="skill-health-work-item-cancel"
            >
              Cancel
            </button>
            <button
              type="submit"
              className={styles.btnConfirm}
              disabled={createWorkItem.isPending}
              data-testid="skill-health-work-item-submit"
            >
              {createWorkItem.isPending ? 'Creating…' : 'Create work item'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
};
