import React, { useState, useEffect, useCallback } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  useAvailableFeatureRequestAdrs,
  useSubmitFeatureRequest,
} from '../hooks/useFeatureRequests';
import type { WorkItemType } from '../../shared/types/featureRequest';
import styles from './FeatureRequestModal.module.css';

const featureRequestSchema = z.object({
  title: z.string().min(1, 'Title is required'),
  request: z.string().min(1, 'Description is required'),
  advantage: z.string().optional(),
});

type FormValues = z.infer<typeof featureRequestSchema>;

interface FeatureRequestModalProps {
  selectedProject: string;
  type?: WorkItemType;
  onClose: () => void;
}

const TYPE_COPY: Record<
  WorkItemType,
  { title: string; success: string; descriptionPlaceholder: string }
> = {
  feature: {
    title: 'Request a Feature',
    success: 'Feature request submitted — thank you!',
    descriptionPlaceholder: "Describe the feature you'd like to see",
  },
  technical: {
    title: 'Add Technical Item',
    success: 'Technical item submitted — thank you!',
    descriptionPlaceholder: 'Describe the technical work, approach, or engineering need',
  },
  issue: {
    title: 'Report an Issue',
    success: 'Issue reported — thank you!',
    descriptionPlaceholder: 'Describe what happened, the impact, and any reproduction details',
  },
};

export const FeatureRequestModal: React.FC<FeatureRequestModalProps> = ({
  selectedProject,
  type = 'feature',
  onClose,
}) => {
  const [showSuccess, setShowSuccess] = useState(false);
  const [selectedAdrIds, setSelectedAdrIds] = useState<string[]>([]);
  const submitMutation = useSubmitFeatureRequest();
  const showAdrPicker = type === 'feature' || type === 'technical';
  const {
    data: acceptedAdrs = [],
    isLoading: adrsLoading,
    isError: adrsError,
  } = useAvailableFeatureRequestAdrs(selectedProject, showAdrPicker);

  const {
    register,
    handleSubmit,
    formState: { errors },
    reset,
  } = useForm<FormValues>({
    resolver: zodResolver(featureRequestSchema),
    defaultValues: { title: '', request: '', advantage: '' },
  });

  const handleClose = useCallback(() => {
    if (!submitMutation.isPending) onClose();
  }, [submitMutation.isPending, onClose]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [handleClose]);

  const onSubmit = (values: FormValues) => {
    if (type === 'feature' && !values.advantage?.trim()) {
      return;
    }
    submitMutation.mutate(
      {
        type,
        title: values.title,
        request: values.request,
        advantage: type === 'feature' ? values.advantage : null,
        project: selectedProject,
        ...(showAdrPicker && selectedAdrIds.length > 0 ? { adrIds: selectedAdrIds } : {}),
      },
      {
        onSuccess: () => {
          setShowSuccess(true);
          reset();
          setSelectedAdrIds([]);
          window.setTimeout(() => onClose(), 1500);
        },
      },
    );
  };

  return (
    <div
      className={styles.overlay}
      onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="feature-request-title"
    >
      <form className={styles.card} onSubmit={handleSubmit(onSubmit)}>
        <h2 className={styles.title} id="feature-request-title">{TYPE_COPY[type].title}</h2>

        {showSuccess ? (
          <p className={styles.successMsg}>{TYPE_COPY[type].success}</p>
        ) : (
          <>
            <div className={styles.fieldGroup}>
              <label className={styles.label} htmlFor="fr-title">Title</label>
              <input
                id="fr-title"
                className={`${styles.input} ${errors.title ? styles.inputError : ''}`}
                placeholder="Brief title for the feature"
                autoFocus
                {...register('title')}
              />
              {errors.title && (
                <span className={styles.errorMsg}>{errors.title.message}</span>
              )}
            </div>

            <div className={styles.fieldGroup}>
              <label className={styles.label} htmlFor="fr-request">Request</label>
              <textarea
                id="fr-request"
                className={`${styles.textarea} ${errors.request ? styles.inputError : ''}`}
                rows={4}
                placeholder={TYPE_COPY[type].descriptionPlaceholder}
                {...register('request')}
              />
              {errors.request && (
                <span className={styles.errorMsg}>{errors.request.message}</span>
              )}
            </div>

            {type === 'feature' && (
              <div className={styles.fieldGroup}>
                <label className={styles.label} htmlFor="fr-advantage">Advantage</label>
                <textarea
                  id="fr-advantage"
                  className={`${styles.textarea} ${errors.advantage ? styles.inputError : ''}`}
                  rows={3}
                  required
                  placeholder="How would this benefit you or the team?"
                  {...register('advantage')}
                />
                {errors.advantage && (
                  <span className={styles.errorMsg}>{errors.advantage.message}</span>
                )}
              </div>
            )}

            {showAdrPicker && (
              <fieldset className={styles.adrPicker}>
                <legend className={styles.label}>Related accepted ADRs (optional)</legend>
                <p className={styles.fieldHint}>
                  Link architectural decisions as context for this request.
                </p>
                {adrsLoading ? (
                  <span className={styles.fieldHint} role="status">Loading accepted ADRs…</span>
                ) : adrsError ? (
                  <span className={styles.errorMsg}>Accepted ADRs could not be loaded.</span>
                ) : acceptedAdrs.length === 0 ? (
                  <span className={styles.fieldHint}>No accepted ADRs are available for this project.</span>
                ) : (
                  <div className={styles.adrOptions}>
                    {acceptedAdrs.map((adr) => (
                      <label className={styles.adrOption} key={adr.id}>
                        <input
                          type="checkbox"
                          checked={selectedAdrIds.includes(adr.id)}
                          onChange={(event) => setSelectedAdrIds((current) =>
                            event.target.checked
                              ? [...current, adr.id]
                              : current.filter((id) => id !== adr.id))}
                        />
                        <span>
                          <strong>{adr.title}</strong>
                          <small>{adr.repo} / {adr.slug ?? adr.id.slice(0, 8)}</small>
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </fieldset>
            )}

            {submitMutation.isError && (
              <span className={styles.errorMsg}>
                {submitMutation.error?.message ?? 'Submission failed — please try again.'}
              </span>
            )}

            <div className={styles.actions}>
              <button
                className={styles.btnCancel}
                onClick={handleClose}
                disabled={submitMutation.isPending}
                type="button"
              >
                Cancel
              </button>
              <button
                className={styles.btnSubmit}
                type="submit"
                disabled={submitMutation.isPending}
              >
                {submitMutation.isPending ? 'Submitting…' : 'Submit'}
              </button>
            </div>
          </>
        )}
      </form>
    </div>
  );
};
