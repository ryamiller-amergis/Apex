import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  RFP_ATTACHMENT_MAX_BYTES,
  RFP_AUDIENCES,
  RFP_DATA_SENSITIVITIES,
  RFP_REQUEST_TYPES,
  validateRfpAttachments,
} from '../../shared/types/rfpIntake';
import { useSubmitRfpRequest } from '../hooks/useRfpIntake';
import {
  RFP_INTAKE_FORM_DEFAULTS,
  rfpIntakeFormSchema,
  toRfpIntakePayload,
  type RfpIntakeFormValues,
} from './rfpIntakeFormSchema';
import styles from './RfpIntakeLanding.module.css';

interface RfpSubmissionModalProps {
  onClose: () => void;
  onSubmitted?: (request: { id: string; title: string }) => void;
}

export const RfpSubmissionModal: React.FC<RfpSubmissionModalProps> = ({ onClose, onSubmitted }) => {
  const submitRfp = useSubmitRfpRequest();
  const [files, setFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<{ id: string; title: string } | null>(null);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);
  const {
    register,
    handleSubmit,
    control,
    formState: { errors, isSubmitting },
  } = useForm<RfpIntakeFormValues>({
    resolver: zodResolver(rfpIntakeFormSchema),
    defaultValues: RFP_INTAKE_FORM_DEFAULTS,
  });
  const requestType = useWatch({ control, name: 'requestType' });
  const showStack = requestType === 'change-existing';
  const pending = isSubmitting || submitRfp.isPending;

  useEffect(() => {
    firstFieldRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const titleReg = register('title');
  const summary = useMemo(() => Object.values(errors).map((err) => err?.message).filter(Boolean), [errors]);

  const onSubmit = async (values: RfpIntakeFormValues) => {
    const attachmentErrors = validateRfpAttachments(
      files.map((file) => ({ filename: file.name, contentType: file.type, sizeBytes: file.size })),
    );
    if (attachmentErrors.length > 0) {
      setFileError(attachmentErrors.join('; '));
      return;
    }
    setFileError(null);
    try {
      const created = await submitRfp.mutateAsync({ intake: toRfpIntakePayload(values), files });
      setSubmitted({ id: created.id, title: created.title });
    } catch {
      // Form values stay; actionable error is shown below.
    }
  };

  return (
    <div
      className={`${styles.overlay} ${styles.modalOverlay}`}
      role="dialog"
      aria-modal="true"
      aria-labelledby="rfp-submit-title"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
      onKeyDown={(event) => { if (event.key === 'Escape') onClose(); }}
      {...{ 'data-testid': 'rfp-submission-modal' }}
    >
      <div className={styles.modal}>
        <div className={styles.header}>
          <div>
            <h2 id="rfp-submit-title" className={styles.title}>Request a Product</h2>
            <p className={styles.subtitle}>Tell Apex about the product need. Evaluation starts after you submit.</p>
          </div>
          <button
            type="button"
            className={styles.closeButton}
            onClick={onClose}
            aria-label="Close request a product form"
            {...{ 'data-testid': 'rfp-submit-close' }}
          >
            &times;
          </button>
        </div>

        {submitted && (
          <div className={styles.successBanner} role="status" aria-live="polite" {...{ 'data-testid': 'rfp-submit-success' }}>
            <p className={styles.successTitle}>Request submitted successfully</p>
            <p className={styles.successBody}>
              “{submitted.title}” is in the queue and evaluation is starting.
            </p>
            <div className={styles.successActions}>
              <button type="button" className={styles.secondaryButton} onClick={onClose} {...{ 'data-testid': 'rfp-submit-success-close' }}>
                Close
              </button>
              <button
                type="button"
                className={styles.primaryButton}
                onClick={() => {
                  onSubmitted?.(submitted);
                  onClose();
                }}
                {...{ 'data-testid': 'rfp-submit-success-view' }}
              >
                View request
              </button>
            </div>
          </div>
        )}

        {!submitted && summary.length > 0 && (
          <p className={styles.summary} aria-live="assertive" {...{ 'data-testid': 'rfp-validation-summary' }}>
            {summary.join('. ')}
          </p>
        )}
        {!submitted && submitRfp.isError && (
          <p className={styles.summary} role="alert" {...{ 'data-testid': 'rfp-submit-error' }}>
            {submitRfp.error.message || 'Could not create the request. Your answers are still here — try again.'}
          </p>
        )}

        {!submitted && (
        <form className={styles.form} onSubmit={(event) => void handleSubmit(onSubmit)(event)} {...{ 'data-testid': 'rfp-submission-form' }}>
          <label className={styles.field}>
            <span className={styles.label}>Title</span>
            <input
              className={styles.input}
              {...titleReg}
              ref={(el) => {
                titleReg.ref(el);
                firstFieldRef.current = el;
              }}
              aria-describedby={errors.title ? 'rfp-title-error' : undefined}
              {...{ 'data-testid': 'rfp-field-title' }}
            />
            {errors.title && <span id="rfp-title-error" className={styles.fieldError}>{errors.title.message}</span>}
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Stakeholder</span>
            <input className={styles.input} {...register('stakeholder')} {...{ 'data-testid': 'rfp-field-stakeholder' }} />
            {errors.stakeholder && <span className={styles.fieldError}>{errors.stakeholder.message}</span>}
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Request</span>
            <textarea className={styles.textarea} {...register('request')} {...{ 'data-testid': 'rfp-field-request' }} />
            {errors.request && <span className={styles.fieldError}>{errors.request.message}</span>}
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Problem</span>
            <textarea className={styles.textarea} {...register('problem')} {...{ 'data-testid': 'rfp-field-problem' }} />
            {errors.problem && <span className={styles.fieldError}>{errors.problem.message}</span>}
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Audience</span>
            <select className={styles.select} {...register('audience')} {...{ 'data-testid': 'rfp-field-audience' }}>
              {RFP_AUDIENCES.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Data sensitivity</span>
            <select className={styles.select} {...register('dataSensitivity')} {...{ 'data-testid': 'rfp-field-dataSensitivity' }}>
              {RFP_DATA_SENSITIVITIES.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Existing solution</span>
            <textarea className={styles.textarea} {...register('existingSolution')} {...{ 'data-testid': 'rfp-field-existingSolution' }} />
            {errors.existingSolution && <span className={styles.fieldError}>{errors.existingSolution.message}</span>}
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Advantage (optional)</span>
            <textarea className={styles.textarea} {...register('advantage')} {...{ 'data-testid': 'rfp-field-advantage' }} />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Constraints (optional)</span>
            <textarea className={styles.textarea} {...register('constraints')} {...{ 'data-testid': 'rfp-field-constraints' }} />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Request type (optional)</span>
            <select className={styles.select} {...register('requestType')} {...{ 'data-testid': 'rfp-field-requestType' }}>
              <option value="">Select…</option>
              {RFP_REQUEST_TYPES.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          {showStack && (
            <label className={styles.field}>
              <span className={styles.label}>Existing system stack</span>
              <textarea
                className={styles.textarea}
                {...register('existingSystemStack')}
                {...{ 'data-testid': 'rfp-existing-system-stack' }}
              />
              {errors.existingSystemStack && <span className={styles.fieldError}>{errors.existingSystemStack.message}</span>}
            </label>
          )}
          <label className={styles.field}>
            <span className={styles.label}>Attachments (optional, PNG/JPG/GIF/WebP/PDF, 10 MB, max 5)</span>
            <input
              className={styles.input}
              type="file"
              multiple
              accept=".png,.jpg,.jpeg,.gif,.webp,.pdf,image/png,image/jpeg,image/gif,image/webp,application/pdf"
              onChange={(event) => {
                const next = Array.from(event.target.files ?? []).slice(0, 5);
                const tooLarge = next.find((file) => file.size > RFP_ATTACHMENT_MAX_BYTES);
                setFiles(next);
                setFileError(tooLarge ? `${tooLarge.name} exceeds 10 MB` : null);
              }}
              {...{ 'data-testid': 'rfp-field-attachments' }}
            />
            {fileError && <span className={styles.fieldError}>{fileError}</span>}
          </label>
          <div className={styles.actions}>
            <button type="button" className={styles.secondaryButton} onClick={onClose} disabled={pending} {...{ 'data-testid': 'rfp-submit-cancel' }}>
              Cancel
            </button>
            <button type="submit" className={styles.primaryButton} disabled={pending} {...{ 'data-testid': 'rfp-submit-button' }}>
              {pending ? 'Submitting…' : 'Submit request'}
            </button>
          </div>
        </form>
        )}
      </div>
    </div>
  );
};
