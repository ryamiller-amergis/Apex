import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import {
  API_KEY_CADENCES,
  DEFAULT_API_KEY_CADENCE,
  type ApiKeyCadence,
  type ApiKeyScope,
} from '../../shared/types/apiKey';
import { ApiKeyApiError, useCreateApiKey } from '../hooks/useApiKeys';
import { ApiKeySecretReveal } from './ApiKeySecretReveal';
import {
  API_KEY_CADENCE_OPTIONS,
  API_KEY_EXPIRY_NOTIFICATION_HINT,
  API_KEY_SCOPE_OPTIONS,
  API_KEY_SCOPES_FIELD_HINT,
} from './apiKeyUi';
import styles from './CreateApiKeyModal.module.css';

const createSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name is required')
    .max(100, 'Name must be 100 characters or fewer'),
  cadence: z.enum(API_KEY_CADENCES as unknown as [ApiKeyCadence, ...ApiKeyCadence[]]),
  scopes: z.array(z.string()),
});

type FormValues = z.infer<typeof createSchema>;

export interface CreateApiKeyModalProps {
  projectId: string;
  onClose: () => void;
  'data-testid'?: string;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export const CreateApiKeyModal: React.FC<CreateApiKeyModalProps> = ({
  projectId,
  onClose,
  'data-testid': dataTestId = 'api-key-create-modal',
}) => {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const [rawKey, setRawKey] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const createMutation = useCreateApiKey(projectId);

  const {
    register,
    handleSubmit,
    setError,
    watch,
    setValue,
    formState: { errors },
  } = useForm<FormValues>({
    resolver: zodResolver(createSchema),
    defaultValues: {
      name: '',
      cadence: DEFAULT_API_KEY_CADENCE,
      scopes: [],
    },
  });

  const selectedScopes = watch('scopes') ?? [];

  const toggleScope = (scope: ApiKeyScope, checked: boolean) => {
    const next = checked
      ? [...selectedScopes, scope]
      : selectedScopes.filter((s) => s !== scope);
    setValue('scopes', next, { shouldDirty: true });
  };

  const handleClose = useCallback(() => {
    if (createMutation.isPending) return;
    onClose();
  }, [createMutation.isPending, onClose]);

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const first = dialog?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    first?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleClose();
        return;
      }
      if (e.key !== 'Tab' || !dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => !el.hasAttribute('disabled') && el.tabIndex !== -1);
      if (focusable.length === 0) return;
      const firstEl = focusable[0];
      const lastEl = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previouslyFocused.current?.focus();
    };
  }, [handleClose, rawKey]);

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      const result = await createMutation.mutateAsync({
        name: values.name.trim(),
        cadence: values.cadence,
        scopes: values.scopes as ApiKeyScope[],
      });
      setRawKey(result.rawKey);
    } catch (err) {
      if (err instanceof ApiKeyApiError) {
        if (err.code === 'NAME_TAKEN') {
          setError('name', { type: 'server', message: err.message || 'A key with this name already exists' });
          return;
        }
        if (err.code === 'VALIDATION') {
          setError('name', { type: 'server', message: err.message || 'Invalid name or cadence' });
          return;
        }
        setFormError(err.message);
        return;
      }
      setFormError(err instanceof Error ? err.message : 'Failed to create API key');
    }
  });

  return (
    <div
      className={styles.overlay}
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
      role="presentation"
      {...{ 'data-testid': 'api-key-create-overlay' }}
    >
      <div
        ref={dialogRef}
        className={styles.card}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        {...{ 'data-testid': dataTestId }}
      >
        <div className={styles.header}>
          <h2 id={titleId} className={styles.title}>
            {rawKey ? 'API key created' : 'Create API key'}
          </h2>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={handleClose}
            aria-label="Close"
            {...{ 'data-testid': 'api-key-create-close' }}
          >
            ×
          </button>
        </div>

        {rawKey ? (
          <div className={styles.revealStep}>
            <ApiKeySecretReveal rawKey={rawKey} />
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.primaryBtn}
                onClick={handleClose}
                {...{ 'data-testid': 'api-key-create-done' }}
              >
                Done
              </button>
            </div>
          </div>
        ) : (
          <form
            className={styles.form}
            onSubmit={(e) => {
              void onSubmit(e);
            }}
            noValidate
            {...{ 'data-testid': 'api-key-create-form' }}
          >
            <label className={styles.field}>
              <span className={styles.label}>Name</span>
              <input
                type="text"
                className={styles.input}
                maxLength={100}
                autoComplete="off"
                aria-invalid={Boolean(errors.name)}
                aria-describedby={errors.name ? 'api-key-name-error' : undefined}
                {...register('name')}
                {...{ 'data-testid': 'api-key-create-name' }}
              />
              {errors.name && (
                <span
                  id="api-key-name-error"
                  className={styles.fieldError}
                  role="alert"
                  {...{ 'data-testid': 'api-key-create-name-error' }}
                >
                  {errors.name.message}
                </span>
              )}
            </label>

            <label className={styles.field}>
              <span className={styles.label}>Expiration cadence</span>
              <select
                className={styles.select}
                aria-invalid={Boolean(errors.cadence)}
                aria-describedby="api-key-create-cadence-hint"
                {...register('cadence')}
                {...{ 'data-testid': 'api-key-create-cadence' }}
              >
                {API_KEY_CADENCE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <span
                id="api-key-create-cadence-hint"
                className={styles.fieldHint}
                {...{ 'data-testid': 'api-key-expiry-notification-hint' }}
              >
                {API_KEY_EXPIRY_NOTIFICATION_HINT}
              </span>
              {errors.cadence && (
                <span className={styles.fieldError} role="alert">
                  {errors.cadence.message}
                </span>
              )}
            </label>

            <fieldset className={styles.field} {...{ 'data-testid': 'api-key-create-scopes' }}>
              <legend className={styles.label}>API scopes</legend>
              <p id="api-key-create-scopes-hint" className={styles.fieldHint}>
                {API_KEY_SCOPES_FIELD_HINT}
              </p>
              <div className={styles.scopeList} role="group" aria-describedby="api-key-create-scopes-hint">
                {API_KEY_SCOPE_OPTIONS.map((opt) => {
                  const checked = selectedScopes.includes(opt.value);
                  return (
                    <label key={opt.value} className={styles.scopeOption}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => toggleScope(opt.value, e.target.checked)}
                        {...{ 'data-testid': `api-key-create-scope-${opt.value.replace(/:/g, '-')}` }}
                      />
                      <span className={styles.scopeText}>
                        <span className={styles.scopeLabel}>{opt.label}</span>
                        <span className={styles.scopeHint}>{opt.hint}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            {formError && (
              <p className={styles.formError} role="alert" aria-live="assertive">
                {formError}
              </p>
            )}

            <div className={styles.actions}>
              <button
                type="button"
                className={styles.secondaryBtn}
                onClick={handleClose}
                disabled={createMutation.isPending}
                {...{ 'data-testid': 'api-key-create-cancel' }}
              >
                Cancel
              </button>
              <button
                type="submit"
                className={styles.primaryBtn}
                disabled={createMutation.isPending}
                {...{ 'data-testid': 'api-key-create-submit' }}
              >
                {createMutation.isPending ? 'Creating…' : 'Create'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};

export default CreateApiKeyModal;
