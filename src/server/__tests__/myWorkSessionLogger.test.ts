jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      devSessions: {
        findFirst: jest.fn(),
      },
    },
  },
}));

import { db } from '../db/drizzle';
import {
  getMyWorkSessionContext,
  logMyWorkSession,
} from '../services/myWorkSessionLogger';

describe('myWorkSessionLogger', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('emits a structured, redacted log-stream record', () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});

    logMyWorkSession('run.started', {
      sessionId: 'session-1',
      threadId: 'thread-1',
      runId: 'run-1',
      detail: 'token=super-secret https://user:pass@example.com/repo',
    });

    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0][0]);
    expect(line).toContain('[my-work] ');
    const payload = JSON.parse(line.replace('[my-work] ', ''));
    expect(payload).toMatchObject({
      component: 'my-work',
      event: 'run.started',
      sessionId: 'session-1',
      threadId: 'thread-1',
      runId: 'run-1',
      detail: 'token=[redacted] https://[redacted]@example.com/repo',
    });
    expect(payload.timestamp).toEqual(expect.any(String));
  });

  it('resolves session correlation fields from a thread id', async () => {
    const findFirst = db.query.devSessions.findFirst as jest.Mock;
    findFirst.mockResolvedValue({
      id: 'session-1',
      project: 'Apex',
      branchName: 'feature/example',
      status: 'in_progress',
    });

    await expect(getMyWorkSessionContext('thread-1')).resolves.toEqual({
      sessionId: 'session-1',
      threadId: 'thread-1',
      project: 'Apex',
      branch: 'feature/example',
      status: 'in_progress',
    });
  });
});
