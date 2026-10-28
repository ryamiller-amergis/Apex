import React, { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import type { UserQuickLink } from '../../shared/types/projectQuickLinks';
import {
  quickLinkCategoryField,
  quickLinkLabelField,
  quickLinkUrlField,
} from '../utils/quickLinkForm';
import styles from './QuickLinkModals.module.css';

const personalLinkSchema = z.object({
  label: quickLinkLabelField,
  url: quickLinkUrlField,
  category: quickLinkCategoryField,
});

export type PersonalQuickLinkFormValues = z.infer<typeof personalLinkSchema>;

interface PersonalQuickLinkModalProps {
  link: UserQuickLink | null;
  categories: string[];
  isPending: boolean;
  serverError: string | null;
  onSubmit: (values: PersonalQuickLinkFormValues) => void;
  onCancel: () => void;
  'data-testid'?: string;
}

export const PersonalQuickLinkModal: React.FC<PersonalQuickLinkModalProps> = ({
  link,
  categories,
  isPending,
  serverError,
  onSubmit,
  onCancel,
  'data-testid': testId = 'personal-quick-link-modal',
}) => {
  const {
    register,
    handleSubmit,
    setFocus,
    formState: { errors },
  } = useForm<PersonalQuickLinkFormValues>({
    resolver: zodResolver(personalLinkSchema),
    defaultValues: {
      label: link?.label ?? '',
      url: link?.url ?? '',
      category: link?.category ?? '',
    },
  });

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

  return (
    <div
      className={styles.overlay}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="personal-quick-link-title"
      {...{ 'data-testid': testId }}
    >
      <form
        className={styles.card}
        onSubmit={handleSubmit(onSubmit)}
        noValidate
        {...{ 'data-testid': 'personal-quick-link-form' }}
      >
        <h2 className={styles.title} id="personal-quick-link-title">
          {link ? 'Edit my link' : 'Add my link'}
        </h2>
        <p className={styles.text}>Only you will see this link, and only in this project.</p>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="personal-quick-link-label">Label</label>
          <input
            id="personal-quick-link-label"
            className={styles.input}
            aria-invalid={Boolean(errors.label)}
            {...register('label')}
            {...{ 'data-testid': 'personal-quick-link-label' }}
          />
          {errors.label && <p className={styles.fieldError}>{errors.label.message}</p>}
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="personal-quick-link-url">URL</label>
          <input
            id="personal-quick-link-url"
            className={styles.input}
            type="url"
            placeholder="https://"
            aria-invalid={Boolean(errors.url)}
            {...register('url')}
            {...{ 'data-testid': 'personal-quick-link-url' }}
          />
          {errors.url && <p className={styles.fieldError}>{errors.url.message}</p>}
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="personal-quick-link-category">Category (optional)</label>
          <input
            id="personal-quick-link-category"
            className={styles.input}
            list="personal-quick-link-category-options"
            aria-invalid={Boolean(errors.category)}
            {...register('category')}
            {...{ 'data-testid': 'personal-quick-link-category' }}
          />
          <datalist id="personal-quick-link-category-options">
            {categories.map((c) => <option key={c} value={c} />)}
          </datalist>
          {errors.category && <p className={styles.fieldError}>{errors.category.message}</p>}
        </div>

        {serverError && (
          <p className={styles.formError} role="alert" {...{ 'data-testid': 'personal-quick-link-error' }}>
            {serverError}
          </p>
        )}

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.button}
            onClick={onCancel}
            disabled={isPending}
            {...{ 'data-testid': 'personal-quick-link-cancel' }}
          >
            Cancel
          </button>
          <button
            type="submit"
            className={styles.buttonPrimary}
            disabled={isPending}
            {...{ 'data-testid': 'personal-quick-link-save' }}
          >
            {isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
};

export default PersonalQuickLinkModal;
