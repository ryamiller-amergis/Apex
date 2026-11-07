import fs from 'node:fs';
import path from 'node:path';

const mockDevSessionFindFirst = jest.fn();
const mockMarkTerminal = jest.fn();
const mockUpdate = jest.fn();

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      devSessions: { findFirst: (...args: unknown[]) => mockDevSessionFindFirst(...args) },
      agentRuns: { findFirst: jest.fn() },
    },
    select: () => {
      const empty: Record<string, unknown> = {};
      for (const step of ['from', 'where', 'orderBy', 'limit', 'for']) empty[step] = () => empty;
      empty.then = (resolve: (rows: unknown[]) => unknown) => resolve([]);
      return empty;
    },
    update: (...args: unknown[]) => mockUpdate(...args),
    transaction: jest.fn(),
  },
}));
jest.mock('../services/agentRunLifecycleService', () => ({
  enqueue: jest.fn(),
  captureCloudAgentIdentity: jest.fn(),
  requestCancel: jest.fn(),
  markTerminal: (...args: unknown[]) => mockMarkTerminal(...args),
}));
jest.mock('../services/telemetry', () => ({ trackEvent: jest.fn() }));
jest.mock('../services/myWorkSessionLogger', () => ({ logMyWorkSession: jest.fn() }));
jest.mock('../services/featureFlagService', () => ({ isFeatureEnabled: jest.fn().mockResolvedValue(true) }));
jest.mock('../services/projectSettingsService', () => ({ getSkillConfig: jest.fn().mockResolvedValue(null) }));
jest.mock('../services/localDevContextService', () => ({ buildLocalDevContext: jest.fn() }));
jest.mock('../services/agentRunReaperService', () => ({
  resolveAgentRunHardLimitMs: jest.fn().mockReturnValue(7_200_000),
}));
jest.mock('../services/cursorCloudAgentClient', () => ({
  launchCloudAgent: jest.fn(),
  getCloudAgentRun: jest.fn(),
  streamCloudAgentRun: jest.fn(),
  cancelCursorCloudAgentRun: jest.fn(),
}));

import { applyCloudAgentCompletion, type CloudAgentServiceDeps } from '../services/cloudAgentService';

const BUILD_TASK_ID = '33333333-3333-4333-8333-333333333333';

describe('My Work pump and sweep with build agent rows (PBI-019 AC-2)', () => {
  it('VT-15: every My Work queue claim only takes rows with no owner instance', () => {
    const source = fs.readFileSync(path.resolve(process.cwd(), 'src/server/services/cloudAgentService.ts'), 'utf8');
    const claims = source.split(/async function claimCloudAgentRun(?:Ids)?\(/).slice(1);

    expect(claims).toHaveLength(2);
    for (const claim of claims) {
      const body = claim.slice(0, claim.indexOf('\n}\n'));
      expect(body).toMatch(/\$\{agentRuns\.ownerInstance\} IS NULL/);
    }
  });

  it('VT-16: completing a build row finds no dev session and writes nothing to dev_sessions', async () => {
    mockMarkTerminal.mockResolvedValue({
      ok: true,
      run: {
        id: 'run-1',
        status: 'completed',
        lane: 'cloud-agent',
        workflowClass: 'build-task',
        buildTaskId: BUILD_TASK_ID,
        devSessionId: null,
        executionSnapshot: { prompt: `build-task:${BUILD_TASK_ID}`, threadId: BUILD_TASK_ID },
      },
    });
    mockDevSessionFindFirst.mockResolvedValue(undefined);
    const deps = {
      linkWorkItemToPullRequest: jest.fn(),
      alignCloudAgentPullRequest: jest.fn(),
      openCloudAgentPullRequest: jest.fn(),
    } as unknown as CloudAgentServiceDeps;

    await expect(applyCloudAgentCompletion({
      runId: 'run-1',
      sessionId: BUILD_TASK_ID,
      project: 'MaxView',
      status: 'completed',
      prUrl: null,
    }, deps)).resolves.toBeUndefined();

    expect(mockMarkTerminal).toHaveBeenCalledWith('run-1', expect.objectContaining({ status: 'completed' }));
    expect(mockDevSessionFindFirst).toHaveBeenCalledTimes(1);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
