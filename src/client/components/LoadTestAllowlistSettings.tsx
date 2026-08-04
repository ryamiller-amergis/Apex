import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import type { LoadTestTarget } from '../../shared/types/loadTest';
import {
  LoadTestTargetApiError,
  useCreateLoadTestTarget,
  useDeleteLoadTestTarget,
  useLoadTestTargets,
  useUpdateLoadTestTarget,
} from '../hooks/useLoadTestTargets';
import styles from './LoadTestAllowlistSettings.module.css';

interface LoadTestAllowlistSettingsProps {
  selectedProject: string;
}

const formSchema = z.object({
  baseUrl: z.string().min(1, 'Base URL is required'),
  environmentLabel: z.string().min(1, 'Environment label is required'),
  isReachable: z.boolean(),
  isActive: z.boolean(),
});

type FormValues = z.infer<typeof formSchema>;

export const LoadTestAllowlistSettings: React.FC<LoadTestAllowlistSettingsProps> = ({
  selectedProject,
}) => {
  const [formError, setFormError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const { data: items = [], isLoading, isError, refetch } = useLoadTestTargets(selectedProject, {
    includeInactive: true,
  });
  const createMutation = useCreateLoadTestTarget(selectedProject);
  const updateMutation = useUpdateLoadTestTarget(selectedProject);
  const deleteMutation = useDeleteLoadTestTarget(selectedProject);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      baseUrl: '',
      environmentLabel: '',
      isReachable: true,
      isActive: true,
    },
  });

  const onSubmit = async (values: FormValues) => {
    setFormError(null);
    try {
      if (editingId) {
        await updateMutation.mutateAsync({
          targetId: editingId,
          input: {
            baseUrl: values.baseUrl,
            environmentLabel: values.environmentLabel,
            isReachable: values.isReachable,
            isActive: values.isActive,
          },
        });
      } else {
        await createMutation.mutateAsync({
          baseUrl: values.baseUrl,
          environmentLabel: values.environmentLabel,
          isReachable: values.isReachable,
          isActive: values.isActive,
        });
      }
      setEditingId(null);
      reset({
        baseUrl: '',
        environmentLabel: '',
        isReachable: true,
        isActive: true,
      });
    } catch (err) {
      if (err instanceof LoadTestTargetApiError) {
        setFormError(err.message);
      } else {
        setFormError('Failed to save allowlist entry');
      }
    }
  };

  const startEdit = (item: LoadTestTarget) => {
    setEditingId(item.id);
    setFormError(null);
    reset({
      baseUrl: item.baseUrl,
      environmentLabel: item.environmentLabel,
      isReachable: item.isReachable,
      isActive: item.isActive,
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setFormError(null);
    reset({
      baseUrl: '',
      environmentLabel: '',
      isReachable: true,
      isActive: true,
    });
  };

  const handleDelete = async (id: string) => {
    setFormError(null);
    try {
      await deleteMutation.mutateAsync(id);
      if (editingId === id) cancelEdit();
    } catch (err) {
      if (err instanceof LoadTestTargetApiError) {
        setFormError(err.message);
      } else {
        setFormError('Failed to delete allowlist entry');
      }
    }
  };

  return (
    <div className={styles.page} data-testid="load-test-allowlist-page">
      <header className={styles.header}>
        <h2 className={styles.title}>Load test target allowlist</h2>
        <p className={styles.description}>
          Approve non-production base URLs authors may target. Production hosts and labels are
          refused. The reachable flag is manual — Apex does not probe network reachability.
        </p>
      </header>

      <form
        className={styles.form}
        data-testid="load-test-allowlist-form"
        onSubmit={handleSubmit(onSubmit)}
        noValidate
      >
        <div className={styles.field}>
          <label htmlFor="load-test-allowlist-base-url">Base URL</label>
          <input
            id="load-test-allowlist-base-url"
            data-testid="load-test-allowlist-base-url"
            type="url"
            placeholder="https://api.staging.example.com"
            aria-invalid={errors.baseUrl ? true : undefined}
            {...register('baseUrl')}
          />
          {errors.baseUrl && (
            <span className={styles.fieldError}>{errors.baseUrl.message}</span>
          )}
        </div>

        <div className={styles.field}>
          <label htmlFor="load-test-allowlist-environment">Environment</label>
          <input
            id="load-test-allowlist-environment"
            data-testid="load-test-allowlist-environment"
            type="text"
            placeholder="staging"
            aria-invalid={errors.environmentLabel ? true : undefined}
            {...register('environmentLabel')}
          />
          {errors.environmentLabel && (
            <span className={styles.fieldError}>{errors.environmentLabel.message}</span>
          )}
        </div>

        <div className={styles.checkRow}>
          <label className={styles.checkLabel}>
            <input
              type="checkbox"
              data-testid="load-test-allowlist-reachable"
              {...register('isReachable')}
            />
            Reachable (manual)
          </label>
          <label className={styles.checkLabel}>
            <input type="checkbox" {...register('isActive')} />
            Active
          </label>
        </div>

        {formError && (
          <div className={styles.alert} role="alert">
            {formError}
          </div>
        )}

        <div className={styles.actions}>
          <button
            type="submit"
            className={styles.primaryBtn}
            data-testid="load-test-allowlist-submit"
            disabled={isSubmitting || createMutation.isPending || updateMutation.isPending}
          >
            {editingId ? 'Update entry' : 'Add entry'}
          </button>
          {editingId && (
            <button type="button" className={styles.secondaryBtn} onClick={cancelEdit}>
              Cancel
            </button>
          )}
        </div>
      </form>

      <section className={styles.tableSection} aria-labelledby="allowlist-table-heading">
        <h3 id="allowlist-table-heading" className={styles.tableHeading}>
          Allowed targets
        </h3>

        {isLoading && <div className={styles.skeleton}>Loading allowlist…</div>}

        {isError && (
          <div className={styles.alert} role="alert">
            Failed to load allowlist.{' '}
            <button type="button" className={styles.linkBtn} onClick={() => refetch()}>
              Retry
            </button>
          </div>
        )}

        {!isLoading && !isError && items.length === 0 && (
          <p className={styles.empty}>
            No allowed targets yet — add a non-prod base URL to let authors run load tests.
          </p>
        )}

        {!isLoading && items.length > 0 && (
          <div className={styles.tableWrap}>
            <table className={styles.table} data-testid="load-test-allowlist-table">
              <thead>
                <tr>
                  <th scope="col">Environment</th>
                  <th scope="col">Base URL</th>
                  <th scope="col">Reachable</th>
                  <th scope="col">Active</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>{item.environmentLabel}</td>
                    <td className={styles.urlCell}>{item.baseUrl}</td>
                    <td>{item.isReachable ? 'Yes' : 'No'}</td>
                    <td>{item.isActive ? 'Yes' : 'No'}</td>
                    <td>
                      <div className={styles.rowActions}>
                        <button
                          type="button"
                          className={styles.secondaryBtn}
                          onClick={() => startEdit(item)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className={styles.dangerBtn}
                          data-testid="load-test-allowlist-delete"
                          onClick={() => handleDelete(item.id)}
                          disabled={deleteMutation.isPending}
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
};

export default LoadTestAllowlistSettings;
