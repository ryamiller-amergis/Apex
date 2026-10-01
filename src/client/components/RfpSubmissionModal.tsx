import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  RFP_AI_INTENTS,
  RFP_AI_INTENT_LABELS,
  RFP_ATTACHMENT_MAX_BYTES,
  RFP_AUDIENCES,
  RFP_DATA_SENSITIVITIES,
  RFP_EXPECTED_USER_SCALES,
  RFP_EXPECTED_USER_SCALE_LABELS,
  RFP_REQUEST_TYPES,
  validateRfpAttachments,
} from '../../shared/types/rfpIntake';
import { useFieldDictation } from '../hooks/useFieldDictation';
import { useSubmitRfpRequest } from '../hooks/useRfpIntake';
import {
  RFP_INTAKE_FORM_DEFAULTS,
  rfpIntakeFormSchema,
  toRfpIntakePayload,
  type RfpDictationField,
  type RfpIntakeFormValues,
} from './rfpIntakeFormSchema';
import styles from './RfpIntakeLanding.module.css';

const MicIcon: React.FC = () => (
  <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="7" y="2.5" width="6" height="10" rx="3" />
    <path d="M4.5 9.5v0.5a5.5 5.5 0 0 0 11 0v-0.5" />
    <path d="M10 15.5v2.5" />
    <path d="M7.5 18h5" />
  </svg>
);

interface RfpSubmissionModalProps {
  onClose: () => void;
  onSubmitted?: (request: { id: string; title: string }) => void;
}

export const RfpSubmissionModal: React.FC<RfpSubmissionModalProps> = ({ onClose, onSubmitted }) => {
  const submitRfp = useSubmitRfpRequest();
  const [files, setFiles] = useState<File[]>([]);
  const [fileError, setFileError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<{ id: string; title: string } | null>(null);
  const [showDiscardConfirm, setShowDiscardConfirm] = useState(false);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);
  const keepEditingRef = useRef<HTMLButtonElement | null>(null);
  const {
    register,
    handleSubmit,
    control,
    getValues,
    setValue,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<RfpIntakeFormValues>({
    resolver: zodResolver(rfpIntakeFormSchema),
    defaultValues: RFP_INTAKE_FORM_DEFAULTS,
  });
  const dictation = useFieldDictation({
    getValue: (field: RfpDictationField) => getValues(field) ?? '',
    setValue: (field: RfpDictationField, text: string) => setValue(field, text, { shouldDirty: true }),
  });
  const requestType = useWatch({ control, name: 'requestType' });
  const showStack = requestType === 'change-existing';
  const pending = isSubmitting || submitRfp.isPending;
  const isFormDirty = isDirty || files.length > 0;

  const requestClose = () => {
    // A submitted form has nothing to lose — close immediately.
    if (submitted || !isFormDirty) {
      onClose();
      return;
    }
    setShowDiscardConfirm(true);
  };

  useEffect(() => {
    firstFieldRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (showDiscardConfirm) {
        setShowDiscardConfirm(false);
        return;
      }
      requestClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, showDiscardConfirm, submitted, isFormDirty]);

  useEffect(() => {
    if (showDiscardConfirm) keepEditingRef.current?.focus();
  }, [showDiscardConfirm]);

  const titleReg = register('title');
  const summary = useMemo(() => Object.values(errors).map((err) => err?.message).filter(Boolean), [errors]);

  const renderDictationField = (field: RfpDictationField, label: string, testId: string) => {
    const inputId = `rfp-field-${field}-input`;
    const listening = dictation.activeField === field;
    const error = errors[field]?.message;
    return (
      <div className={styles.field}>
        <div className={styles.labelRow}>
          <label className={styles.label} htmlFor={inputId}>{label}</label>
          {dictation.isSupported && (
            <button
              type="button"
              className={`${styles.micButton}${listening ? ` ${styles.micButtonActive}` : ''}`}
              onClick={() => dictation.toggleField(field)}
              aria-pressed={listening}
              aria-label={listening ? `Stop talk to text for ${label}` : `Talk to text for ${label}`}
              title={listening ? 'Stop listening' : 'Talk to text'}
              {...{ 'data-testid': `rfp-mic-${field}` }}
            >
              <MicIcon />
              {listening && <span>Listening…</span>}
            </button>
          )}
        </div>
        <textarea id={inputId} className={styles.textarea} {...register(field)} {...{ 'data-testid': testId }} />
        {error && <span className={styles.fieldError}>{error}</span>}
      </div>
    );
  };

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
            onClick={requestClose}
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
            <span className={styles.label}>Sponsoring team</span>
            <input
              className={styles.input}
              placeholder="e.g. Benefits Administration"
              aria-describedby="rfp-stakeholder-hint"
              {...register('stakeholder')}
              {...{ 'data-testid': 'rfp-field-stakeholder' }}
            />
            <span id="rfp-stakeholder-hint" className={styles.hint}>
              The business group that owns the problem and will use the app.
            </span>
            {errors.stakeholder && <span className={styles.fieldError}>{errors.stakeholder.message}</span>}
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Expected users</span>
            <select className={styles.select} {...register('expectedUsers')} {...{ 'data-testid': 'rfp-field-expectedUsers' }}>
              <option value="">Select…</option>
              {RFP_EXPECTED_USER_SCALES.map((value) => (
                <option key={value} value={value}>{RFP_EXPECTED_USER_SCALE_LABELS[value]}</option>
              ))}
            </select>
            {errors.expectedUsers && <span className={styles.fieldError}>{errors.expectedUsers.message}</span>}
          </label>
          <label className={styles.field}>
            <span className={styles.label}>AI in the application</span>
            <select className={styles.select} {...register('aiInApp')} {...{ 'data-testid': 'rfp-field-aiInApp' }}>
              <option value="">Select…</option>
              {RFP_AI_INTENTS.map((value) => (
                <option key={value} value={value}>{RFP_AI_INTENT_LABELS[value]}</option>
              ))}
            </select>
            {errors.aiInApp && <span className={styles.fieldError}>{errors.aiInApp.message}</span>}
          </label>
          {renderDictationField('request', 'Request', 'rfp-field-request')}
          {renderDictationField('problem', 'Problem', 'rfp-field-problem')}
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
          {renderDictationField('existingSolution', 'Existing solution', 'rfp-field-existingSolution')}
          {renderDictationField('advantage', 'Advantage (optional)', 'rfp-field-advantage')}
          {renderDictationField('constraints', 'Constraints (optional)', 'rfp-field-constraints')}
          {dictation.error && (
            <p className={styles.fieldError} role="alert" {...{ 'data-testid': 'rfp-dictation-error' }}>{dictation.error}</p>
          )}
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
            <button type="button" className={styles.secondaryButton} onClick={requestClose} disabled={pending} {...{ 'data-testid': 'rfp-submit-cancel' }}>
              Cancel
            </button>
            <button type="submit" className={styles.primaryButton} disabled={pending} {...{ 'data-testid': 'rfp-submit-button' }}>
              {pending ? 'Submitting…' : 'Submit request'}
            </button>
          </div>
        </form>
        )}
      </div>
      {showDiscardConfirm && (
        <div
          className={styles.confirmOverlay}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="rfp-discard-title"
          aria-describedby="rfp-discard-body"
          {...{ 'data-testid': 'rfp-discard-confirm' }}
        >
          <div className={styles.confirmDialog}>
            <h3 id="rfp-discard-title" className={styles.confirmTitle}>Leave without submitting?</h3>
            <p id="rfp-discard-body" className={styles.confirmBody}>
              You have unsent changes. Leaving now discards what you entered.
            </p>
            <div className={styles.confirmActions}>
              <button
                type="button"
                ref={keepEditingRef}
                className={styles.secondaryButton}
                onClick={() => setShowDiscardConfirm(false)}
                {...{ 'data-testid': 'rfp-discard-keep' }}
              >
                Keep editing
              </button>
              <button
                type="button"
                className={styles.primaryButton}
                onClick={onClose}
                {...{ 'data-testid': 'rfp-discard-discard' }}
              >
                Discard changes
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
