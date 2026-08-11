import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import {
  API_KEY_CADENCES,
  type ApiKeyCadence,
  type ApiKeyMetadata,
  type ApiKeyScope,
} from '../../shared/types/apiKey';
import {
  ApiKeyApiError,
  useDeleteApiKey,
  useRegenerateApiKey,
  useUpdateApiKey,
} from '../hooks/useApiKeys';
import { ApiKeySecretReveal } from './ApiKeySecretReveal';
import {
  API_KEY_CADENCE_OPTIONS,
  API_KEY_EXPIRY_NOTIFICATION_HINT,
  API_KEY_SCOPE_OPTIONS,
  API_KEY_SCOPES_FIELD_HINT,
} from './apiKeyUi';
import styles from './ApiKeyManageDrawer.module.css';

const MIN_WIDTH = 320;
const MAX_WIDTH = 720;
const DEFAULT_WIDTH = 420;
const RESIZE_STEP = 24;

const editSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Name is required')
    .max(100, 'Name must be 100 characters or fewer'),
  cadence: z.enum(API_KEY_CADENCES as unknown as [ApiKeyCadence, ...ApiKeyCadence[]]),
  scopes: z.array(z.string()),
});

type FormValues = z.infer<typeof editSchema>;

export interface ApiKeyManageDrawerProps {
  projectId: string;
  apiKey: ApiKeyMetadata;
  onClose: () => void;
  onDeleted?: () => void;
  'data-testid'?: string;
}

interface RegenerateSecretBannerProps {
  rawKey: string;
  onDismiss: () => void;
  'data-testid'?: string;
}

const RegenerateSecretBanner: React.FC<RegenerateSecretBannerProps> = ({
  rawKey,
  onDismiss,
  'data-testid': dataTestId = 'api-key-regenerate-banner',
}) => (
  <div
    className={styles.banner}
    role="region"
    aria-label="Regenerated API key"
    {...{ 'data-testid': dataTestId }}
  >
    <div className={styles.bannerHeader}>
      <p className={styles.bannerTitle}>New key generated</p>
      <button
        type="button"
        className={styles.bannerDismiss}
        onClick={onDismiss}
        aria-label="Dismiss regenerated key"
        {...{ 'data-testid': 'api-key-regenerate-banner-dismiss' }}
      >
        Dismiss
      </button>
    </div>
    <ApiKeySecretReveal rawKey={rawKey} />
  </div>
);

interface DeleteConfirmProps {
  keyName: string;
  isPending: boolean;
  errorMessage: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

const DeleteApiKeyConfirm: React.FC<DeleteConfirmProps> = ({
  keyName,
  isPending,
  errorMessage,
  onConfirm,
  onCancel,
}) => {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      className={styles.confirmOverlay}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={titleId}
      {...{ 'data-testid': 'api-key-delete-confirm' }}
    >
      <div className={styles.confirmCard}>
        <h3 id={titleId} className={styles.confirmTitle}>
          Delete API key?
        </h3>
        <p className={styles.confirmBody}>
          Delete <strong>{keyName}</strong>? Applications using this key will
          stop authenticating immediately. This cannot be undone.
        </p>
        {errorMessage && (
          <p className={styles.error} role="alert" aria-live="assertive">
            {errorMessage}
          </p>
        )}
        <div className={styles.confirmActions}>
          <button
            ref={cancelRef}
            type="button"
            className={styles.secondaryBtn}
            onClick={onCancel}
            disabled={isPending}
            {...{ 'data-testid': 'api-key-delete-cancel' }}
          >
            Cancel
          </button>
          <button
            type="button"
            className={styles.dangerBtn}
            onClick={onConfirm}
            disabled={isPending}
            {...{ 'data-testid': 'api-key-delete-confirm-submit' }}
          >
            {isPending ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
};

export const ApiKeyManageDrawer: React.FC<ApiKeyManageDrawerProps> = ({
  projectId,
  apiKey,
  onClose,
  onDeleted,
  'data-testid': dataTestId = 'api-key-manage-drawer',
}) => {
  const titleId = useId();
  const drawerRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const [panelWidth, setPanelWidth] = useState(DEFAULT_WIDTH);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartXRef = useRef(0);
  const dragStartWidthRef = useRef(DEFAULT_WIDTH);

  const [liveMessage, setLiveMessage] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [regeneratedRawKey, setRegeneratedRawKey] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const updateMutation = useUpdateApiKey(projectId);
  const regenerateMutation = useRegenerateApiKey(projectId);
  const deleteMutation = useDeleteApiKey(projectId);

  const {
    register,
    handleSubmit,
    reset,
    setError,
    watch,
    setValue,
    formState: { errors, isDirty },
  } = useForm<FormValues>({
    resolver: zodResolver(editSchema),
    defaultValues: {
      name: apiKey.name,
      cadence: apiKey.cadence,
      scopes: apiKey.scopes ?? [],
    },
  });

  const selectedScopes = watch('scopes') ?? [];

  const toggleScope = (scope: ApiKeyScope, checked: boolean) => {
    const next = checked
      ? [...selectedScopes, scope]
      : selectedScopes.filter((s) => s !== scope);
    setValue('scopes', next, { shouldDirty: true });
  };

  useEffect(() => {
    reset({ name: apiKey.name, cadence: apiKey.cadence, scopes: apiKey.scopes ?? [] });
  }, [apiKey.id, apiKey.name, apiKey.cadence, apiKey.scopes, reset]);

  const cancelDelete = useCallback(() => {
    setConfirmDelete(false);
    setDeleteError(null);
  }, []);

  const handleResizeMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragStartXRef.current = e.clientX;
      dragStartWidthRef.current = panelWidth;
      setIsDragging(true);
    },
    [panelWidth],
  );

  const handleResizeKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setPanelWidth((w) => Math.min(MAX_WIDTH, w + RESIZE_STEP));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        setPanelWidth((w) => Math.max(MIN_WIDTH, w - RESIZE_STEP));
      } else if (e.key === 'Home') {
        e.preventDefault();
        setPanelWidth(MAX_WIDTH);
      } else if (e.key === 'End') {
        e.preventDefault();
        setPanelWidth(MIN_WIDTH);
      }
    },
    [],
  );

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    drawerRef.current?.focus();
    return () => {
      previouslyFocused.current?.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !confirmDelete) {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose, confirmDelete]);

  useEffect(() => {
    if (!isDragging) return;
    const onMouseMove = (e: MouseEvent) => {
      const delta = dragStartXRef.current - e.clientX;
      const next = Math.min(
        MAX_WIDTH,
        Math.max(MIN_WIDTH, dragStartWidthRef.current + delta),
      );
      setPanelWidth(next);
    };
    const onMouseUp = () => setIsDragging(false);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, [isDragging]);

  const onSave = handleSubmit(async (values) => {
    setFormError(null);
    setLiveMessage('');
    try {
      await updateMutation.mutateAsync({
        id: apiKey.id,
        input: {
          name: values.name.trim(),
          cadence: values.cadence,
          scopes: values.scopes as ApiKeyScope[],
        },
      });
      setLiveMessage('API key saved');
      reset({
        name: values.name.trim(),
        cadence: values.cadence,
        scopes: values.scopes,
      });
    } catch (err) {
      if (err instanceof ApiKeyApiError) {
        if (err.code === 'NAME_TAKEN') {
          setError('name', {
            type: 'server',
            message: err.message || 'A key with this name already exists',
          });
          setLiveMessage(err.message || 'A key with this name already exists');
          return;
        }
        if (err.code === 'VALIDATION') {
          setError('name', {
            type: 'server',
            message: err.message || 'Invalid name or cadence',
          });
          setLiveMessage(err.message || 'Invalid name or cadence');
          return;
        }
        setFormError(err.message);
        setLiveMessage(err.message);
        return;
      }
      const msg = err instanceof Error ? err.message : 'Failed to save API key';
      setFormError(msg);
      setLiveMessage(msg);
    }
  });

  const handleRegenerate = async () => {
    setFormError(null);
    setLiveMessage('');
    try {
      const result = await regenerateMutation.mutateAsync({ id: apiKey.id });
      setRegeneratedRawKey(result.rawKey);
      setLiveMessage('API key regenerated');
    } catch (err) {
      const msg =
        err instanceof ApiKeyApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Failed to regenerate API key';
      setFormError(msg);
      setLiveMessage(msg);
    }
  };

  const handleDeleteConfirm = async () => {
    setDeleteError(null);
    setLiveMessage('');
    try {
      await deleteMutation.mutateAsync({ id: apiKey.id });
      setLiveMessage('API key deleted');
      setConfirmDelete(false);
      onDeleted?.();
      onClose();
    } catch (err) {
      const msg =
        err instanceof ApiKeyApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Failed to delete API key';
      setDeleteError(msg);
      setLiveMessage(msg);
    }
  };

  return (
    <>
      <div
        className={styles.backdrop}
        onClick={onClose}
        aria-hidden="true"
        {...{ 'data-testid': 'api-key-manage-backdrop' }}
      />
      <div
        ref={drawerRef}
        className={styles.drawer}
        style={{ width: panelWidth }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        {...{ 'data-testid': dataTestId }}
      >
        {/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex -- WAI-ARIA separator resize must be focusable */}
        <div
          className={`${styles.resizeHandle}${isDragging ? ` ${styles.resizeHandleDragging}` : ''}`}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize drawer"
          aria-valuemin={MIN_WIDTH}
          aria-valuemax={MAX_WIDTH}
          aria-valuenow={panelWidth}
          tabIndex={0}
          onMouseDown={handleResizeMouseDown}
          onKeyDown={handleResizeKeyDown}
          {...{ 'data-testid': 'api-key-manage-resize' }}
        />
        {/* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}

        <div className={styles.header}>
          <div>
            <h2 id={titleId} className={styles.title}>
              Manage API key
            </h2>
            <p className={styles.meta}>
              {apiKey.shortId} · {apiKey.maskedPrefix}
            </p>
          </div>
          <button
            type="button"
            className={styles.closeBtn}
            onClick={onClose}
            aria-label="Close"
            {...{ 'data-testid': 'api-key-manage-close' }}
          >
            ×
          </button>
        </div>

        <div className={styles.body}>
          {regeneratedRawKey && (
            <RegenerateSecretBanner
              rawKey={regeneratedRawKey}
              onDismiss={() => setRegeneratedRawKey(null)}
              {...{ 'data-testid': 'api-key-regenerate-banner' }}
            />
          )}

          <form
            className={styles.form}
            onSubmit={(e) => {
              void onSave(e);
            }}
            noValidate
            {...{ 'data-testid': 'api-key-manage-form' }}
          >
            <label className={styles.field}>
              <span className={styles.label}>Name</span>
              <input
                type="text"
                className={styles.input}
                maxLength={100}
                autoComplete="off"
                aria-invalid={Boolean(errors.name)}
                {...register('name')}
                {...{ 'data-testid': 'api-key-manage-name' }}
              />
              {errors.name && (
                <span className={styles.fieldError} role="alert">
                  {errors.name.message}
                </span>
              )}
            </label>

            <label className={styles.field}>
              <span className={styles.label}>Expiration cadence</span>
              <select
                className={styles.select}
                aria-describedby="api-key-manage-cadence-hint"
                {...register('cadence')}
                {...{ 'data-testid': 'api-key-manage-cadence' }}
              >
                {API_KEY_CADENCE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <span
                id="api-key-manage-cadence-hint"
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

            <fieldset className={styles.field} {...{ 'data-testid': 'api-key-manage-scopes' }}>
              <legend className={styles.label}>API scopes</legend>
              <p id="api-key-manage-scopes-hint" className={styles.fieldHint}>
                {API_KEY_SCOPES_FIELD_HINT}
              </p>
              <div className={styles.scopeList} role="group" aria-describedby="api-key-manage-scopes-hint">
                {API_KEY_SCOPE_OPTIONS.map((opt) => {
                  const checked = selectedScopes.includes(opt.value);
                  return (
                    <label key={opt.value} className={styles.scopeOption}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => toggleScope(opt.value, e.target.checked)}
                        {...{ 'data-testid': `api-key-manage-scope-${opt.value.replace(/:/g, '-')}` }}
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
              <p className={styles.error} role="alert">
                {formError}
              </p>
            )}

            <div className={styles.formActions}>
              <button
                type="submit"
                className={styles.primaryBtn}
                disabled={updateMutation.isPending || !isDirty}
                {...{ 'data-testid': 'api-key-manage-save' }}
              >
                {updateMutation.isPending ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>

          <div className={styles.dangerZone}>
            <button
              type="button"
              className={styles.secondaryBtn}
              onClick={() => {
                void handleRegenerate();
              }}
              disabled={regenerateMutation.isPending}
              {...{ 'data-testid': 'api-key-regenerate' }}
            >
              {regenerateMutation.isPending ? 'Regenerating…' : 'Regenerate'}
            </button>
            <button
              type="button"
              className={styles.dangerBtn}
              onClick={() => {
                setDeleteError(null);
                setConfirmDelete(true);
              }}
              disabled={deleteMutation.isPending}
              {...{ 'data-testid': 'api-key-delete' }}
            >
              Delete
            </button>
          </div>
        </div>

        <div className={styles.liveRegion} aria-live="polite" aria-atomic="true">
          {liveMessage}
        </div>
      </div>

      {confirmDelete && (
        <DeleteApiKeyConfirm
          keyName={apiKey.name}
          isPending={deleteMutation.isPending}
          errorMessage={deleteError}
          onCancel={cancelDelete}
          onConfirm={() => {
            void handleDeleteConfirm();
          }}
        />
      )}
    </>
  );
};

export default ApiKeyManageDrawer;
