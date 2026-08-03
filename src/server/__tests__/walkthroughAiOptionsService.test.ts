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
  it('validates save command skill paths and models including discovery', () => {
    const cmd = validateSaveWalkthroughAiOptionsCommand({
      walkthroughGenerationSkillPath: '.cursor/skills/walkthrough-generation/SKILL.md',
      walkthroughGenerationModel: ' gpt-5.5 ',
      anchorSmartTaggingSkillPath:
        '.cursor/skills/walkthrough-anchor-smart-tagging/SKILL.md',
      anchorSmartTaggingModel: null,
      anchorDiscoverySkillPath: '.cursor/skills/walkthrough-anchor-discovery/SKILL.md',
      anchorDiscoveryModel: ' composer-2 ',
    });
    expect(cmd.walkthroughGenerationModel).toBe('gpt-5.5');
    expect(cmd.anchorSmartTaggingModel).toBe('');
    expect(cmd.anchorDiscoveryModel).toBe('composer-2');
  });

  it('rejects invalid skill paths', () => {
    expect(() =>
      validateSaveWalkthroughAiOptionsCommand({
        walkthroughGenerationSkillPath: 'not-a-skill',
        anchorSmartTaggingSkillPath:
          '.cursor/skills/walkthrough-anchor-smart-tagging/SKILL.md',
        anchorDiscoverySkillPath: '.cursor/skills/walkthrough-anchor-discovery/SKILL.md',
      }),
    ).toThrow(WalkthroughAiOptionsError);
  });

  it('rejects missing discovery skill path', () => {
    expect(() =>
      validateSaveWalkthroughAiOptionsCommand({
        walkthroughGenerationSkillPath: '.cursor/skills/walkthrough-generation/SKILL.md',
        anchorSmartTaggingSkillPath:
          '.cursor/skills/walkthrough-anchor-smart-tagging/SKILL.md',
      }),
    ).toThrow(/anchorDiscoverySkillPath is required/);
  });
});

describe('walkthroughAiOptionsService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns default record when no row exists', async () => {
    mockDb.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([]),
        }),
      }),
    });
    const record = await getWalkthroughAiOptions();
    expect(record.walkthroughGenerationSkillPath).toContain('walkthrough-generation');
    expect(record.anchorDiscoverySkillPath).toContain('walkthrough-anchor-discovery');
  });

  it('saves options including discovery skill/model', async () => {
    const onConflictDoUpdate = jest.fn().mockResolvedValue(undefined);
    const values = jest.fn().mockReturnValue({ onConflictDoUpdate });
    mockDb.insert.mockReturnValue({ values });
    mockDb.select.mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([
            {
              id: 'default',
              walkthroughGenerationSkillPath:
                '.cursor/skills/walkthrough-generation/SKILL.md',
              walkthroughGenerationModel: 'gpt-5.5',
              anchorSmartTaggingSkillPath:
                '.cursor/skills/walkthrough-anchor-smart-tagging/SKILL.md',
              anchorSmartTaggingModel: '',
              anchorDiscoverySkillPath:
                '.cursor/skills/walkthrough-anchor-discovery/SKILL.md',
              anchorDiscoveryModel: 'composer-2',
              createdBy: 'u1',
              createdByDisplayName: 'User',
              createdAt: '2026-07-30T00:00:00.000Z',
              updatedBy: 'u1',
              updatedByDisplayName: 'User',
              updatedAt: '2026-07-30T00:00:00.000Z',
            },
          ]),
        }),
      }),
    });

    const saved = await saveWalkthroughAiOptions(
      {
        walkthroughGenerationSkillPath: '.cursor/skills/walkthrough-generation/SKILL.md',
        walkthroughGenerationModel: 'gpt-5.5',
        anchorSmartTaggingSkillPath:
          '.cursor/skills/walkthrough-anchor-smart-tagging/SKILL.md',
        anchorSmartTaggingModel: '',
        anchorDiscoverySkillPath: '.cursor/skills/walkthrough-anchor-discovery/SKILL.md',
        anchorDiscoveryModel: 'composer-2',
      },
      { id: 'u1', displayName: 'User' },
    );

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        anchorDiscoverySkillPath: '.cursor/skills/walkthrough-anchor-discovery/SKILL.md',
        anchorDiscoveryModel: 'composer-2',
      }),
    );
    expect(saved.anchorDiscoveryModel).toBe('composer-2');
  });
});
