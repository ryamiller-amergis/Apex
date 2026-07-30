import {
  defaultWalkthroughAiOptionsRecord,
  validateSaveWalkthroughAiOptionsCommand,
  WalkthroughAiOptionsError,
} from '../../shared/types/walkthroughAiOptions';
import {
  getWalkthroughAiOptions,
  saveWalkthroughAiOptions,
} from '../services/walkthroughAiOptionsService';

jest.mock('../db/drizzle', () => ({
  db: {
    select: jest.fn(),
    insert: jest.fn(),
  },
}));

import { db } from '../db/drizzle';

const mockDb = db as unknown as {
  select: jest.Mock;
  insert: jest.Mock;
};

describe('walkthroughAiOptions types', () => {
  it('validates save command skill paths and models', () => {
    const cmd = validateSaveWalkthroughAiOptionsCommand({
      walkthroughGenerationSkillPath: '.cursor/skills/walkthrough-generation/SKILL.md',
      walkthroughGenerationModel: ' gpt-5.5 ',
      anchorSmartTaggingSkillPath:
        '.cursor/skills/walkthrough-anchor-smart-tagging/SKILL.md',
      anchorSmartTaggingModel: null,
    });
    expect(cmd.walkthroughGenerationModel).toBe('gpt-5.5');
    expect(cmd.anchorSmartTaggingModel).toBe('');
  });

  it('rejects invalid skill paths', () => {
    expect(() =>
      validateSaveWalkthroughAiOptionsCommand({
        walkthroughGenerationSkillPath: 'not-a-skill',
        anchorSmartTaggingSkillPath:
          '.cursor/skills/walkthrough-anchor-smart-tagging/SKILL.md',
      }),
    ).toThrow(WalkthroughAiOptionsError);
  });
});

describe('walkthroughAiOptionsService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns defaults when no row exists', async () => {
    mockDb.select.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([]),
        }),
      }),
    });
    const options = await getWalkthroughAiOptions();
    expect(options.walkthroughGenerationSkillPath).toBe(
      defaultWalkthroughAiOptionsRecord().walkthroughGenerationSkillPath,
    );
    expect(options.updatedByDisplayName).toBe('System');
  });

  it('saves options with actor who/when fields', async () => {
    const savedRow = {
      id: 'default',
      walkthroughGenerationSkillPath: '.cursor/skills/custom/SKILL.md',
      walkthroughGenerationModel: 'composer-2',
      anchorSmartTaggingSkillPath:
        '.cursor/skills/walkthrough-anchor-smart-tagging/SKILL.md',
      anchorSmartTaggingModel: 'claude-sonnet-4-6',
      createdBy: 'oid-1',
      createdByDisplayName: 'Ryan Miller',
      createdAt: '2026-07-30T15:00:00.000Z',
      updatedBy: 'oid-1',
      updatedByDisplayName: 'Ryan Miller',
      updatedAt: '2026-07-30T15:00:00.000Z',
    };

    const onConflictDoUpdate = jest.fn().mockResolvedValue(undefined);
    mockDb.insert.mockReturnValue({
      values: () => ({
        onConflictDoUpdate,
      }),
    });
    mockDb.select.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([savedRow]),
        }),
      }),
    });

    const result = await saveWalkthroughAiOptions(
      {
        walkthroughGenerationSkillPath: '.cursor/skills/custom/SKILL.md',
        walkthroughGenerationModel: 'composer-2',
        anchorSmartTaggingSkillPath:
          '.cursor/skills/walkthrough-anchor-smart-tagging/SKILL.md',
        anchorSmartTaggingModel: 'claude-sonnet-4-6',
      },
      { id: 'oid-1', displayName: 'Ryan Miller' },
    );

    expect(onConflictDoUpdate).toHaveBeenCalled();
    expect(result.updatedByDisplayName).toBe('Ryan Miller');
    expect(result.walkthroughGenerationModel).toBe('composer-2');
    expect(result.anchorSmartTaggingModel).toBe('claude-sonnet-4-6');
  });
});
