import React, { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useFeatureFlag } from '../hooks/useFeatureFlags';
import { useAvailableModels } from '../hooks/useProjectSkillConfig';
import { useSkillList } from '../hooks/useChatThreads';
import {
  useCloudBackgroundJobs,
  useDeleteCloudBackgroundJob,
  useRunCloudBackgroundJob,
  useSaveCloudBackgroundJob,
} from '../hooks/useCloudBackgroundJobs';
import { MY_WORK_CLOUD_AGENT_FLAG } from '../../shared/types/featureFlags';
import type { CloudBackgroundJob, CloudBackgroundJobRun } from '../../shared/types/cloudBackgroundJob';
import type { SkillProvider } from '../../shared/types/projectSettings';
import {
  cloudBackgroundJobDraftFromForm,
  cloudBackgroundJobFormSchema,
  emptyCloudBackgroundJobForm,
  formatCloudBackgroundSchedule,
  type CloudBackgroundJobFormValues,
} from '../../shared/utils/cloudBackgroundJob';
import { NumberStepper } from './NumberStepper';
import styles from './CloudBackgroundJobsCard.module.css';

interface CloudBackgroundJobsCardProps {
  project: string;
  skillRepo: string;
  skillBranch: string;
  skillProvider: SkillProvider;
}

const LIVE_RUN = new Set(['queued', 'dispatched', 'running']);

function runLabel(run: CloudBackgroundJobRun): string {
  if (run.status === 'completed') return 'Finished';
  if (run.status === 'failed') return 'Failed';
  if (run.status === 'cancelled') return 'Cancelled';
  if (run.status === 'running') return 'Running';
  if (run.status === 'queued' || run.status === 'dispatched') return 'Queued';
  return 'Unknown';
}

function valuesFromJob(job: CloudBackgroundJob): CloudBackgroundJobFormValues {
  return {
    name: job.name,
    instructions: job.instructions,
    skillPath: job.skillPath,
    model: job.model,
    workItemMode: job.workItemMode,
    workItemId: job.workItemId ? String(job.workItemId) : '',
    scheduleKind: job.scheduleKind,
    scheduleHour: job.scheduleHour ?? 2,
    scheduleMinute: job.scheduleMinute,
    enabled: job.enabled,
  };
}

export const CloudBackgroundJobsCard: React.FC<CloudBackgroundJobsCardProps> = ({
  project,
  skillRepo,
  skillBranch,
  skillProvider,
}) => {
  const [editing, setEditing] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const cloudEnabled = useFeatureFlag(MY_WORK_CLOUD_AGENT_FLAG, project);
  const jobsQuery = useCloudBackgroundJobs(project);
  const modelsQuery = useAvailableModels();
  const skillsQuery = useSkillList(
    project,
    skillRepo || null,
    skillBranch || undefined,
    skillProvider,
  );
  const save = useSaveCloudBackgroundJob(project);
  const remove = useDeleteCloudBackgroundJob(project);
  const run = useRunCloudBackgroundJob(project);
  const {
    register,
    handleSubmit,
    control,
    reset,
    watch,
    formState: { errors },
  } = useForm<CloudBackgroundJobFormValues>({
    resolver: zodResolver(cloudBackgroundJobFormSchema),
    defaultValues: emptyCloudBackgroundJobForm(),
  });

  const jobs = jobsQuery.data ?? [];
  const editingJob = editing && editing !== 'new'
    ? jobs.find((job) => job.id === editing) ?? null
    : null;
  const workItemMode = watch('workItemMode');
  const scheduleKind = watch('scheduleKind');
  const skills = skillsQuery.data ?? [];
  const models = modelsQuery.data ?? [];
  const skillReady = Boolean(skillRepo && skillBranch && skillProvider === 'ado');

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      const draft = cloudBackgroundJobDraftFromForm(values);
      await save.mutateAsync(editingJob ? { id: editingJob.id, draft } : { draft });
      setEditing(null);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not save the job.');
    }
  });

  const startRun = async (jobId: string) => {
    setActionError(null);
    try {
      await run.mutateAsync(jobId);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not start the job.');
    }
  };

  const deleteJob = async (job: CloudBackgroundJob) => {
    if (!window.confirm(`Delete ${job.name}? Its run history is removed. A Cloud Agent that is already running keeps going.`)) {
      return;
    }
    setActionError(null);
    try {
      await remove.mutateAsync(job.id);
      if (editing === job.id) setEditing(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not delete the job.');
    }
  };

  return (
    <section className={styles.card} data-testid="cloud-background-jobs">
      <div className={styles.header}>
        <div>
          <h2 className={styles.title}>Background jobs</h2>
          <p className={styles.help}>
            Save a coding job for this project. Run it now, or let it start once a day.
            The Cloud Agent opens a pull request. My Work and Agent Home stay as they are.
          </p>
        </div>
        {editing !== 'new' && (
          <button
            type="button"
            className={styles.primary}
            data-testid="cloud-background-job-new"
            onClick={() => {
              setEditing('new');
              reset(emptyCloudBackgroundJobForm());
              setFormError(null);
            }}
            disabled={!skillReady}
          >
            New job
          </button>
        )}
      </div>

      {!cloudEnabled && (
        <p className={styles.note}>Cloud Development is off for this project, so these jobs will not start.</p>
      )}
      {skillProvider === 'github' && (
        <p className={styles.note}>Cloud Development supports Azure Repos only. GitHub repositories are not supported yet.</p>
      )}
      {!skillRepo && (
        <p className={styles.note}>Set a skill repository for this project before adding a background job.</p>
      )}
      {actionError && <p className={styles.error} role="alert">{actionError}</p>}
      {jobsQuery.isLoading && <p className={styles.note}>Loading background jobs…</p>}
      {jobsQuery.isError && (
        <p className={styles.error} role="alert">
          Could not load background jobs.
          <button type="button" className={styles.button} onClick={() => jobsQuery.refetch()}>Retry</button>
        </p>
      )}

      {editing && (
        <form className={styles.form} onSubmit={onSubmit} data-testid="cloud-background-job-form">
          <h3 className={styles.jobName}>{editingJob ? `Edit ${editingJob.name}` : 'New background job'}</h3>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="cloud-bg-name">Name</label>
            <input id="cloud-bg-name" className={styles.input} {...register('name')} />
            {errors.name && <p className={styles.error} role="alert">{errors.name.message}</p>}
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="cloud-bg-instructions">Instructions</label>
            <textarea id="cloud-bg-instructions" className={styles.textarea} {...register('instructions')} />
            {errors.instructions && <p className={styles.error} role="alert">{errors.instructions.message}</p>}
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="cloud-bg-skill">Skill</label>
            <select id="cloud-bg-skill" className={styles.select} {...register('skillPath')}>
              <option value="">Choose a skill</option>
              {editingJob && !skills.some((skill) => skill.path === editingJob.skillPath) && (
                <option value={editingJob.skillPath}>{editingJob.skillPath}</option>
              )}
              {skills.map((skill) => (
                <option key={skill.path} value={skill.path}>{skill.name}</option>
              ))}
            </select>
            {errors.skillPath && <p className={styles.error} role="alert">{errors.skillPath.message}</p>}
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="cloud-bg-model">Model</label>
            <select id="cloud-bg-model" className={styles.select} {...register('model')}>
              <option value="">Choose a model</option>
              {editingJob && !models.some((model) => model.id === editingJob.model) && (
                <option value={editingJob.model}>{editingJob.model}</option>
              )}
              {models.map((model) => (
                <option key={model.id} value={model.id}>{model.displayName || model.id}</option>
              ))}
            </select>
            {errors.model && <p className={styles.error} role="alert">{errors.model.message}</p>}
          </div>
          <fieldset className={styles.field}>
            <legend className={styles.label}>Work item</legend>
            <div className={styles.choices}>
              <label className={styles.choice}>
                <input type="radio" value="none" {...register('workItemMode')} />
                Open a branch and a pull request
              </label>
              <label className={styles.choice}>
                <input type="radio" value="create_bug" {...register('workItemMode')} />
                Create a Bug, then open a pull request
              </label>
              <label className={styles.choice}>
                <input type="radio" value="attach" {...register('workItemMode')} />
                Attach to an existing work item
              </label>
            </div>
          </fieldset>
          {workItemMode === 'attach' && (
            <div className={styles.field}>
              <label className={styles.label} htmlFor="cloud-bg-work-item">Work item id</label>
              <input id="cloud-bg-work-item" className={styles.input} inputMode="numeric" {...register('workItemId')} />
              {errors.workItemId && <p className={styles.error} role="alert">{errors.workItemId.message}</p>}
            </div>
          )}
          <fieldset className={styles.field}>
            <legend className={styles.label}>When it runs</legend>
            <div className={styles.choices}>
              <label className={styles.choice}>
                <input type="radio" value="manual" {...register('scheduleKind')} />
                Run now only
              </label>
              <label className={styles.choice}>
                <input type="radio" value="daily" {...register('scheduleKind')} />
                Every day
              </label>
            </div>
          </fieldset>
          {scheduleKind === 'daily' && (
            <div className={styles.schedule}>
              <Controller
                name="scheduleHour"
                control={control}
                render={({ field }) => (
                  <NumberStepper
                    value={field.value}
                    onChange={field.onChange}
                    min={0}
                    max={23}
                    unit="hour UTC"
                    aria-label="Hour in UTC"
                    data-testid="cloud-background-job-hour"
                  />
                )}
              />
              <Controller
                name="scheduleMinute"
                control={control}
                render={({ field }) => (
                  <NumberStepper
                    value={field.value}
                    onChange={field.onChange}
                    min={0}
                    max={59}
                    unit="minute"
                    aria-label="Minute in UTC"
                    data-testid="cloud-background-job-minute"
                  />
                )}
              />
            </div>
          )}
          <label className={styles.choice}>
            <input type="checkbox" {...register('enabled')} />
            Job is on
          </label>
          {formError && <p className={styles.error} role="alert">{formError}</p>}
          <div className={styles.actions}>
            <button type="submit" className={styles.primary} disabled={save.isPending} data-testid="cloud-background-job-save">
              {save.isPending ? 'Saving…' : 'Save job'}
            </button>
            <button type="button" className={styles.button} onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </form>
      )}

      {jobs.length === 0 && !jobsQuery.isLoading && !editing && (
        <p className={styles.empty}>No background jobs yet.</p>
      )}
      <div className={styles.list}>
        {jobs.map((job) => {
          const live = job.runs.some((item) => LIVE_RUN.has(item.status));
          return (
            <article key={job.id} className={styles.job} data-testid={`cloud-background-job-${job.id}`}>
              <div className={styles.jobTop}>
                <div>
                  <h3 className={styles.jobName}>{job.name}</h3>
                  <p className={styles.meta}>
                    {formatCloudBackgroundSchedule(job)}
                    {job.enabled ? '' : ' · Off'}
                    {job.workItemMode === 'create_bug' ? ' · Creates a Bug' : ''}
                    {job.workItemMode === 'attach' && job.workItemId ? ` · Work item ${job.workItemId}` : ''}
                    {job.workItemMode === 'none' ? ' · Pull request only' : ''}
                  </p>
                </div>
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.primary}
                    disabled={live || run.isPending || !job.enabled}
                    onClick={() => startRun(job.id)}
                  >
                    {live ? 'Running' : 'Run now'}
                  </button>
                  <button
                    type="button"
                    className={styles.button}
                    onClick={() => {
                      setEditing(job.id);
                      reset(valuesFromJob(job));
                      setFormError(null);
                    }}
                  >
                    Edit
                  </button>
                  <button type="button" className={styles.danger} onClick={() => deleteJob(job)}>Delete</button>
                </div>
              </div>
              {job.runs.length > 0 && (
                <ul className={styles.runs}>
                  {job.runs.map((item) => (
                    <li key={item.id} className={styles.run}>
                      <span>{runLabel(item)}</span>
                      <span>{item.trigger === 'schedule' ? 'Scheduled' : 'Run now'}</span>
                      <span>{new Date(item.createdAt).toLocaleString()}</span>
                      {item.prUrl && <a href={item.prUrl} target="_blank" rel="noreferrer">Pull request</a>}
                      {item.lastError && item.status === 'failed' && <span>{item.lastError}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
};
