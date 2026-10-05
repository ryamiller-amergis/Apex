jest.mock('../db', () => ({ __esModule: true, default: { end: jest.fn(), on: jest.fn() } }));

const runRows = jest.fn();
const priorRows = jest.fn();

jest.mock('../db/drizzle', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => {
          const rows = runRows.mock.calls.length === 0 ? runRows() : priorRows();
          const result = Promise.resolve(rows);
          return Object.assign(result, { limit: async () => rows });
        },
      }),
    }),
  },
}));

import { resolveRunStepConfig } from '../services/playbookStepBindings';

describe('resolveRunStepConfig', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    runRows.mockReturnValue([{ runInput: { documentId: 'doc-1' } }]);
    priorRows.mockReturnValue([
      { stepId: 'score', output: { threadId: 'thread-9', scorecard: { is_ready: true } } },
    ]);
  });

  it('returns config unchanged when there are no placeholders', async () => {
    await expect(resolveRunStepConfig('run-1', { documentId: 'doc-1' })).resolves.toEqual({
      documentId: 'doc-1',
    });
    expect(runRows).not.toHaveBeenCalled();
  });

  it('substitutes run input and prior step output so stored rows can keep resolved values', async () => {
    await expect(resolveRunStepConfig('run-1', {
      documentId: '${input.documentId}',
      scorecard: '${steps.score.scorecard}',
    })).resolves.toEqual({
      documentId: 'doc-1',
      scorecard: { is_ready: true },
    });
  });
});
