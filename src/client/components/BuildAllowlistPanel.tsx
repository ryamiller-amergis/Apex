import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import type { BuildAllowlistEntry } from '../../shared/types/buildAccess';
import {
  useAddBuildAllowlistEntry,
  useBuildAllowlist,
  useBuildAllowlistRepositories,
  usePlatformAdminProjects,
  useRemoveBuildAllowlistEntry,
} from '../hooks/usePlatformAdmin';
import { ConfirmDeleteModal } from './ConfirmDeleteModal';
import styles from './PlatformAdmin.module.css';

const schema = z.object({
  project: z.string().min(1, 'Choose a project'),
  repository: z.string().min(1, 'Choose a repository'),
});

type FormValues = z.infer<typeof schema>;

function pairLabel(entry: { project: string; repository: string }): string {
  return `${entry.project} / ${entry.repository}`;
}

export const BuildAllowlistPanel: React.FC = () => {
  const [deleteTarget, setDeleteTarget] = useState<BuildAllowlistEntry | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const { register, handleSubmit, reset, watch, setValue, formState: { errors } } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { project: '', repository: '' },
  });
  const selectedProject = watch('project');
  const listQuery = useBuildAllowlist();
  const projectsQuery = usePlatformAdminProjects();
  const reposQuery = useBuildAllowlistRepositories(selectedProject || null);
  const addEntry = useAddBuildAllowlistEntry();
  const removeEntry = useRemoveBuildAllowlistEntry();

  const entries = listQuery.data ?? [];
  const projects = projectsQuery.data ?? [];
  const repositories = reposQuery.data ?? [];
  const pending = addEntry.isPending || removeEntry.isPending;
  const formError = addEntry.error?.message ?? removeEntry.error?.message ?? null;
  const projectHasNoRepos = Boolean(selectedProject) && !reposQuery.isLoading && reposQuery.data?.length === 0;
  const repoDisabled = pending || !selectedProject || repositories.length === 0;

  const onSubmit = async (values: FormValues) => {
    setStatusMessage(null);
    try {
      const added = await addEntry.mutateAsync(values);
      setStatusMessage(`Added ${pairLabel(added ?? values)}`);
      reset();
    } catch {
      // The mutation error is shown above the form.
    }
  };

  return (
    <section className={styles.section} aria-labelledby="build-allowlist-title">
      <div className={styles.sectionHeader}>
        <div>
          <h2 id="build-allowlist-title" className={styles.sectionTitle}>Builds</h2>
          <p className={styles.sectionHint}>
            Builds can only start in the project and repository pairs on this list. Turn the whole
            flow on or off with the build-from-prompt flag in Feature Flags.
          </p>
        </div>
        <span className={styles.countBadge}>{entries.length} approved</span>
      </div>

      {(listQuery.isError || formError) && (
        <div className={styles.error} role="alert">
          {formError ?? listQuery.error?.message ?? 'Could not load approved repositories'}
        </div>
      )}

      <form
        className={styles.menuForm}
        onSubmit={(event) => void handleSubmit(onSubmit)(event)}
        {...{ 'data-testid': 'platform-admin-build-allowlist-form' }}
      >
        <h3 className={styles.cardTitle}>Approve a repository</h3>
        <label className={styles.label} htmlFor="build-allowlist-project">
          Project
          <select
            id="build-allowlist-project"
            className={styles.input}
            disabled={pending || projectsQuery.isLoading}
            {...register('project', {
              onChange: () => {
                setValue('repository', '');
                setStatusMessage(null);
              },
            })}
            {...{ 'data-testid': 'platform-admin-build-allowlist-project' }}
          >
            <option value="">Choose a project</option>
            {projects.map((project) => (
              <option key={project.id} value={project.name}>{project.name}</option>
            ))}
          </select>
        </label>
        {errors.project && <p className={styles.fieldError}>{errors.project.message}</p>}

        <label className={styles.label} htmlFor="build-allowlist-repository">
          Repository
          <select
            id="build-allowlist-repository"
            className={styles.input}
            disabled={repoDisabled}
            {...register('repository')}
            {...{ 'data-testid': 'platform-admin-build-allowlist-repository' }}
          >
            <option value="">Choose a repository</option>
            {repositories.map((repo) => (
              <option key={repo} value={repo}>{repo}</option>
            ))}
          </select>
        </label>
        {projectHasNoRepos && (
          <p className={styles.muted}>
            This project has no repository configured. Add one in Project Settings first.
          </p>
        )}
        {errors.repository && <p className={styles.fieldError}>{errors.repository.message}</p>}

        <div className={styles.formActions}>
          <button
            type="submit"
            className={styles.primaryButton}
            disabled={pending}
            {...{ 'data-testid': 'platform-admin-build-allowlist-save' }}
          >
            {addEntry.isPending ? 'Saving…' : 'Approve for builds'}
          </button>
        </div>
        {statusMessage && <p className={styles.success} role="status">{statusMessage}</p>}
      </form>

      {listQuery.isLoading ? (
        <p className={styles.muted}>Loading approved repositories…</p>
      ) : entries.length === 0 ? (
        <p className={styles.muted}>No repositories are approved for builds yet.</p>
      ) : (
        <div className={styles.userAccessList} role="list" aria-label="Approved repositories for builds">
          {entries.map((entry) => (
            <article
              key={entry.id}
              className={styles.requestCard}
              role="listitem"
              {...{ 'data-testid': `platform-admin-build-allowlist-row-${entry.id}` }}
            >
              <div>
                <h3 className={styles.cardTitle}>{pairLabel(entry)}</h3>
                <p className={styles.muted}>
                  {entry.createdBy ? `Approved by ${entry.createdBy}` : 'Approved by a platform admin'}
                </p>
              </div>
              <div className={styles.userAccessRowActions}>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  disabled={pending}
                  aria-label={`Remove ${pairLabel(entry)} from approved builds`}
                  onClick={() => setDeleteTarget(entry)}
                  {...{ 'data-testid': `platform-admin-build-allowlist-remove-${entry.id}` }}
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
          {...{ 'data-testid': 'platform-admin-build-allowlist-delete-modal' }}
          title="Remove approved repository"
          itemName={pairLabel(deleteTarget)}
          description="New builds in this repository will not start, and builds already running will stop at their next step. Remove"
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
