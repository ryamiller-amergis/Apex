const mockExecute = jest.fn();

jest.mock('../db/drizzle', () => ({
  db: {
    execute: (...args: unknown[]) => mockExecute(...args),
  },
}));

import {
  createWorkerTierHealthService,
} from '../services/workerTierHealthService';

describe('workerTierHealthService (TBI-008 DoD-4 / VT-10)', () => {
  it('reports saturation against the configured cap and oldest queued age from aggregate worker rows', async () => {
    mockExecute.mockResolvedValue({
      rows: [{
        in_flight: '5',
        queued_depth: '3',
        oldest_queued_at: '2026-08-05T11:58:30.000Z',
      }],
    });
    const service = createWorkerTierHealthService({
      resolveLimit: () => 10,
      now: () => new Date('2026-08-05T12:00:00.000Z'),
    });

    await expect(service.getWorkerTierHealthStats()).resolves.toEqual({
      workerTierSaturation: 0.5,
      oldestQueuedAgeMs: 90_000,
    });
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('returns zero queue age and safe zero saturation when no aggregate values exist', async () => {
    mockExecute.mockResolvedValue({
      rows: [{
        in_flight: 0,
        queued_depth: 0,
        oldest_queued_at: null,
      }],
    });
    const service = createWorkerTierHealthService({
      resolveLimit: () => 0,
      now: () => new Date('2026-08-05T12:00:00.000Z'),
    });

    await expect(service.getWorkerTierHealthStats()).resolves.toEqual({
      workerTierSaturation: 0,
      oldestQueuedAgeMs: 0,
    });
  });
});
