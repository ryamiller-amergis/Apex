import React, { useMemo, useState } from 'react';
import { useFeatureFlags } from '../hooks/useFeatureFlags';
import {
  useCancelGuidedCloudAgentRun,
  useGuidedCloudJobs,
  useStartGuidedCloudAgentRun,
} from '../hooks/useDevWorkbench';
import { CLOUD_AGENT_GUIDED_LAUNCH_FLAG, MY_WORK_CLOUD_AGENT_FLAG } from '../../shared/types/featureFlags';
import type { GuidedCloudAgentSession, GuidedCloudJobOption } from '../../shared/types/devWorkbench';
import { isAgentRunTerminalStatus } from '../../shared/types/agentRunLifecycle';
import { CloudAgentLaunchDialog } from './CloudAgentLaunchDialog';
import { DataGridToolbar } from './DataGridToolbar';
import gridStyles from './DataGrid.module.css';
import styles from './GuidedCloudJobs.module.css';

const SITE_ISSUE_REPORT_TEMPLATE = [
  'Page:',
  '',
  'Problem:',
  '',
  'Steps:',
  '1.',
  '2.',
  '3.',
  '',
  'Expected:',
  '',
  'Actual:',
  '',
].join('\n');

const PROD_INVESTIGATION_TEMPLATE = [
  'Environment: production',
  '',
  'Page:',
  '',
  'When it started:',
  '',
  'Who is affected:',
  '',
  'What they were doing:',
  '',
  'What happened:',
  '',
  'What they expected:',
  '',
  'What you already checked:',
  '',
].join('\n');

const REPORT_TEMPLATES: Record<string, string> = {
  'site-issue': SITE_ISSUE_REPORT_TEMPLATE,
  'prod-investigation': PROD_INVESTIGATION_TEMPLATE,
};

function templateFor(jobId: string): string {
  return REPORT_TEMPLATES[jobId] ?? SITE_ISSUE_REPORT_TEMPLATE;
}

function launchCopy(job: GuidedCloudJobOption, intent: 'start' | 'retry'): {
  title: string;
  reason: string;
  taskLabel: string;
} {
  if (intent === 'retry') {
    return {
      title: 'Try again',
      reason: job.opensBug
        ? 'Describe the problem. Apex opens a Bug, and the agent prepares a fix for a developer to review.'
        : 'Add any context you have. The investigation skill gathers evidence and does not open a Bug.',
      taskLabel: 'What should the agent look at?',
    };
  }
  if (job.id === 'prod-investigation') {
    return {
      title: job.title,
      reason: 'Describe the production problem with as much context as you have. The prod-investigation skill gathers evidence. It does not open a Bug. A playbook decides whether this is an issue.',
      taskLabel: 'What happened in production?',
    };
  }
  return {
    title: job.title,
    reason: 'Describe the problem. Apex opens a Bug, and the agent prepares a fix for a developer to review.',
    taskLabel: "What's wrong on the site?",
  };
}

function reportIsWorking(report: GuidedCloudAgentSession): boolean {
  const run = report.run;
  return !run || !isAgentRunTerminalStatus(run.status);
}

function reportedOn(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

interface GuidedCloudJobsProps {
  project: string;
}

export const GuidedCloudJobs: React.FC<GuidedCloudJobsProps> = ({ project }) => {
  const { flags } = useFeatureFlags(project);
  const enabled = flags[CLOUD_AGENT_GUIDED_LAUNCH_FLAG] === true;
  const jobsQuery = useGuidedCloudJobs(project, enabled && flags[MY_WORK_CLOUD_AGENT_FLAG] === true);
  const startJob = useStartGuidedCloudAgentRun();
  const cancelJob = useCancelGuidedCloudAgentRun();
  const [job, setJob] = useState<GuidedCloudJobOption | null>(null);
  const [intent, setIntent] = useState<'start' | 'retry'>('start');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [priorSkillPath, setPriorSkillPath] = useState<string | null>(null);
  const [priorModel, setPriorModel] = useState<string | null>(null);
  const [priorTask, setPriorTask] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [bugAlreadyOpened, setBugAlreadyOpened] = useState(false);
  const [search, setSearch] = useState('');
  const data = jobsQuery.data;

  const reports = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (data?.runs ?? []).filter((report) => {
      if (!term) return true;
      return report.title.toLowerCase().includes(term)
        || String(report.bugWorkItemId ?? '').includes(term);
    });
  }, [data?.runs, search]);

  const jobById = (id: string) => data?.jobs.find((item) => item.id === id) ?? null;

  // @feature-flag:cloud-agent-guided-launch start winner=enabled
  if (!enabled || flags[MY_WORK_CLOUD_AGENT_FLAG] !== true) {
    // @feature-flag:cloud-agent-guided-launch disabled-start
    return (
      <main className={styles.page} {...{ 'data-testid': 'prod-support-page' }}>
        <h1 className={styles.heading}>Prod Support</h1>
        <p className={styles.intro}>Prod Support is not turned on for this project.</p>
      </main>
    );
    // @feature-flag:cloud-agent-guided-launch disabled-end
  }

  // @feature-flag:cloud-agent-guided-launch enabled-start
  const openStart = (id: string) => {
    const match = jobById(id);
    if (!match) return;
    setJob(match);
    setIntent('start');
    setSessionId(null);
    setPriorSkillPath(null);
    setPriorModel(null);
    setPriorTask('');
    setActionError(null);
    setBugAlreadyOpened(false);
  };

  const openRetry = (report: GuidedCloudAgentSession) => {
    const match = data?.jobs.find((item) => item.id === report.jobId) ?? jobById('site-issue');
    if (!match) return;
    setJob(match);
    setIntent('retry');
    setSessionId(report.sessionId);
    setPriorSkillPath(report.skillPath);
    setPriorModel(report.model);
    setPriorTask(report.task);
    setActionError(null);
    setBugAlreadyOpened(false);
  };

  const confirm = async (value: { skillPath: string; model: string; task: string; images?: Array<{ name: string; mimeType: 'image/png' | 'image/jpeg' | 'image/webp'; data: string }> }) => {
    if (!job || bugAlreadyOpened) return;
    const template = templateFor(job.id);
    if (!value.task || value.task.trim() === template.trim()) {
      setActionError('Fill in what you know before sending.');
      return;
    }
    setActionError(null);
    try {
      await startJob.mutateAsync({
        project,
        jobId: job.id,
        task: value.task,
        intent,
        sessionId: sessionId ?? undefined,
        skillPath: value.skillPath,
        model: value.model,
        images: value.images,
      });
      setJob(null);
      void jobsQuery.refetch();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to send the report.';
      setActionError(message);
      if (message.includes('was opened')) setBugAlreadyOpened(true);
    }
  };

  const hasReports = (data?.runs ?? []).length > 0;
  const copy = job ? launchCopy(job, intent) : null;
  const prodJob = jobById('prod-investigation');

  return (
    <main className={styles.page} {...{ 'data-testid': 'prod-support-page' }}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.heading}>Prod Support</h1>
          <p className={styles.intro}>
            Describe a production problem. The investigation skill gathers context. A playbook decides whether it becomes a Bug.
          </p>
        </div>
        <div className={styles.actions}>
          <button
            type="button"
            className={gridStyles.buttonPrimary}
            onClick={() => openStart('prod-investigation')}
            disabled={!prodJob}
            {...{ 'data-testid': 'prod-support-prod' }}
          >
            Investigate production
          </button>
        </div>
      </header>
      <section className={gridStyles.section} aria-labelledby="prod-support-list-heading">
        <div className={gridStyles.header}>
          <div>
            <h2 id="prod-support-list-heading" className={gridStyles.title}>Requests</h2>
            <p className={gridStyles.hint}>Search by what was reported or by Bug number.</p>
          </div>
        </div>
        <DataGridToolbar
          searchValue={search}
          onSearchChange={setSearch}
          searchPlaceholder="Search reports or Bug number"
          searchTestId="home-guided-reports-search"
        />
        {jobsQuery.isLoading ? <p className={gridStyles.loading}>Loading reports…</p> : null}
        {jobsQuery.error ? (
          <p className={gridStyles.error} role="alert">{jobsQuery.error.message}</p>
        ) : null}
        {!jobsQuery.isLoading && !jobsQuery.error && reports.length === 0 ? (
          <p className={gridStyles.empty}>
            {hasReports ? 'No reports match this search.' : 'No investigations yet. Start one with Investigate production.'}
          </p>
        ) : null}
        {reports.length > 0 ? (
          <div className={`${gridStyles.tableWrap} ${styles.tableScroll}`}>
            <table className={`${gridStyles.table} ${styles.table}`} {...{ 'data-testid': 'home-guided-reports-table' }}>
              <thead>
                <tr>
                  <th>Report</th>
                  <th>Kind</th>
                  <th>Reported</th>
                  <th>Links</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {reports.map((report) => {
                  const working = reportIsWorking(report);
                  const kind = data?.jobs.find((item) => item.id === report.jobId)?.title ?? 'Report';
                  return (
                    <tr key={report.sessionId} {...{ 'data-testid': `home-guided-run-${report.sessionId}` }}>
                      <td className={styles.titleCell} title={report.title}>{report.title}</td>
                      <td>{kind}</td>
                      <td className={styles.dateCell}>{reportedOn(report.updatedAt)}</td>
                      <td>
                        <div className={styles.links}>
                          {report.bugUrl ? (
                            <a href={report.bugUrl} target="_blank" rel="noreferrer" {...{ 'data-testid': `home-guided-bug-${report.sessionId}` }}>
                              Bug {report.bugWorkItemId}
                            </a>
                          ) : null}
                          {report.run?.prUrl ? (
                            <a href={report.run.prUrl} target="_blank" rel="noreferrer" {...{ 'data-testid': `home-guided-pr-${report.sessionId}` }}>
                              Pull request
                            </a>
                          ) : null}
                        </div>
                      </td>
                      <td>
                        <div className={gridStyles.rowActions}>
                          {working ? (
                            <button
                              type="button"
                              className={gridStyles.buttonGhost}
                              onClick={() => void cancelJob.mutateAsync({ project, sessionId: report.sessionId }).then(() => jobsQuery.refetch())}
                              {...{ 'data-testid': `home-guided-cancel-${report.sessionId}` }}
                            >
                              Cancel
                            </button>
                          ) : (
                            <button
                              type="button"
                              className={gridStyles.buttonGhost}
                              onClick={() => openRetry(report)}
                              {...{ 'data-testid': `home-guided-retry-${report.sessionId}` }}
                            >
                              Try again
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
      {job && copy ? (
        <CloudAgentLaunchDialog
          {...{ 'data-testid': 'home-guided-launch-dialog' }}
          title={copy.title}
          reason={copy.reason}
          skills={data?.skills ?? []}
          models={data?.models ?? []}
          defaultSkillPath={
            intent === 'retry'
              ? (priorSkillPath ?? job.skillPath ?? '')
              : (job.skillPath ?? '')
          }
          defaultModel={
            intent === 'retry'
              ? (priorModel ?? data?.recommendedModel ?? 'composer-2.5')
              : (data?.recommendedModel ?? 'composer-2.5')
          }
          defaultTask={intent === 'retry' ? priorTask : templateFor(job.id)}
          taskRows={12}
          requireTask
          chooseSkillAndModel={false}
          allowChangingSkillAndModel
          allowImages
          imageHint={intent === 'retry'
            ? 'Leave this empty to keep the screenshots from the last try. PNG, JPEG, or WebP. Up to 3 images, 400 KB each.'
            : 'PNG, JPEG, or WebP. Up to 3 images, 400 KB each.'}
          taskLabel={copy.taskLabel}
          emptyTaskMessage="Describe the issue"
          loading={jobsQuery.isLoading}
          loadError={bugAlreadyOpened ? actionError : (jobsQuery.error?.message ?? null)}
          pending={startJob.isPending}
          error={bugAlreadyOpened ? null : actionError}
          onClose={() => setJob(null)}
          onConfirm={(value) => { void confirm(value); }}
        />
      ) : null}
    </main>
  );
  // @feature-flag:cloud-agent-guided-launch enabled-end
  // @feature-flag:cloud-agent-guided-launch end
};
