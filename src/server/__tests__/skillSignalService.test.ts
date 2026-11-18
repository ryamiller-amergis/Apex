import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const inserted: Array<Record<string, unknown>> = [];
let threadRow: Record<string, unknown> | undefined;
let insertReturns: Array<{ id: string }> = [{ id: 'signal-1' }];

jest.mock('../db/drizzle', () => {
  const selectChain = {
    from: () => selectChain,
    where: () => selectChain,
    limit: async () => (threadRow ? [threadRow] : []),
  };
  return {
    db: {
      select: () => selectChain,
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          inserted.push(values);
          return {
            onConflictDoNothing: () => ({ returning: async () => insertReturns }),
          };
        },
      }),
    },
  };
});

const isFeatureEnabled = jest.fn<(...args: unknown[]) => Promise<boolean>>();
jest.mock('../services/featureFlagService', () => ({
  isFeatureEnabled: (...args: unknown[]) => isFeatureEnabled(...args),
}));

import {
  defaultSignalIdempotencyKey,
  emitSkillSignalLater,
  recordSkillSignal,
  type SkillSignalInput,
} from '../services/skillSignalService';

const input = (overrides: Partial<SkillSignalInput> = {}): SkillSignalInput => ({
  project: 'Apex',
  surface: 'adr_assistant',
  subjectType: 'adr_proposed_edit',
  subjectId: 'adr-1',
  kind: 'accepted',
  actorId: 'user-1',
  ...overrides,
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  inserted.length = 0;
  threadRow = undefined;
  insertReturns = [{ id: 'signal-1' }];
  isFeatureEnabled.mockReset();
  isFeatureEnabled.mockResolvedValue(true);
});

describe('recordSkillSignal', () => {
  it('writes nothing when skill-learning is off for the project', async () => {
    isFeatureEnabled.mockResolvedValue(false);
    await expect(recordSkillSignal(input())).resolves.toBe(false);
    expect(inserted).toHaveLength(0);
  });

  it('copies the Skill, model and effort from the thread that produced the output', async () => {
    threadRow = {
      kickoff: { skillPath: '.cursor/skills/adr-interview/SKILL.md', model: 'claude', effort: 'high' },
      skillSha256: 'a'.repeat(64),
    };
    await expect(recordSkillSignal(input({ threadId: 'thread-1' }))).resolves.toBe(true);
    expect(inserted[0]).toMatchObject({
      skillPath: '.cursor/skills/adr-interview/SKILL.md',
      skillSha256: 'a'.repeat(64),
      model: 'claude',
      effort: 'high',
      value: null,
      idempotencyKey: defaultSignalIdempotencyKey(input({ threadId: 'thread-1' })),
    });
  });

  it('stores a rating value and nothing else for other kinds', async () => {
    await recordSkillSignal(input({ kind: 'rating', value: -1 }));
    expect(inserted[0]).toMatchObject({ kind: 'rating', value: -1 });
  });

  it('returns false for a repeat of the same key', async () => {
    insertReturns = [];
    await expect(recordSkillSignal(input())).resolves.toBe(false);
  });

  it('logs and returns false instead of throwing when the database fails', async () => {
    isFeatureEnabled.mockRejectedValue(new Error('db down'));
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(recordSkillSignal(input())).resolves.toBe(false);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe('emitSkillSignalLater', () => {
  it('records the signal the builder returns', async () => {
    emitSkillSignalLater('test', async () => input());
    await flush();
    expect(inserted).toHaveLength(1);
  });

  it('skips when the builder returns null and swallows a builder throw', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    emitSkillSignalLater('null', async () => null);
    emitSkillSignalLater('throws', async () => {
      throw new Error('lookup failed');
    });
    await flush();
    expect(inserted).toHaveLength(0);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('throws'), expect.any(Error));
    error.mockRestore();
  });
});
