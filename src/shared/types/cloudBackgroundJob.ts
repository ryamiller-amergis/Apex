import type { AgentRunStatus } from './agentRunLifecycle';
import type {
  CloudBackgroundJobDraft,
  CloudBackgroundScheduleKind,
  CloudBackgroundWorkItemMode,
} from '../utils/cloudBackgroundJob';

export type CloudBackgroundJobTrigger = 'manual' | 'schedule';

export interface CloudBackgroundJobRun {
  id: string;
  trigger: CloudBackgroundJobTrigger;
  startedBy: string | null;
  createdAt: string;
  runId: string;
  status: AgentRunStatus | 'unknown';
  prUrl: string | null;
  lastError: string | null;
}

export interface CloudBackgroundJob {
  id: string;
  project: string;
  name: string;
  instructions: string;
  skillPath: string;
  model: string;
  workItemMode: CloudBackgroundWorkItemMode;
  workItemId: number | null;
  scheduleKind: CloudBackgroundScheduleKind;
  scheduleHour: number | null;
  scheduleMinute: number;
  enabled: boolean;
  createdBy: string;
  updatedAt: string;
  lastStartedAt: string | null;
  runs: CloudBackgroundJobRun[];
}

export type SaveCloudBackgroundJobRequest = CloudBackgroundJobDraft & {
  project: string;
};

export interface StartCloudBackgroundJobResponse {
  sessionId: string;
  runId: string;
}
