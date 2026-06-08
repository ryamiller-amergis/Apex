import React, { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import styles from './ReviewReasonModal.module.css';

const reasonSchema = z.object({
  reason: z.string().min(1, 'A reason is required'),
});

type FormValues = z.infer<typeof reasonSchema>;

interface ReviewReasonModalProps {
  title: string;
  placeholder?: string;
  confirmLabel?: string;
  isPending?: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}

export const ReviewReasonModal: React.FC<ReviewReasonModalProps> = ({
  title,
  placeholder = 'What needs to change?',
  confirmLabel = 'Confirm',
  isPending = false,
  onConfirm,
  onCancel,
}) => {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(reasonSchema),
    defaultValues: { reason: '' },
  });

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onCancel]);

  const onSubmit = (values: FormValues) => {
    onConfirm(values.reason);
  };

  return (
    <div
      className={styles.overlay}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="review-reason-title"
    >
      <form className={styles.card} onSubmit={handleSubmit(onSubmit)}>
        <h2 className={styles.title} id="review-reason-title">{title}</h2>

        <div className={styles.fieldGroup}>
          <textarea
            className={`${styles.textarea} ${errors.reason ? styles.textareaError : ''}`}
            rows={4}
            placeholder={placeholder}
            autoFocus
            {...register('reason')}
          />
          {errors.reason && (
            <span className={styles.errorMsg}>{errors.reason.message}</span>
          )}
        </div>

        <div className={styles.actions}>
          <button
            className={styles.btnCancel}
            onClick={onCancel}
            disabled={isPending}
            type="button"
          >
            Cancel
          </button>
          <button
            className={styles.btnConfirm}
            type="submit"
            disabled={isPending}
          >
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
};

export default ReviewReasonModal;
