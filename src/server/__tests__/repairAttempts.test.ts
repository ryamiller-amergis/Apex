/**
 * S3 — Atomic repair attempt counter (TBI-023 DoD-2 / VT-10, VT-11).
 */
const mockUpdate = jest.fn();

jest.mock('../db/drizzle', () => ({
  db: {
    update: (...args: unknown[]) => mockUpdate(...args),
  },
}));

import { requestRepairAttempt } from '../services/build/repairAttempts';

describe('requestRepairAttempt (TBI-023 DoD-2 / VT-10, VT-11)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('VT-10 TBI-023 DoD-2 grants twice and denies the third attempt when repair_attempts reaches 2', async () => {
    let counter = 0;
    const executor = {
      update: jest.fn(() => ({
        set: jest.fn(() => ({
          where: jest.fn(() => ({
            returning: jest.fn(async () => {
              if (counter < 2) {
                counter += 1;
                return [{ repairAttempts: counter }];
              }
              return [];
            }),
          })),
        })),
      })),
    };

    const first = await requestRepairAttempt('rev-1', 'merge_conflict', executor as any);
    const second = await requestRepairAttempt('rev-1', 'final_check_fix', executor as any);
    const third = await requestRepairAttempt('rev-1', 'final_check_fix', executor as any);

    expect(first).toEqual({ granted: true, used: 1 });
    expect(second).toEqual({ granted: true, used: 2 });
    expect(third).toEqual({ granted: false, used: 2 });
    expect(counter).toBe(2);
  });

  it('VT-11 TBI-023 DoD-2 / NFR atomic counter grants at most 2 across 5 concurrent requests', async () => {
    let counter = 0;
    const executor = {
      update: jest.fn(() => ({
        set: jest.fn(() => ({
          where: jest.fn(() => ({
            returning: jest.fn(async () => {
              if (counter < 2) {
                counter += 1;
                return [{ repairAttempts: counter }];
              }
              return [];
            }),
          })),
        })),
      })),
    };

    const outcomes = await Promise.all(
      Array.from({ length: 5 }, () => requestRepairAttempt('rev-concurrent', 'merge_conflict', executor as any)),
    );

    const granted = outcomes.filter((o) => o.granted);
    const denied = outcomes.filter((o) => !o.granted);
    expect(granted).toHaveLength(2);
    expect(denied).toHaveLength(3);
    expect(counter).toBe(2);
  });
});
