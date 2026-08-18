import React, { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { zodResolver } from '@hookform/resolvers/zod';
import type { ApexDeploymentEnvironment } from '../../shared/types/apexWorkItem';
import { useAppShell } from '../hooks/useAppShell';
import {
  useApexDeployments,
  useApexReleases,
  useRecordApexDeployment,
} from '../hooks/useApexWorkItems';
import styles from './BoardReleaseView.module.css';

const ENV_LABEL: Record<ApexDeploymentEnvironment, string> = {
  dev: 'Dev',
  staging: 'Staging',
  prod: 'Production',
};

const recordSchema = z.object({
  environment: z.enum(['dev', 'staging', 'prod']),
  version: z.string().min(1, 'Version is required'),
  releaseId: z.string().optional(),
  notes: z.string().optional(),
});

type RecordFormValues = z.infer<typeof recordSchema>;

interface BoardReleaseViewProps {
  project: string;
}

export const BoardReleaseView: React.FC<BoardReleaseViewProps> = ({ project }) => {
  const { can } = useAppShell();
  const canManage = can('work-board:manage');
  const { data: releases, isLoading: releasesLoading, error: releasesError } = useApexReleases(project);
  const { data: deployments, isLoading: deploymentsLoading, error: deploymentsError } =
    useApexDeployments(project);
  const recordDeployment = useRecordApexDeployment(project);
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<RecordFormValues>({
    resolver: zodResolver(recordSchema),
    defaultValues: {
      environment: 'dev',
      version: '',
      releaseId: '',
      notes: '',
    },
  });

  const sortedDeployments = useMemo(() => {
    if (!deployments) return [];
    return [...deployments].sort(
      (a, b) => new Date(b.deployedAt).getTime() - new Date(a.deployedAt).getTime(),
    );
  }, [deployments]);

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await recordDeployment.mutateAsync({
        environment: values.environment,
        version: values.version.trim(),
        releaseId: values.releaseId || null,
        notes: values.notes?.trim() || null,
      });
      reset({ environment: values.environment, version: '', releaseId: '', notes: '' });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to record deployment');
    }
  });

  return (
    <div className={styles.container} {...{ 'data-testid': 'board-release-view' }}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Releases</h1>
          <p className={styles.subtitle}>
            Board releases and deployment history for {project}
          </p>
        </div>
      </div>

      <div className={styles.grid}>
        <section className={styles.panel} aria-labelledby="board-releases-heading">
          <h2 id="board-releases-heading">Releases</h2>
          {releasesLoading ? (
            <div className={styles.empty}>Loading releases…</div>
          ) : releasesError ? (
            <div className={styles.error}>{releasesError.message}</div>
          ) : !releases?.length ? (
            <div className={styles.empty}>No releases yet. Create one from the Work Board.</div>
          ) : (
            <div className={styles.list}>
              {releases.map((release) => {
                const total = release.itemCount ?? 0;
                const done = release.doneCount ?? 0;
                return (
                  <div key={release.id} className={styles.row}>
                    <div className={styles.rowMain}>
                      <span className={styles.rowTitle}>{release.name}</span>
                      <span className={styles.rowMeta}>
                        {release.version ? `v${release.version}` : 'No version'}
                        {release.targetDate
                          ? ` · Target ${new Date(release.targetDate).toLocaleDateString()}`
                          : ''}
                      </span>
                    </div>
                    <span className={styles.badge}>{release.status}</span>
                    <span className={styles.progress}>
                      {done}/{total} done
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className={styles.panel} aria-labelledby="board-deployments-heading">
          <h2 id="board-deployments-heading">Deployments</h2>
          {canManage && (
            <form className={styles.form} onSubmit={onSubmit} {...{ 'data-testid': 'board-record-deployment-form' }}>
              <div className={styles.field}>
                <label htmlFor="board-dep-env">Environment</label>
                <select id="board-dep-env" {...register('environment')} {...{ 'data-testid': 'board-release-board-dep-env-select' }}>
                  <option value="dev">Dev</option>
                  <option value="staging">Staging</option>
                  <option value="prod">Production</option>
                </select>
              </div>
              <div className={styles.field}>
                <label htmlFor="board-dep-version">Version</label>
                <input id="board-dep-version" placeholder="e.g. 1.4.0" {...register('version')}  {...{ 'data-testid': 'board-release-board-dep-version-input' }} />
                {errors.version && <span className={styles.error}>{errors.version.message}</span>}
              </div>
              <div className={styles.field}>
                <label htmlFor="board-dep-release">Release (optional)</label>
                <select id="board-dep-release" {...register('releaseId')} {...{ 'data-testid': 'board-release-board-dep-release-select' }}>
                  <option value="">None</option>
                  {(releases ?? []).map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                      {r.version ? ` (${r.version})` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div className={styles.field}>
                <label htmlFor="board-dep-notes">Notes</label>
                <textarea id="board-dep-notes" {...register('notes')}  {...{ 'data-testid': 'board-release-board-dep-notes-textarea' }} />
              </div>
              {(formError || recordDeployment.error) && (
                <div className={styles.error}>
                  {formError ?? recordDeployment.error?.message}
                </div>
              )}
              <div className={styles.actions}>
                <button
                  type="submit"
                  className={styles.primaryBtn}
                  disabled={isSubmitting || recordDeployment.isPending}
                 {...{ 'data-testid': 'board-release-primary-btn' }}>
                  {recordDeployment.isPending ? 'Recording…' : 'Record deployment'}
                </button>
              </div>
            </form>
          )}

          {deploymentsLoading ? (
            <div className={styles.empty}>Loading deployments…</div>
          ) : deploymentsError ? (
            <div className={styles.error}>{deploymentsError.message}</div>
          ) : !sortedDeployments.length ? (
            <div className={styles.empty}>No deployments recorded yet.</div>
          ) : (
            <div className={styles.list} style={{ marginTop: canManage ? 16 : 0 }}>
              {sortedDeployments.map((d) => (
                <div key={d.id} className={styles.row}>
                  <div className={styles.rowMain}>
                    <span className={styles.rowTitle}>
                      {d.version} · {ENV_LABEL[d.environment] ?? d.environment}
                    </span>
                    <span className={styles.rowMeta}>
                      {new Date(d.deployedAt).toLocaleString()}
                      {d.notes ? ` · ${d.notes}` : ''}
                    </span>
                  </div>
                  <span className={styles.badge}>{d.environment}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
};

export default BoardReleaseView;
