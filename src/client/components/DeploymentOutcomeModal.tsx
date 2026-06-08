import React, { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  useDeploymentOutcomes,
  useRecordOutcome,
  useUpdateOutcome,
  useDeleteOutcome,
  resolveDeploymentIdForRelease,
} from '../hooks/useDeploymentOutcomes';
import type { DeploymentOutcome, DeploymentResult } from '../../shared/types/deploymentOutcome';
import styles from './DeploymentOutcomeModal.module.css';

const outcomeSchema = z.object({
  result: z.enum(['success', 'downtime', 'rollback']),
  downtimeMinutes: z.number().min(0).optional(),
  details: z.string().optional(),
}).refine(
  (data) => data.result !== 'downtime' || (data.downtimeMinutes !== undefined && data.downtimeMinutes > 0),
  { message: 'Downtime minutes required when result is downtime', path: ['downtimeMinutes'] },
);

type OutcomeFormValues = z.infer<typeof outcomeSchema>;

interface DeploymentOutcomeModalProps {
  isOpen: boolean;
  onClose: () => void;
  releaseVersion: string;
  deployedAt?: string;
}

const RESULT_OPTIONS: { value: DeploymentResult; label: string }[] = [
  { value: 'success', label: 'Success' },
  { value: 'downtime', label: 'Downtime' },
  { value: 'rollback', label: 'Rollback' },
];

const RESULT_LABELS: Record<DeploymentResult, string> = {
  success: 'Success',
  downtime: 'Downtime',
  rollback: 'Rollback',
};

const HISTORY_BADGE_CLASS: Record<DeploymentResult, string> = {
  success: styles.badgeSuccess,
  downtime: styles.badgeDowntime,
  rollback: styles.badgeRollback,
};

function formValuesFromOutcome(outcome: DeploymentOutcome): OutcomeFormValues {
  return {
    result: outcome.result,
    downtimeMinutes: outcome.downtimeMinutes,
    details: outcome.details ?? '',
  };
}

export const DeploymentOutcomeModal: React.FC<DeploymentOutcomeModalProps> = ({
  isOpen,
  onClose,
  releaseVersion,
  deployedAt,
}) => {
  const { data: outcomes = [], isLoading } = useDeploymentOutcomes(isOpen ? releaseVersion : undefined);
  const { mutate: recordOutcome, isPending: isCreating, error: createError, isSuccess: createSuccess, reset: resetCreate } = useRecordOutcome();
  const { mutate: updateOutcome, isPending: isUpdating, error: updateError, isSuccess: updateSuccess, reset: resetUpdate } = useUpdateOutcome();
  const { mutate: deleteOutcome, isPending: isDeleting, error: deleteError } = useDeleteOutcome();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  const isPending = isCreating || isUpdating || isDeleting;
  const mutationError = createError ?? updateError ?? deleteError;
  const isSuccess = createSuccess || updateSuccess;

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    reset: resetForm,
    formState: { errors },
  } = useForm<OutcomeFormValues>({
    resolver: zodResolver(outcomeSchema),
    defaultValues: { result: undefined, downtimeMinutes: undefined, details: '' },
  });

  const selectedResult = watch('result');
  const isEditing = editingId !== null;

  useEffect(() => {
    if (!isOpen) {
      setEditingId(null);
      setIsCreatingNew(false);
      setStatusMessage(null);
      resetForm();
      resetCreate();
      resetUpdate();
      return;
    }

    if (!isCreatingNew && outcomes.length > 0 && editingId === null) {
      setEditingId(outcomes[0].id);
      resetForm(formValuesFromOutcome(outcomes[0]));
    } else if (outcomes.length === 0) {
      setEditingId(null);
      setIsCreatingNew(true);
      resetForm({ result: undefined, downtimeMinutes: undefined, details: '' });
    }
  }, [isOpen, outcomes, editingId, isCreatingNew, resetForm, resetCreate, resetUpdate]);

  useEffect(() => {
    if (isSuccess) {
      setStatusMessage(isEditing ? 'Outcome updated' : 'Outcome recorded');
      const timer = window.setTimeout(() => {
        setStatusMessage(null);
        resetCreate();
        resetUpdate();
        if (!isEditing) {
          setIsCreatingNew(true);
          setEditingId(null);
          resetForm({ result: undefined, downtimeMinutes: undefined, details: '' });
        }
      }, 1200);
      return () => clearTimeout(timer);
    }
  }, [isSuccess, isEditing, resetCreate, resetUpdate, resetForm]);

  useEffect(() => {
    if (!isOpen) return;
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const selectOutcome = (outcome: DeploymentOutcome) => {
    setIsCreatingNew(false);
    setEditingId(outcome.id);
    resetForm(formValuesFromOutcome(outcome));
    setStatusMessage(null);
  };

  const startNewOutcome = () => {
    setIsCreatingNew(true);
    setEditingId(null);
    resetForm({ result: undefined, downtimeMinutes: undefined, details: '' });
    setStatusMessage(null);
  };

  const onSubmit = async (data: OutcomeFormValues) => {
    const payload = {
      result: data.result,
      downtimeMinutes: data.result === 'downtime' ? data.downtimeMinutes : undefined,
      details: data.details || undefined,
    };

    if (editingId) {
      updateOutcome({ id: editingId, data: payload });
      return;
    }

    const deploymentId = await resolveDeploymentIdForRelease(releaseVersion);
    recordOutcome({
      deploymentId,
      releaseVersion,
      deployedAt,
      ...payload,
    });
  };

  const handleDelete = (id: string) => {
    if (!confirm('Delete this deployment outcome?')) return;

    deleteOutcome(id, {
      onSuccess: () => {
        if (editingId === id) {
          setEditingId(null);
          resetForm({ result: undefined, downtimeMinutes: undefined, details: '' });
        }
        setStatusMessage('Outcome deleted');
        window.setTimeout(() => setStatusMessage(null), 1200);
      },
    });
  };

  const resultStyleMap: Record<DeploymentResult, string> = {
    success: styles.resultOptionSuccess,
    downtime: styles.resultOptionDowntime,
    rollback: styles.resultOptionRollback,
  };

  return (
    <div className={styles.overlay} role="dialog" aria-label="Manage deployment outcome" onClick={onClose}>
      <div className={styles.card} onClick={(e) => e.stopPropagation()}>
        <h3 className={styles.title}>Deployment Outcome</h3>
        <p className={styles.subtitle}>
          Release <strong>{releaseVersion}</strong> · Production
        </p>

        {statusMessage && (
          <div className={styles.successMessage}>{statusMessage}</div>
        )}

        {isLoading ? (
          <p className={styles.loadingText}>Loading outcomes...</p>
        ) : (
          <>
            {outcomes.length > 0 && (
              <div className={styles.historySection}>
                <div className={styles.historyHeader}>
                  <span className={styles.historyTitle}>Recorded outcomes</span>
                  <button type="button" className={styles.btnNew} onClick={startNewOutcome}>
                    + Add new
                  </button>
                </div>
                <ul className={styles.historyList}>
                  {outcomes.map((outcome) => (
                    <li
                      key={outcome.id}
                      className={`${styles.historyItem} ${editingId === outcome.id ? styles.historyItemActive : ''}`}
                    >
                      <button
                        type="button"
                        className={styles.historyItemMain}
                        onClick={() => selectOutcome(outcome)}
                      >
                        <span className={`${styles.historyBadge} ${HISTORY_BADGE_CLASS[outcome.result]}`}>
                          {RESULT_LABELS[outcome.result]}
                        </span>
                        <span className={styles.historyDate}>
                          {new Date(outcome.reportedAt).toLocaleString()}
                        </span>
                        {outcome.details && (
                          <span className={styles.historyPreview}>{outcome.details}</span>
                        )}
                      </button>
                      <button
                        type="button"
                        className={styles.btnDeleteItem}
                        onClick={() => handleDelete(outcome.id)}
                        disabled={isDeleting}
                        title="Delete outcome"
                      >
                        Delete
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <form onSubmit={handleSubmit(onSubmit)} noValidate>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <p className={styles.formModeLabel}>
                  {isEditing ? 'Edit selected outcome' : 'Record new outcome'}
                </p>

                <div className={styles.fieldGroup}>
                  <span className={styles.label}>Result</span>
                  <div className={styles.resultOptions} role="radiogroup" aria-label="Deployment result">
                    {RESULT_OPTIONS.map((opt) => {
                      const isSelected = selectedResult === opt.value;
                      const optionClass = [
                        styles.resultOption,
                        resultStyleMap[opt.value],
                        isSelected ? styles.selected : '',
                      ].filter(Boolean).join(' ');
                      return (
                        <label key={opt.value} className={optionClass}>
                          <input
                            type="radio"
                            value={opt.value}
                            {...register('result')}
                            checked={isSelected}
                            onChange={() => setValue('result', opt.value, { shouldValidate: true })}
                          />
                          {opt.label}
                        </label>
                      );
                    })}
                  </div>
                  {errors.result && <p className={styles.errorText}>{errors.result.message || 'Result is required'}</p>}
                </div>

                {selectedResult === 'downtime' && (
                  <div className={styles.fieldGroup}>
                    <label className={styles.label} htmlFor="downtimeMinutes">
                      Downtime (minutes)
                    </label>
                    <input
                      id="downtimeMinutes"
                      type="number"
                      min={0}
                      className={styles.numberInput}
                      placeholder="e.g. 15"
                      {...register('downtimeMinutes', { setValueAs: (v: string) => v === '' ? undefined : Number(v) })}
                    />
                    {errors.downtimeMinutes && (
                      <p className={styles.errorText}>{errors.downtimeMinutes.message}</p>
                    )}
                  </div>
                )}

                <div className={styles.fieldGroup}>
                  <label className={styles.label} htmlFor="outcomeDetails">
                    Details (optional)
                  </label>
                  <textarea
                    id="outcomeDetails"
                    className={styles.textarea}
                    placeholder="What happened during the deployment..."
                    {...register('details')}
                  />
                </div>

                {mutationError && (
                  <p className={styles.formError}>{mutationError.message}</p>
                )}

                <div className={styles.actions}>
                  <button type="button" className={styles.btnCancel} onClick={onClose} disabled={isPending}>
                    Close
                  </button>
                  {isEditing && (
                    <button
                      type="button"
                      className={styles.btnDelete}
                      onClick={() => handleDelete(editingId)}
                      disabled={isPending}
                    >
                      Delete
                    </button>
                  )}
                  <button type="submit" className={styles.btnSubmit} disabled={isPending}>
                    {isPending ? 'Saving...' : isEditing ? 'Update Outcome' : 'Save Outcome'}
                  </button>
                </div>
              </div>
            </form>
          </>
        )}
      </div>
    </div>
  );
};
