import React, { useState } from 'react';
import { useFeatureFlags } from '../hooks/useFeatureFlags';
import {
  useCancelGuidedCloudAgentRun,
  useCloudAgentActivityStream,
  useGuidedCloudJobs,
  useStartGuidedCloudAgentRun,
} from '../hooks/useDevWorkbench';
import { CLOUD_AGENT_GUIDED_LAUNCH_FLAG, MY_WORK_CLOUD_AGENT_FLAG } from '../../shared/types/featureFlags';
import type { GuidedCloudJobOption } from '../../shared/types/devWorkbench';
import { isAgentRunTerminalStatus } from '../../shared/types/agentRunLifecycle';
import { CloudAgentLaunchDialog } from './CloudAgentLaunchDialog';
import styles from './GuidedCloudJobs.module.css';

interface GuidedCloudJobsProps {
  project: string;
}

export const GuidedCloudJobs: React.FC<GuidedCloudJobsProps> = ({ project }) => {
  const { flags } = useFeatureFlags(project);
  const enabled = flags[CLOUD_AGENT_GUIDED_LAUNCH_FLAG] === true;
  const jobsQuery = useGuidedCloudJobs(project, enabled && flags[MY_WORK_CLOUD_AGENT_FLAG] === true);
  const startJob = useStartGuidedCloudAgentRun();
  const cancelJob = useCancelGuidedCloudAgentRun();
  const [open, setOpen] = useState(false);
  const [job, setJob] = useState<GuidedCloudJobOption | null>(null);
  const [intent, setIntent] = useState<'start' | 'retry'>('start');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [priorSkillPath, setPriorSkillPath] = useState<string | null>(null);
  const [priorModel, setPriorModel] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const data = jobsQuery.data;
  const selected = data?.runs.find((run) => run.sessionId === selectedSessionId) ?? null;
  const selectedLive = Boolean(
    selected?.run
    && !isAgentRunTerminalStatus(selected.run.status),
  );
  const activity = useCloudAgentActivityStream(
    selected?.sessionId ?? null,
    selected?.run?.runId ?? null,
    open && selectedLive,
    selected
      ? `/api/home-dashboard/cloud-agent/guided/${encodeURIComponent(selected.sessionId)}/stream?project=${encodeURIComponent(project)}&runId=${encodeURIComponent(selected.run?.runId ?? '')}`
      : null,
  );

  // @feature-flag:cloud-agent-guided-launch start winner=enabled
  if (!enabled || flags[MY_WORK_CLOUD_AGENT_FLAG] !== true) {
    // @feature-flag:cloud-agent-guided-launch disabled-start
    return null;
    // @feature-flag:cloud-agent-guided-launch disabled-end
  }

  // @feature-flag:cloud-agent-guided-launch enabled-start
  const openStart = (nextJob: GuidedCloudJobOption) => {
    setJob(nextJob);
    setIntent('start');
    setSessionId(null);
    setPriorSkillPath(null);
    setPriorModel(null);
    setActionError(null);
  };

  const confirm = async (value: { skillPath: string; model: string; task: string }) => {
    if (!job) return;
    if (!value.task) {
      setActionError('Describe the task before launching.');
      return;
    }
    setActionError(null);
    try {
      const result = await startJob.mutateAsync({
        project,
        jobId: job.id,
        task: value.task,
        intent,
        sessionId: sessionId ?? undefined,
        skillPath: value.skillPath,
        model: value.model,
      });
      setSelectedSessionId(result.sessionId);
      setJob(null);
      void jobsQuery.refetch();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to start the guided job.');
    }
  };

  return (
    <>
      <button
        type="button"
        className={styles.tabButton}
        onClick={() => setOpen(true)}
        data-testid="home-guided-jobs"
      >
        Guided jobs
      </button>
      {open ? (
        <div className={styles.overlay} role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setOpen(false);
        }}
        >
          <div
            className={styles.panel}
            role="dialog"
            aria-modal="true"
            aria-labelledby="guided-jobs-title"
            data-testid="home-guided-jobs-panel"
          >
            <div className={styles.header}>
              <div>
                <h2 id="guided-jobs-title">Guided jobs</h2>
                <p>Start a skill without an Azure DevOps work item. These jobs do not open a pull request.</p>
              </div>
              <button type="button" className={styles.close} onClick={() => setOpen(false)} aria-label="Close guided jobs">
                ×
              </button>
            </div>
            <div className={styles.layout}>
              <div className={styles.jobs}>
                {(data?.jobs ?? []).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className={styles.job}
                    onClick={() => openStart(item)}
                    data-testid={`home-guided-job-${item.id}`}
                  >
                    <strong>{item.title}</strong>
                    <span>{item.description}</span>
                  </button>
                ))}
                {jobsQuery.isLoading ? <p>Loading guided jobs…</p> : null}
                {jobsQuery.error ? (
                  <p className={styles.error} role="alert">
                    {jobsQuery.error.message}
                  </p>
                ) : null}
              </div>
              <div className={styles.runs}>
                <h3>Your jobs</h3>
                {(data?.runs ?? []).length === 0 ? <p>No guided jobs yet.</p> : null}
                {(data?.runs ?? []).map((run) => {
                  const live = Boolean(run.run && !isAgentRunTerminalStatus(run.run.status));
                  return (
                    <article key={run.sessionId} className={styles.run} data-testid={`home-guided-run-${run.sessionId}`}>
                      <button
                        type="button"
                        className={styles.runSummary}
                        onClick={() => setSelectedSessionId(run.sessionId)}
                      >
                        <strong>{run.title}</strong>
                        <span>{run.run?.status ?? 'queued'}</span>
                      </button>
                      <div className={styles.runActions}>
                        {live ? (
                          <button
                            type="button"
                            onClick={() => void cancelJob.mutateAsync({ project, sessionId: run.sessionId }).then(() => jobsQuery.refetch())}
                          >
                            Cancel
                          </button>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => void startJob.mutateAsync({
                                project,
                                jobId: run.jobId,
                                task: run.task,
                                intent: 'resume',
                                sessionId: run.sessionId,
                              }).then(() => jobsQuery.refetch())}
                            >
                              Resume
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                const match = data?.jobs.find((item) => item.id === run.jobId) ?? null;
                                setJob(match);
                                setIntent('retry');
                                setSessionId(run.sessionId);
                                setPriorSkillPath(run.skillPath);
                                setPriorModel(run.model);
                                setActionError(null);
                              }}
                            >
                              Retry
                            </button>
                          </>
                        )}
                      </div>
                    </article>
                  );
                })}
                {selected ? (
                  <div className={styles.activity} data-testid="home-guided-activity">
                    <h3>Activity</h3>
                    {activity.events.length === 0 ? <p>Activity appears here while the job runs.</p> : null}
                    {activity.events.map((event) => (
                      <p key={event.id}>
                        <strong>{event.title}</strong>
                        {event.detail ? ` ${event.detail}` : ''}
                      </p>
                    ))}
                    {activity.error ? <p className={styles.error} role="status">{activity.error}</p> : null}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {job ? (
        <CloudAgentLaunchDialog
          title={intent === 'retry' ? `Retry ${job.title}` : job.title}
          reason={job.skillPath
            ? `${job.title} uses ${job.skillName}. You can change the skill or model before launch.`
            : `${job.skillName} is not installed in this project. Choose another skill.`}
          skills={data?.skills ?? []}
          models={data?.models ?? []}
          defaultSkillPath={
            intent === 'retry'
              ? (priorSkillPath ?? job.skillPath ?? data?.skills[0]?.path ?? '')
              : (job.skillPath ?? data?.skills[0]?.path ?? '')
          }
          defaultModel={
            intent === 'retry'
              ? (priorModel ?? data?.models[0]?.id ?? 'composer-2.5')
              : (data?.models[0]?.id ?? 'composer-2.5')
          }
          requireTask
          loading={jobsQuery.isLoading}
          loadError={jobsQuery.error?.message ?? null}
          pending={startJob.isPending}
          error={actionError}
          onClose={() => setJob(null)}
          onConfirm={(value) => { void confirm(value); }}
        />
      ) : null}
    </>
  );
  // @feature-flag:cloud-agent-guided-launch enabled-end
  // @feature-flag:cloud-agent-guided-launch end
};
