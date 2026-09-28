import React, { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import type { CreateCabRequestFormValues } from '../utils/cabReleaseKickoff';
import { normalizeReleaseBranch } from '../utils/cabReleaseKickoff';
import styles from './CreateCabRequestModal.module.css';

const schema = z.object({
  previousReleaseBranch: z.string().min(1, 'Previous shipped release branch is required'),
  snowMode: z.enum(['dry-run', 'run']),
  cutReleaseBranch: z.boolean(),
});

type FormValues = z.infer<typeof schema>;

interface CreateCabRequestModalProps {
  targetVersion: string;
  defaultPreviousBranch: string;
  onCancel: () => void;
  onConfirm: (values: CreateCabRequestFormValues) => void;
  'data-testid'?: string;
}

export const CreateCabRequestModal: React.FC<CreateCabRequestModalProps> = ({
  targetVersion,
  defaultPreviousBranch,
  onCancel,
  onConfirm,
  'data-testid': dataTestId = 'create-cab-request-modal',
}) => {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      previousReleaseBranch: defaultPreviousBranch,
      snowMode: 'dry-run',
      cutReleaseBranch: false,
    },
  });

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onCancel]);

  const submit = (values: FormValues) => {
    onConfirm({
      previousReleaseBranch: normalizeReleaseBranch(values.previousReleaseBranch),
      snowMode: values.snowMode,
      cutReleaseBranch: values.cutReleaseBranch,
    });
  };

  return (
    <div
      className={styles.overlay}
      onClick={(event) => { if (event.target === event.currentTarget) onCancel(); }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-cab-request-title"
      {...{ 'data-testid': dataTestId }}
    >
      <form className={styles.card} onSubmit={handleSubmit(submit)} {...{ 'data-testid': 'create-cab-request-form' }}>
        <h2 className={styles.title} id="create-cab-request-title">Create CAB request</h2>
        <p className={styles.body}>
          Snow still gathers the release delta. Cutting <code>Release/{targetVersion}</code> from
          development is optional and happens only after a succeeded snow run.
        </p>

        <div className={styles.fieldGroup}>
          <span className={styles.label}>Target version</span>
          <span className={styles.readonly} {...{ 'data-testid': 'create-cab-target-version' }}>
            {targetVersion}
          </span>
        </div>

        <div className={styles.fieldGroup}>
          <label className={styles.label} htmlFor="create-cab-previous-branch">
            Previous shipped release branch
          </label>
          <input
            id="create-cab-previous-branch"
            className={`${styles.input} ${errors.previousReleaseBranch ? styles.inputError : ''}`.trim()}
            {...register('previousReleaseBranch')}
            {...{ 'data-testid': 'create-cab-previous-branch' }}
          />
          {errors.previousReleaseBranch && (
            <p className={styles.error}>{errors.previousReleaseBranch.message}</p>
          )}
        </div>

        <fieldset className={styles.fieldGroup}>
          <legend className={styles.label}>Snow mode</legend>
          <div className={styles.radioGroup}>
            <label className={styles.radioOption}>
              <input type="radio" value="dry-run" {...register('snowMode')} {...{ 'data-testid': 'create-cab-snow-dry-run' }} />
              Dry-run (QA snow, definition 670)
            </label>
            <label className={styles.radioOption}>
              <input type="radio" value="run" {...register('snowMode')} {...{ 'data-testid': 'create-cab-snow-run' }} />
              Run (prod snow, definition 595)
            </label>
          </div>
        </fieldset>

        <label className={styles.radioOption}>
          <input type="checkbox" {...register('cutReleaseBranch')} {...{ 'data-testid': 'create-cab-cut-branch' }} />
          After snow succeeds, cut Release/{targetVersion} from development
        </label>
        <p className={styles.hint}>Leave unchecked to file the CAB without creating the git branch.</p>

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.btnCancel}
            onClick={onCancel}
            {...{ 'data-testid': 'create-cab-cancel' }}
          >
            Cancel
          </button>
          <button
            type="submit"
            className={styles.btnConfirm}
            {...{ 'data-testid': 'create-cab-confirm' }}
          >
            Run cab-release
          </button>
        </div>
      </form>
    </div>
  );
};

export default CreateCabRequestModal;
