const mockSelect = jest.fn();

jest.mock('../../db/drizzle', () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
  },
}));

import { createChatHarnessCommandRepository } from '../../services/chatHarness/chatHarnessCommandRepository';

describe('chatHarnessCommandRepository.listPendingCommands', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function mockJoinRows(
    rows: Array<{
      commandId: string;
      kind: 'send' | 'steer' | 'summarize' | 'cancel' | 'retry';
      status: 'accepted' | 'queued';
      runId: string | null;
      runStatus: string | null;
    }>,
  ): void {
    const orderBy = jest.fn().mockResolvedValue(rows);
    const where = jest.fn().mockReturnValue({ orderBy });
    const leftJoin = jest.fn().mockReturnValue({ where });
    const from = jest.fn().mockReturnValue({ leftJoin });
    mockSelect.mockReturnValue({ from });
  }

  it('excludes send/retry/queued-steer commands whose attached agent_run is already terminal while keeping active runs and un-acked mid-turn steers', async () => {
    mockJoinRows([
      {
        commandId: '10000000-0000-4000-8000-000000000001',
        kind: 'send',
        status: 'accepted',
        runId: 'run-completed',
        runStatus: 'completed',
      },
      {
        commandId: '10000000-0000-4000-8000-000000000002',
        kind: 'retry',
        status: 'accepted',
        runId: 'run-failed',
        runStatus: 'failed',
      },
      {
        commandId: '10000000-0000-4000-8000-000000000003',
        kind: 'steer',
        status: 'queued',
        runId: 'run-cancelled',
        runStatus: 'cancelled',
      },
      {
        commandId: '10000000-0000-4000-8000-000000000004',
        kind: 'send',
        status: 'accepted',
        runId: 'run-active',
        runStatus: 'running',
      },
      {
        commandId: '10000000-0000-4000-8000-000000000005',
        kind: 'send',
        status: 'accepted',
        runId: null,
        runStatus: null,
      },
      {
        commandId: '10000000-0000-4000-8000-000000000006',
        kind: 'steer',
        status: 'accepted',
        runId: 'run-completed',
        runStatus: 'completed',
      },
    ]);

    const repo = createChatHarnessCommandRepository();
    const pending = await repo.listPendingCommands(
      '10000000-0000-4000-8000-000000000099',
    );

    expect(pending).toEqual([
      {
        commandId: '10000000-0000-4000-8000-000000000004',
        kind: 'send',
        status: 'accepted',
      },
      {
        commandId: '10000000-0000-4000-8000-000000000005',
        kind: 'send',
        status: 'accepted',
      },
      {
        commandId: '10000000-0000-4000-8000-000000000006',
        kind: 'steer',
        status: 'accepted',
      },
    ]);
  });
});
