import React, { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import styles from './PrdRevisionModal.module.css';

const schema = z.object({
  reason: z.string().min(1, 'Revision notes are required'),
});

type FormValues = z.infer<typeof schema>;

interface PrdRevisionModalProps {
  prdTitle: string;
  isPending: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}

export const PrdRevisionModal: React.FC<PrdRevisionModalProps> = ({
  prdTitle,
  isPending,
  onConfirm,
  onCancel,
}) => {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
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
      aria-labelledby="prd-revision-title"
    >
      <form className={styles.card} onSubmit={handleSubmit(onSubmit)}>
        <h2 className={styles.title} id="prd-revision-title">Request Revision</h2>

        <p className={styles.body}>
          Describe what needs to change in{' '}
          <span className={styles.prdName}>&ldquo;{prdTitle}&rdquo;</span>.
          This will be shown to the author.
        </p>

        <div className={styles.fieldGroup}>
          <textarea
            className={`${styles.textarea} ${errors.reason ? styles.textareaError : ''}`}
            rows={4}
            placeholder="What needs to change?"
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
            {isPending ? 'Submitting…' : 'Confirm'}
          </button>
        </div>
      </form>
    </div>
  );
};

export default PrdRevisionModal;
