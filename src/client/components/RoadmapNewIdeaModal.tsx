import React from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  ROADMAP_CONFIDENCE_LEVELS,
  ROADMAP_EFFORT_SIZES,
  ROADMAP_HORIZONS,
  type CreateRoadmapAdhocIdeaInput,
} from '../../shared/types/roadmap';
import styles from './RoadmapView.module.css';

const newIdeaSchema = z
  .object({
    title: z.string().trim().min(1, 'Idea title is required'),
    ownerLabel: z.string(),
    horizon: z.enum(ROADMAP_HORIZONS),
    effortSize: z.enum(ROADMAP_EFFORT_SIZES),
    confidence: z.enum(ROADMAP_CONFIDENCE_LEVELS),
    releaseLabel: z.string(),
    plannedStartDate: z.string(),
    plannedTargetDate: z.string(),
    notes: z.string(),
  })
  .refine(
    (values) =>
      !values.plannedStartDate ||
      !values.plannedTargetDate ||
      values.plannedStartDate <= values.plannedTargetDate,
    {
      message: 'Start date cannot be after target date',
      path: ['plannedTargetDate'],
    },
  );

type NewIdeaFormValues = z.infer<typeof newIdeaSchema>;

export interface RoadmapNewIdeaModalProps {
  isOpen: boolean;
  isSubmitting: boolean;
  errorMessage?: string | null;
  onClose: () => void;
  onCreate: (input: CreateRoadmapAdhocIdeaInput) => Promise<void>;
}

export const RoadmapNewIdeaModal: React.FC<RoadmapNewIdeaModalProps> = ({
  isOpen,
  isSubmitting,
  errorMessage = null,
  onClose,
  onCreate,
}) => {
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<NewIdeaFormValues>({
    resolver: zodResolver(newIdeaSchema),
    defaultValues: {
      title: '',
      ownerLabel: '',
      horizon: 'later',
      effortSize: 'M',
      confidence: 'medium',
      releaseLabel: '',
      plannedStartDate: '',
      plannedTargetDate: '',
      notes: '',
    },
  });

  if (!isOpen) return null;

  const submitForm = async (values: NewIdeaFormValues) => {
    await onCreate({
      title: values.title.trim(),
      ownerLabel: values.ownerLabel.trim() || null,
      horizon: values.horizon,
      effortSize: values.effortSize,
      confidence: values.confidence,
      releaseLabel: values.releaseLabel.trim() || null,
      plannedStartDate: values.plannedStartDate || null,
      plannedTargetDate: values.plannedTargetDate || null,
      notes: values.notes.trim() || null,
    });
    reset();
  };

  return (
    <div
      className={styles.modalBackdrop}
      role="dialog"
      aria-modal="true"
      aria-labelledby="roadmap-new-idea-heading"
      data-testid="roadmap-new-idea-modal"
    >
      <div className={styles.modalDialog}>
        <div className={styles.inspectorHeader}>
          <div>
            <span className={`${styles.originBadge} ${styles.originAdhoc}`}>
              Sandbox Idea
            </span>
            <h3 id="roadmap-new-idea-heading" className={styles.inspectorTitle}>
              New Ad-hoc Roadmap Idea
            </h3>
          </div>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            aria-label="Close new idea composer"
            data-testid="roadmap-new-idea-close-btn"
          >
            ✕
          </button>
        </div>

        {errorMessage && (
          <div className={styles.bannerError} role="alert">
            {errorMessage}
          </div>
        )}

        <form
          className={styles.inspectorForm}
          onSubmit={handleSubmit(submitForm)}
          noValidate
          data-testid="roadmap-new-idea-form"
        >
          <div className={styles.formField}>
            <label htmlFor="roadmap-idea-title" className={styles.fieldLabel}>
              Idea Title *
            </label>
            <input
              id="roadmap-idea-title"
              type="text"
              className={styles.textInput}
              placeholder="e.g., Prior Auth Auto-Triage"
              data-testid="roadmap-idea-title-input"
              {...register('title')}
            />
            {errors.title && (
              <p className={styles.fieldError}>{errors.title.message}</p>
            )}
          </div>

          <div className={styles.fieldRow2}>
            <div className={styles.formField}>
              <label htmlFor="roadmap-idea-owner" className={styles.fieldLabel}>
                Owner / Lead
              </label>
              <input
                id="roadmap-idea-owner"
                type="text"
                className={styles.textInput}
                placeholder="e.g., Sarah Jenkins"
                data-testid="roadmap-idea-owner-input"
                {...register('ownerLabel')}
              />
            </div>

            <div className={styles.formField}>
              <label
                htmlFor="roadmap-idea-release"
                className={styles.fieldLabel}
              >
                Release / Theme
              </label>
              <input
                id="roadmap-idea-release"
                type="text"
                className={styles.textInput}
                placeholder="e.g., Q1 Claims Automation"
                data-testid="roadmap-idea-release-input"
                {...register('releaseLabel')}
              />
            </div>
          </div>

          <div className={styles.fieldRow2}>
            <div className={styles.formField}>
              <label
                htmlFor="roadmap-idea-horizon"
                className={styles.fieldLabel}
              >
                Horizon
              </label>
              <select
                id="roadmap-idea-horizon"
                className={styles.selectInput}
                data-testid="roadmap-idea-horizon-select"
                {...register('horizon')}
              >
                <option value="now">Now</option>
                <option value="next">Next</option>
                <option value="later">Later</option>
                <option value="unplanned">Unplanned</option>
              </select>
            </div>

            <div className={styles.formField}>
              <label
                htmlFor="roadmap-idea-effort"
                className={styles.fieldLabel}
              >
                Effort Size
              </label>
              <select
                id="roadmap-idea-effort"
                className={styles.selectInput}
                data-testid="roadmap-idea-effort-select"
                {...register('effortSize')}
              >
                <option value="S">S — Small</option>
                <option value="M">M — Medium</option>
                <option value="L">L — Large</option>
                <option value="XL">XL — Extra Large</option>
              </select>
            </div>
          </div>

          <div className={styles.fieldRow2}>
            <div className={styles.formField}>
              <label
                htmlFor="roadmap-idea-start-date"
                className={styles.fieldLabel}
              >
                Planned Start (Optional)
              </label>
              <input
                id="roadmap-idea-start-date"
                type="date"
                className={styles.textInput}
                data-testid="roadmap-idea-start-date-input"
                {...register('plannedStartDate')}
              />
            </div>

            <div className={styles.formField}>
              <label
                htmlFor="roadmap-idea-target-date"
                className={styles.fieldLabel}
              >
                Planned Target (Optional)
              </label>
              <input
                id="roadmap-idea-target-date"
                type="date"
                className={styles.textInput}
                data-testid="roadmap-idea-target-date-input"
                {...register('plannedTargetDate')}
              />
              {errors.plannedTargetDate && (
                <p className={styles.fieldError}>
                  {errors.plannedTargetDate.message}
                </p>
              )}
            </div>
          </div>

          <div className={styles.formField}>
            <label
              htmlFor="roadmap-idea-confidence"
              className={styles.fieldLabel}
            >
              Confidence
            </label>
            <select
              id="roadmap-idea-confidence"
              className={styles.selectInput}
              data-testid="roadmap-idea-confidence-select"
              {...register('confidence')}
            >
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </div>

          <div className={styles.formField}>
            <label htmlFor="roadmap-idea-notes" className={styles.fieldLabel}>
              Problem / Outcome Notes
            </label>
            <textarea
              id="roadmap-idea-notes"
              rows={3}
              className={styles.textareaInput}
              placeholder="Capture stakeholder goal, dependencies, or assumptions before creating formal backlog items..."
              data-testid="roadmap-idea-notes-input"
              {...register('notes')}
            />
          </div>

          <div className={styles.modalFooter}>
            <button
              type="button"
              className={styles.secondaryBtn}
              onClick={onClose}
              disabled={isSubmitting}
              data-testid="roadmap-new-idea-cancel-btn"
            >
              Cancel
            </button>
            <button
              type="submit"
              className={styles.primaryBtn}
              disabled={isSubmitting}
              data-testid="roadmap-create-idea-submit"
            >
              {isSubmitting ? 'Saving…' : 'Add to Roadmap'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
