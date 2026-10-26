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
import { useDialogFocus } from '../hooks/useDialogFocus';
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
  const [open, setOpen] = useState(false);
  const [job, setJob] = useState<GuidedCloudJobOption | null>(null);
  const [intent, setIntent] = useState<'start' | 'retry'>('start');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [priorSkillPath, setPriorSkillPath] = useState<string | null>(null);
  const [priorModel, setPriorModel] = useState<string | null>(null);
  const [priorTask, setPriorTask] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const panelRef = useDialogFocus<HTMLDivElement>(open, () => setOpen(false));
  const data = jobsQuery.data;
  const siteIssueJob = data?.jobs[0] ?? null;

  const reports = useMemo(() => {
    const term = search.trim().toLowerCase();
    return (data?.runs ?? []).filter((report) => {
      if (!term) return true;
      return report.title.toLowerCase().includes(term)
        || String(report.bugWorkItemId ?? '').includes(term);
    });
  }, [data?.runs, search]);

  // @feature-flag:cloud-agent-guided-launch start winner=enabled
  if (!enabled || flags[MY_WORK_CLOUD_AGENT_FLAG] !== true) {
    // @feature-flag:cloud-agent-guided-launch disabled-start
    return null;
    // @feature-flag:cloud-agent-guided-launch disabled-end
  }

  // @feature-flag:cloud-agent-guided-launch enabled-start
  const openStart = () => {
    if (!siteIssueJob) return;
    setJob(siteIssueJob);
    setIntent('start');
    setSessionId(null);
    setPriorSkillPath(null);
    setPriorModel(null);
    setPriorTask('');
    setActionError(null);
  };

  const openRetry = (report: GuidedCloudAgentSession) => {
    const match = data?.jobs.find((item) => item.id === report.jobId) ?? siteIssueJob;
    if (!match) return;
    setJob(match);
    setIntent('retry');
    setSessionId(report.sessionId);
    setPriorSkillPath(report.skillPath);
    setPriorModel(report.model);
    setPriorTask(report.task);
    setActionError(null);
  };

  const confirm = async (value: { skillPath: string; model: string; task: string; images?: Array<{ name: string; mimeType: 'image/png' | 'image/jpeg' | 'image/webp'; data: string }> }) => {
    if (!job) return;
    if (!value.task || value.task.trim() === SITE_ISSUE_REPORT_TEMPLATE.trim()) {
      setActionError('Fill in the page, the problem, and what you expected.');
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
      setActionError(error instanceof Error ? error.message : 'Unable to send the report.');
    }
  };

  const hasReports = (data?.runs ?? []).length > 0;

  return (
    <>
      <button
        type="button"
        className={styles.tabButton}
        onClick={() => setOpen(true)}
        data-testid="home-guided-jobs"
      >
        Report an issue
      </button>
      {open ? (
        <div className={styles.overlay} role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setOpen(false);
        }}
        >
          <div
            ref={panelRef}
            className={styles.panel}
            role="dialog"
            aria-modal="true"
            aria-labelledby="guided-jobs-title"
            data-testid="home-guided-jobs-panel"
          >
            <div className={styles.header}>
              <div>
                <h2 id="guided-jobs-title">Report an issue</h2>
                <p>Describe a problem on the site. Apex opens a Bug, and the agent prepares a fix for a developer to review.</p>
              </div>
              <div className={styles.headerActions}>
                <button
                  type="button"
                  className={gridStyles.buttonPrimary}
                  onClick={openStart}
                  disabled={!siteIssueJob}
                  data-testid="home-guided-job-site-issue"
                >
                  New report
                </button>
                <button type="button" className={styles.close} onClick={() => setOpen(false)} aria-label="Close" data-testid="home-guided-jobs-close">
                  ×
                </button>
              </div>
            </div>
            <div className={styles.body}>
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
                  {hasReports ? 'No reports match this search.' : 'No reports yet. Choose New report to describe a problem.'}
                </p>
              ) : null}
              {reports.length > 0 ? (
                <div className={`${gridStyles.tableWrap} ${styles.tableScroll}`}>
                  <table className={`${gridStyles.table} ${styles.table}`} data-testid="home-guided-reports-table">
                    <thead>
                      <tr>
                        <th>Report</th>
                        <th>Reported</th>
                        <th>Links</th>
                        <th aria-label="Actions" />
                      </tr>
                    </thead>
                    <tbody>
                      {reports.map((report) => {
                        const working = reportIsWorking(report);
                        return (
                          <tr key={report.sessionId} data-testid={`home-guided-run-${report.sessionId}`}>
                            <td className={styles.titleCell} title={report.title}>{report.title}</td>
                            <td className={styles.dateCell}>{reportedOn(report.updatedAt)}</td>
                            <td>
                              <div className={styles.links}>
                                {report.bugUrl ? (
                                  <a href={report.bugUrl} target="_blank" rel="noreferrer" data-testid={`home-guided-bug-${report.sessionId}`}>
                                    Bug {report.bugWorkItemId}
                                  </a>
                                ) : null}
                                {report.run?.prUrl ? (
                                  <a href={report.run.prUrl} target="_blank" rel="noreferrer" data-testid={`home-guided-pr-${report.sessionId}`}>
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
                                    data-testid={`home-guided-cancel-${report.sessionId}`}
                                  >
                                    Cancel
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    className={gridStyles.buttonGhost}
                                    onClick={() => openRetry(report)}
                                    data-testid={`home-guided-retry-${report.sessionId}`}
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
            </div>
          </div>
        </div>
      ) : null}
      {job ? (
        <CloudAgentLaunchDialog
          data-testid="home-guided-launch-dialog"
          title={intent === 'retry' ? 'Try the report again' : job.title}
          reason="Describe the problem. Apex opens a Bug, and the agent prepares a fix for a developer to review."
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
          defaultTask={intent === 'retry' ? priorTask : SITE_ISSUE_REPORT_TEMPLATE}
          taskRows={12}
          requireTask
          chooseSkillAndModel={false}
          allowChangingSkillAndModel
          allowImages
          imageHint={intent === 'retry'
            ? 'Leave this empty to keep the screenshots from the last try. PNG, JPEG, or WebP. Up to 3 images, 400 KB each.'
            : 'PNG, JPEG, or WebP. Up to 3 images, 400 KB each.'}
          taskLabel="What's wrong on the site?"
          emptyTaskMessage="Describe the issue"
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
