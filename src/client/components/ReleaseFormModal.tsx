import React, { useMemo, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import { useProjectAreaPaths } from '../hooks/useProjects';
import { deriveReleasePlatform } from '../../shared/utils/releasePlatform';
import styles from './ReleaseFormModal.module.css';

const schema = z.object({
  version: z.string().trim().min(1, 'Release name is required'),
  areaPath: z.string().optional(),
  startDate: z.string().min(1, 'Start date is required'),
  targetDate: z.string().min(1, 'Target date is required'),
  description: z.string().trim().min(1, 'Description is required'),
  status: z.string().min(1),
});

export type ReleaseFormValues = z.infer<typeof schema>;

interface ReleaseFormModalProps {
  isEditMode: boolean;
  project?: string;
  currentAreaPath?: string;
  defaultValues?: Partial<ReleaseFormValues>;
  submitError?: string | null;
  isSubmitting?: boolean;
  onSubmit: (values: ReleaseFormValues) => void | Promise<void>;
  onClose: () => void;
  'data-testid'?: string;
}

export const ReleaseFormModal: React.FC<ReleaseFormModalProps> = ({
  isEditMode,
  project = '',
  currentAreaPath = '',
  defaultValues,
  submitError = null,
  isSubmitting = false,
  onSubmit,
  onClose,
  'data-testid': dataTestId = 'release-form-modal',
}) => {
  const { data: projectAreaPaths = [], isLoading: loadingAreaPaths } = useProjectAreaPaths(
    !isEditMode && project ? project : null,
  );

  const areaPathOptions = useMemo(() => {
    const unique = new Set<string>();
    for (const p of projectAreaPaths) {
      if (p.trim()) unique.add(p.trim());
    }
    if (currentAreaPath.trim()) {
      unique.add(currentAreaPath.trim());
    }
    const all = [...unique];
    const normalizedCurrent = currentAreaPath.trim().toLowerCase();
    // If currentAreaPath is a parent that has child paths, prioritize it and its descendants;
    // if scoped to a leaf (e.g. MaxView\Mobile), still allow picking any project area path.
    const childrenOfCurrent = all.filter((p) => p.toLowerCase().startsWith(`${normalizedCurrent}\\`));
    if (normalizedCurrent && childrenOfCurrent.length > 0) {
      return all.filter(
        (p) => p.toLowerCase() === normalizedCurrent || p.toLowerCase().startsWith(`${normalizedCurrent}\\`),
      );
    }
    return all;
  }, [projectAreaPaths, currentAreaPath]);

  const resolvedDefaultAreaPath = useMemo(() => {
    if (defaultValues?.areaPath) return defaultValues.areaPath;
    if (currentAreaPath && areaPathOptions.some((p) => p.toLowerCase() === currentAreaPath.toLowerCase())) {
      return areaPathOptions.find((p) => p.toLowerCase() === currentAreaPath.toLowerCase()) ?? currentAreaPath;
    }
    return areaPathOptions[0] ?? currentAreaPath ?? '';
  }, [defaultValues?.areaPath, currentAreaPath, areaPathOptions]);

  const {
    register,
    handleSubmit,
    setValue,
    getValues,
    formState: { errors },
  } = useForm<ReleaseFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      version: '',
      areaPath: resolvedDefaultAreaPath,
      startDate: '',
      targetDate: '',
      description: '',
      status: 'New',
      ...defaultValues,
    },
  });

  useEffect(() => {
    if (!isEditMode && !getValues('areaPath') && resolvedDefaultAreaPath) {
      setValue('areaPath', resolvedDefaultAreaPath);
    }
  }, [isEditMode, resolvedDefaultAreaPath, getValues, setValue]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isSubmitting) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose, isSubmitting]);

  const showAreaPicker = !isEditMode && areaPathOptions.length > 1;

  return (
    <div
      className={styles.overlay}
      {...{ 'data-testid': 'release-form-overlay' }}
      onClick={() => { if (!isSubmitting) onClose(); }}
    >
      <div
        className={styles.card}
        role="dialog"
        aria-modal="true"
        aria-labelledby="release-form-title"
        {...{ 'data-testid': dataTestId }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="release-form-title" className={styles.title}>
          {isEditMode ? 'Edit Release' : 'Create New Release'}
        </h3>
        <form
          onSubmit={handleSubmit(onSubmit)}
          noValidate
          {...{ 'data-testid': 'release-form' }}
        >
          {isEditMode && (
            <div className={styles.fieldGroup}>
              <label className={styles.label} htmlFor="release-status">Status:</label>
              <select
                id="release-status"
                className={styles.select}
                {...register('status')}
                {...{ 'data-testid': 'release-form-status' }}
              >
                <option value="New">New</option>
                <option value="In Progress">In Progress</option>
                <option value="In Design">In Design</option>
                <option value="Done">Done</option>
                <option value="Removed">Removed</option>
              </select>
            </div>
          )}

          {showAreaPicker && (
            <div className={styles.fieldGroup}>
              <label className={styles.label} htmlFor="release-area-path">
                Platform / Target Area Path
              </label>
              <select
                id="release-area-path"
                className={styles.select}
                disabled={loadingAreaPaths || isSubmitting}
                {...register('areaPath')}
                {...{ 'data-testid': 'release-form-area-path' }}
              >
                {areaPathOptions.map((pathOption) => {
                  const platformLabel = deriveReleasePlatform(pathOption, project);
                  const display = platformLabel === pathOption ? pathOption : `${platformLabel} (${pathOption})`;
                  return (
                    <option key={pathOption} value={pathOption}>
                      {display}
                    </option>
                  );
                })}
              </select>
              <p className={styles.hint}>
                Determines the release platform badge and ADO Area Path.
              </p>
            </div>
          )}

          <div className={styles.fieldGroup}>
            <label className={styles.label} htmlFor="release-version">
              Release Name <span className={styles.required}>*</span>
            </label>
            <input
              id="release-version"
              type="text"
              className={styles.input}
              {...register('version')}
              placeholder="e.g., v2.4.0"
              disabled={isEditMode || isSubmitting}
              {...{ 'data-testid': 'release-form-name' }}
            />
            {errors.version && <p className={styles.error}>{errors.version.message}</p>}
          </div>

          <div className={styles.fieldGroup}>
            <label className={styles.label} htmlFor="release-start-date">
              Start Date <span className={styles.required}>*</span>
            </label>
            <input
              id="release-start-date"
              type="date"
              className={styles.input}
              disabled={isSubmitting}
              {...register('startDate')}
              {...{ 'data-testid': 'release-form-start-date' }}
            />
            {errors.startDate && <p className={styles.error}>{errors.startDate.message}</p>}
          </div>

          <div className={styles.fieldGroup}>
            <label className={styles.label} htmlFor="release-target-date">
              Target Date <span className={styles.required}>*</span>
            </label>
            <input
              id="release-target-date"
              type="date"
              className={styles.input}
              disabled={isSubmitting}
              {...register('targetDate')}
              {...{ 'data-testid': 'release-form-target-date' }}
            />
            {errors.targetDate && <p className={styles.error}>{errors.targetDate.message}</p>}
          </div>

          <div className={styles.fieldGroup}>
            <label className={styles.label} htmlFor="release-description">
              Description <span className={styles.required}>*</span>
            </label>
            <textarea
              id="release-description"
              className={styles.textarea}
              disabled={isSubmitting}
              {...register('description')}
              placeholder="Release description..."
              rows={4}
              {...{ 'data-testid': 'release-form-description' }}
            />
            {errors.description && <p className={styles.error}>{errors.description.message}</p>}
          </div>

          {submitError && (
            <p className={styles.submitError} role="alert" {...{ 'data-testid': 'release-form-error' }}>
              {submitError}
            </p>
          )}

          <div className={styles.actions}>
            <button
              type="button"
              onClick={onClose}
              className={styles.btnSecondary}
              disabled={isSubmitting}
              {...{ 'data-testid': 'release-form-cancel' }}
            >
              Cancel
            </button>
            <button
              type="submit"
              className={styles.btnPrimary}
              disabled={isSubmitting}
              {...{ 'data-testid': 'release-form-save' }}
            >
              {isSubmitting ? 'Saving...' : isEditMode ? 'Update Release' : 'Create Release'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
