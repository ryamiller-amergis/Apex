import React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { BRAINSTORM_CHECKPOINT_NAME_MAX_LENGTH } from '../../shared/types/brainstormArtifact';
import { BrainstormApiError } from '../hooks/useBrainstormSessions';
import { useLabelCheckpoint } from '../hooks/useBrainstormArtifact';
import styles from './BrainstormArtifactPanel.module.css';

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export const checkpointSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Enter a checkpoint name.')
    .max(BRAINSTORM_CHECKPOINT_NAME_MAX_LENGTH, `Use ${BRAINSTORM_CHECKPOINT_NAME_MAX_LENGTH} characters or fewer.`)
    .refine((value) => !CONTROL_CHARACTERS.test(value), 'Remove control characters from the name.'),
});

type CheckpointForm = z.infer<typeof checkpointSchema>;

const SERVER_MESSAGES: Record<string, string> = {
  CHECKPOINT_EXISTS: 'This version already has a name.',
  CHECKPOINT_NAME_TAKEN: 'Another version already uses this name.',
  ARTIFACT_VERSION_CONFLICT: 'The artifact changed. Review the current version, then try again.',
  INVALID_CHECKPOINT_NAME: `Use 1 to ${BRAINSTORM_CHECKPOINT_NAME_MAX_LENGTH} characters.`,
};

interface BrainstormCheckpointFieldProps {
  project: string;
  sessionId: string;
  version: number;
  checkpointName?: string | null;
  disabled?: boolean;
}

export const BrainstormCheckpointField: React.FC<BrainstormCheckpointFieldProps> = ({
  project,
  sessionId,
  version,
  checkpointName = null,
  disabled = false,
}) => {
  const label = useLabelCheckpoint(project, sessionId);
  const [savedName, setSavedName] = React.useState<string | null>(null);
  // data-testid-exempt — generic type argument, not an element
  const form = useForm<CheckpointForm>({ resolver: zodResolver(checkpointSchema), defaultValues: { name: '' } });
  const { register, handleSubmit, reset, setError, formState: { errors } } = form;

  React.useEffect(() => {
    setSavedName(null);
  }, [version]);

  const effectiveName = savedName ?? checkpointName;
  if (effectiveName) {
    return (
      <div className={styles.checkpointSaved} {...{ 'data-testid': 'brainstorm-checkpoint-saved' }}>
        <span className={styles.fieldLabel}>Version {version} checkpoint:</span>
        <span className={styles.checkpointBadge}>{effectiveName}</span>
      </div>
    );
  }

  const onSubmit = handleSubmit(async ({ name }) => {
    try {
      const trimmed = name.trim();
      await label.mutateAsync({ name: trimmed, expectedVersion: version });
      setSavedName(trimmed);
      reset({ name: '' });
    } catch (err) {
      const code = err instanceof BrainstormApiError ? err.code : null;
      setError('name', { message: (code && SERVER_MESSAGES[code]) || 'We could not save the checkpoint. Try again.' });
    }
  });

  const inputId = `brainstorm-checkpoint-${sessionId}`;
  const errorId = `${inputId}-error`;
  const busy = disabled || label.isPending;

  return (
    <form
      className={styles.checkpoint}
      onSubmit={(event) => { void onSubmit(event); }}
      noValidate
      {...{ 'data-testid': 'brainstorm-checkpoint-form' }}
    >
      <label htmlFor={inputId} className={styles.fieldLabel}>
        Bookmark version {version} (optional — name this draft so you can find or restore it in History)
      </label>
      <div className={styles.checkpointRow}>
        <input
          id={inputId}
          className={styles.input}
          maxLength={BRAINSTORM_CHECKPOINT_NAME_MAX_LENGTH + 20}
          placeholder="e.g., Initial draft, Before scope cut…"
          disabled={busy}
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={errors.name ? errorId : undefined}
          {...register('name')}
          {...{ 'data-testid': 'brainstorm-checkpoint-input' }}
        />
        <button type="submit" className={styles.button} disabled={busy} {...{ 'data-testid': 'brainstorm-checkpoint-save' }}>
          {label.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>
      {errors.name?.message && (
        <p id={errorId} className={styles.fieldError} role="alert">
          {errors.name.message}
        </p>
      )}
    </form>
  );
};
