import { estimateTokens, resolveFeatureFromKickoff } from '../services/aiUsageService';

jest.mock('../db/drizzle', () => ({ db: { insert: jest.fn().mockReturnValue({ catch: jest.fn() }) } }));
jest.mock('../db/schema', () => ({ aiUsageEvents: {}, aiPricing: {} }));

describe('aiUsageService', () => {
  describe('estimateTokens', () => {
    it('returns at least 1 for empty string', () => {
      expect(estimateTokens('')).toBeGreaterThanOrEqual(1);
    });

    it('estimates ~1 token per 4 chars', () => {
      const text = 'a'.repeat(400);
      expect(estimateTokens(text)).toBe(100);
    });
  });

  describe('resolveFeatureFromKickoff', () => {
    it('maps standup mode to standup feature', () => {
      expect(resolveFeatureFromKickoff({ mode: 'standup-participant' })).toBe('standup');
    });

    it('maps development mode to my-work', () => {
      expect(resolveFeatureFromKickoff({ mode: 'development' })).toBe('my-work');
    });

    it('maps prd assistantType to prd', () => {
      expect(resolveFeatureFromKickoff({ assistantType: 'prd' })).toBe('prd');
    });

    it('maps design-doc assistantType to design-doc', () => {
      expect(resolveFeatureFromKickoff({ assistantType: 'design-doc' })).toBe('design-doc');
    });

    it('maps grill skillPath to interview', () => {
      expect(resolveFeatureFromKickoff({ skillPath: '.cursor/skills/grill-with-docs/SKILL.md' })).toBe('interview');
    });

    it('maps to-prd skillPath to prd-review', () => {
      expect(resolveFeatureFromKickoff({ skillPath: '.cursor/skills/to-prd/SKILL.md' })).toBe('prd-review');
    });

    it('returns other for unrecognized kickoff', () => {
      expect(resolveFeatureFromKickoff({})).toBe('other');
    });
  });
});
