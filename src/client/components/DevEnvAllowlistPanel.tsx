import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { isRestrictedAccessEmail } from '../../shared/types/restrictedAccess';
import type { DevEnvAllowlistEntry } from '../../shared/types/devEnvAllowlist';
import {
  useAddDevEnvAllowlistEntry,
  useDevEnvAllowlist,
  useRemoveDevEnvAllowlistEntry,
} from '../hooks/usePlatformAdmin';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import styles from './PlatformAdmin.module.css';

const schema = z.object({
  email: z.string().refine(isRestrictedAccessEmail, 'Enter a valid email address'),
});

type FormValues = z.infer<typeof schema>;

export const DevEnvAllowlistPanel: React.FC = () => {
  const [deleteTarget, setDeleteTarget] = useState<DevEnvAllowlistEntry | null>(null);
  const { register, handleSubmit, reset, formState: { errors } } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { email: '' },
  });
  const listQuery = useDevEnvAllowlist();
  const addEntry = useAddDevEnvAllowlistEntry();
  const removeEntry = useRemoveDevEnvAllowlistEntry();

  const entries = listQuery.data?.entries ?? [];
  const managesDevAccess = listQuery.data?.managesDevAccess ?? false;
  const pending = addEntry.isPending || removeEntry.isPending;
  const formError = addEntry.error?.message ?? removeEntry.error?.message ?? null;

  const onSubmit = async (values: FormValues) => {
    try {
      await addEntry.mutateAsync(values.email);
      reset();
    } catch {
      // The mutation error is shown above the form.
    }
  };

  return (
    <section className={styles.section} aria-labelledby="dev-access-title">
      <div className={styles.sectionHeader}>
        <div>
          <h2 id="dev-access-title" className={styles.sectionTitle}>Dev access</h2>
          <p className={styles.sectionHint}>
            People on this list can sign in to the dev site. Platform admins can always sign in
            and do not need to be added.
          </p>
        </div>
        <span className={styles.countBadge}>{entries.length} emails</span>
      </div>

      {!listQuery.isLoading && !managesDevAccess && (
        <p className={styles.sectionHint} role="status">
          This list only controls the dev site. Open Platform Admin there to add or remove people.
        </p>
      )}

      {(listQuery.isError || formError) && (
        <div className={styles.error} role="alert">
          {formError ?? listQuery.error?.message ?? 'Could not load the dev access list'}
        </div>
      )}

      <form
        className={styles.menuForm}
        onSubmit={(event) => void handleSubmit(onSubmit)(event)}
        {...{ 'data-testid': 'platform-admin-dev-access-form' }}
      >
        <h3 className={styles.cardTitle}>Add email</h3>
        <label className={styles.label} htmlFor="dev-access-email">
          Email
          <input
            id="dev-access-email"
            type="email"
            className={styles.input}
            disabled={pending || !managesDevAccess}
            placeholder="user@example.com"
            {...register('email')}
            {...{ 'data-testid': 'platform-admin-dev-access-email' }}
          />
        </label>
        {errors.email && <p className={styles.fieldError}>{errors.email.message}</p>}
        <div className={styles.formActions}>
          <button
            type="submit"
            className={styles.primaryButton}
            disabled={pending || !managesDevAccess}
            {...{ 'data-testid': 'platform-admin-dev-access-save' }}
          >
            {addEntry.isPending ? 'Saving…' : 'Add to dev access'}
          </button>
        </div>
      </form>

      {listQuery.isLoading ? (
        <p className={styles.muted}>Loading dev access list…</p>
      ) : entries.length === 0 ? (
        <p className={styles.muted}>No extra people have been approved for the dev site yet.</p>
      ) : (
        <div className={styles.userAccessList} role="list" aria-label="Dev access emails">
          {entries.map((entry) => (
            <article
              key={entry.id}
              className={styles.requestCard}
              role="listitem"
              {...{ 'data-testid': `platform-admin-dev-access-row-${entry.id}` }}
            >
              <div>
                <h3 className={styles.cardTitle}>{entry.email}</h3>
                <p className={styles.muted}>
                  {entry.createdBy ? `Added by ${entry.createdBy}` : 'Added by a platform admin'}
                </p>
              </div>
              <div className={styles.userAccessRowActions}>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  disabled={pending || !managesDevAccess}
                  onClick={() => setDeleteTarget(entry)}
                  {...{ 'data-testid': `platform-admin-dev-access-remove-${entry.id}` }}
                >
                  Remove
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      {deleteTarget && (
        <ConfirmDeleteModal
          {...{ 'data-testid': 'platform-admin-dev-access-delete-modal' }}
          title="Remove dev access"
          itemName={deleteTarget.email}
          description="They will not be able to sign in to the dev site after this."
          isPending={removeEntry.isPending}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => {
            void removeEntry.mutateAsync({ id: deleteTarget.id })
              .then(() => setDeleteTarget(null))
              .catch(() => {
                // The mutation error is shown above the form.
              });
          }}
        />
      )}
    </section>
  );
};
