import React, { useEffect, useMemo } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import type { QuickLinkScope } from '../../shared/types/projectQuickLinks';
import {
  quickLinkCategoryField,
  quickLinkLabelField,
  quickLinkUrlField,
} from '../utils/quickLinkForm';
import { QuickLinkCategoryField } from './QuickLinkCategoryField';
import styles from './QuickLinkModals.module.css';

const quickLinkEditSchema = z.object({
  label: quickLinkLabelField,
  url: quickLinkUrlField,
  category: quickLinkCategoryField,
  scope: z.enum(['personal', 'project']),
});

export type QuickLinkEditValues = z.infer<typeof quickLinkEditSchema>;

interface QuickLinkEditModalProps {
  project: string;
  /** Present when editing; absent when adding. */
  initial?: Partial<QuickLinkEditValues>;
  /** True with quick-links:manage: shows the "Save to" choice. Otherwise links are always personal. */
  canShare: boolean;
  personalCategories: string[];
  projectCategories: string[];
  isPending: boolean;
  serverError: string | null;
  onSubmit: (values: QuickLinkEditValues) => void;
  onCancel: () => void;
  'data-testid'?: string;
}

export const QuickLinkEditModal: React.FC<QuickLinkEditModalProps> = ({
  project,
  initial,
  canShare,
  personalCategories,
  projectCategories,
  isPending,
  serverError,
  onSubmit,
  onCancel,
  'data-testid': testId = 'quick-link-edit-modal',
}) => {
  const isEdit = Boolean(initial);
  const {
    register,
    control,
    handleSubmit,
    setFocus,
    setValue,
    formState: { errors },
  } = useForm<QuickLinkEditValues>({
    resolver: zodResolver(quickLinkEditSchema),
    defaultValues: {
      label: initial?.label ?? '',
      url: initial?.url ?? '',
      category: initial?.category ?? '',
      scope: canShare ? (initial?.scope ?? 'personal') : 'personal',
    },
  });

  const scope = useWatch({ control, name: 'scope' });

  const categoryOptions = useMemo(
    () =>
      scope === 'project'
        ? projectCategories
        : Array.from(new Set([...personalCategories, ...projectCategories])).sort((a, b) => a.localeCompare(b)),
    [scope, personalCategories, projectCategories],
  );

  useEffect(() => {
    setFocus('label');
  }, [setFocus]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onCancel]);

  const submit = (values: QuickLinkEditValues) => onSubmit(canShare ? values : { ...values, scope: 'personal' });

  const scopeOption = (value: QuickLinkScope, title: string, hint: string) => (
    <label className={`${styles.scopeOption} ${scope === value ? styles.scopeOptionActive : ''}`}>
      <input
        type="radio"
        value={value}
        className={styles.scopeRadio}
        {...register('scope', {
          onChange: () => setValue('category', ''),
        })}
        {...{ 'data-testid': `quick-link-edit-scope-${value}` }}
      />
      <span className={styles.scopeText}>
        <span className={styles.scopeTitle}>{title}</span>
        <span className={styles.scopeHint}>{hint}</span>
      </span>
    </label>
  );

  return (
    <div
      className={styles.overlay}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="quick-link-edit-title"
      {...{ 'data-testid': testId }}
    >
      <form
        className={styles.card}
        onSubmit={handleSubmit(submit)}
        noValidate
        {...{ 'data-testid': 'quick-link-edit-form' }}
      >
        <h2 className={styles.title} id="quick-link-edit-title">
          {isEdit ? 'Edit link' : 'Add link'}
        </h2>

        {canShare ? (
          <fieldset className={styles.scopeGroup} {...{ 'data-testid': 'quick-link-edit-scope' }}>
            <legend className={styles.label}>Save to</legend>
            {scopeOption('personal', 'Only me', 'A private link under My links')}
            {scopeOption('project', `Everyone in ${project}`, 'A shared link under Project links')}
          </fieldset>
        ) : (
          <p className={styles.text}>Only you will see this link, and only in {project}.</p>
        )}

        <div className={styles.field}>
          <label className={styles.label} htmlFor="quick-link-edit-label">Label</label>
          <input
            id="quick-link-edit-label"
            className={styles.input}
            placeholder="e.g. MaxView Prod"
            aria-invalid={Boolean(errors.label)}
            {...register('label')}
            {...{ 'data-testid': 'quick-link-edit-label' }}
          />
          {errors.label && <p className={styles.fieldError}>{errors.label.message}</p>}
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="quick-link-edit-url">URL</label>
          <input
            id="quick-link-edit-url"
            className={styles.input}
            type="url"
            placeholder="https://"
            aria-invalid={Boolean(errors.url)}
            {...register('url')}
            {...{ 'data-testid': 'quick-link-edit-url' }}
          />
          {errors.url && <p className={styles.fieldError}>{errors.url.message}</p>}
        </div>

        <Controller
          control={control}
          name="category"
          render={({ field }) => (
            <QuickLinkCategoryField
              key={scope}
              id="quick-link-edit-category"
              label="Category (optional)"
              value={field.value}
              onChange={field.onChange}
              options={categoryOptions}
              error={errors.category?.message}
              data-testid="quick-link-edit-category"
            />
          )}
        />

        {serverError && (
          <p className={styles.formError} role="alert" {...{ 'data-testid': 'quick-link-edit-error' }}>
            {serverError}
          </p>
        )}

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.button}
            onClick={onCancel}
            disabled={isPending}
            {...{ 'data-testid': 'quick-link-edit-cancel' }}
          >
            Cancel
          </button>
          <button
            type="submit"
            className={styles.buttonPrimary}
            disabled={isPending}
            {...{ 'data-testid': 'quick-link-edit-save' }}
          >
            {isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
};

export default QuickLinkEditModal;
