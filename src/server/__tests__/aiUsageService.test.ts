import {
  estimateTokens,
  modelIdPricingCandidates,
  resolveFeatureFromKickoff,
  resolveUsageEntityFromThread,
  computeCost,
  recordCursorChatUsage,
} from '../services/aiUsageService';

const insertValues = jest.fn().mockReturnValue({ catch: jest.fn() });
const pricingLimit = jest.fn();
const interviewFindFirst = jest.fn();
const prdFindFirst = jest.fn();
const adrFindFirst = jest.fn();
const designDocFindFirst = jest.fn();

jest.mock('../db/drizzle', () => ({
  db: {
    insert: jest.fn(() => ({ values: insertValues })),
    select: jest.fn(() => ({
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      limit: pricingLimit,
    })),
    query: {
      interviews: { findFirst: (...args: unknown[]) => interviewFindFirst(...args) },
      prds: { findFirst: (...args: unknown[]) => prdFindFirst(...args) },
      adrs: { findFirst: (...args: unknown[]) => adrFindFirst(...args) },
      designDocs: { findFirst: (...args: unknown[]) => designDocFindFirst(...args) },
    },
  },
}));

jest.mock('../db/schema', () => ({
  aiUsageEvents: {},
  aiPricing: {
    provider: 'provider',
    modelId: 'model_id',
    effectiveFrom: 'effective_from',
    effectiveTo: 'effective_to',
  },
  interviews: { chatThreadId: 'chat_thread_id' },
  prds: { chatThreadId: 'chat_thread_id', prdAssistantThreadId: 'prd_assistant_thread_id', validationThreadId: 'validation_thread_id' },
  adrs: { chatThreadId: 'chat_thread_id', adrAssistantThreadId: 'adr_assistant_thread_id' },
  designDocs: { chatThreadId: 'chat_thread_id', docAssistantThreadId: 'doc_assistant_thread_id', validationThreadId: 'validation_thread_id' },
}));

function pricingRow(modelId: string, extras?: { effectiveFrom?: string; effectiveTo?: string | null }) {
  return {
    modelId,
    inputPricePerMtok: '1',
    outputPricePerMtok: '2',
    cacheReadPricePerMtok: '0.1',
    cacheWritePricePerMtok: '0.2',
    effectiveFrom: extras?.effectiveFrom ?? '2020-01-01T00:00:00.000Z',
    effectiveTo: extras?.effectiveTo ?? null,
  };
}

describe('aiUsageService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    pricingLimit.mockResolvedValue([]);
    interviewFindFirst.mockResolvedValue(undefined);
    prdFindFirst.mockResolvedValue(undefined);
    adrFindFirst.mockResolvedValue(undefined);
    designDocFindFirst.mockResolvedValue(undefined);
  });

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

    it('maps adr assistantType to adr before interview substring', () => {
      expect(resolveFeatureFromKickoff({ assistantType: 'adr' })).toBe('adr');
    });

    it('maps adr-interview skillPath to adr, not interview', () => {
      expect(resolveFeatureFromKickoff({ skillPath: '.cursor/skills/adr-interview/SKILL.md' })).toBe('adr');
    });

    it('maps adr-finalize skillPath to adr', () => {
      expect(resolveFeatureFromKickoff({ skillPath: '.cursor/skills/adr-finalize/SKILL.md' })).toBe('adr');
    });

    it('maps grill skillPath to interview', () => {
      expect(resolveFeatureFromKickoff({ skillPath: '.cursor/skills/grill-with-docs/SKILL.md' })).toBe('interview');
    });

    it('maps to-prd skillPath to prd', () => {
      expect(resolveFeatureFromKickoff({ skillPath: '.cursor/skills/to-prd/SKILL.md' })).toBe('prd');
    });

    it('maps prd-spec-review skillPath to prd-review', () => {
      expect(resolveFeatureFromKickoff({ skillPath: '.cursor/skills/prd-spec-review/SKILL.md' })).toBe('prd-review');
    });

    it('returns other for unrecognized kickoff', () => {
      expect(resolveFeatureFromKickoff({})).toBe('other');
    });
  });

  describe('modelIdPricingCandidates', () => {
    it('falls back from composer-2.5-fast to composer-2.5', () => {
      expect(modelIdPricingCandidates('composer-2.5-fast')).toEqual(['composer-2.5-fast', 'composer-2.5']);
    });
  });

  describe('lookupPricing / computeCost', () => {
    it('uses a current row and ignores expired catalog windows', async () => {
      pricingLimit.mockResolvedValueOnce([
        pricingRow('composer-2.5', { effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: null }),
      ]);
      const cost = await computeCost({
        provider: 'cursor',
        modelId: 'composer-2.5',
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        at: new Date('2026-06-01T00:00:00.000Z'),
      });
      expect(cost).toBe(3);
    });

    it('falls back to the prefix model id when the exact id has no row', async () => {
      pricingLimit
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([pricingRow('composer-2.5')]);
      const cost = await computeCost({
        provider: 'cursor',
        modelId: 'composer-2.5-fast',
        inputTokens: 1_000_000,
        outputTokens: 0,
      });
      expect(cost).toBe(1);
      expect(pricingLimit).toHaveBeenCalledTimes(2);
    });

    it('returns 0 when no pricing row matches', async () => {
      pricingLimit.mockResolvedValue([]);
      await expect(
        computeCost({ provider: 'cursor', modelId: 'unknown-model', inputTokens: 10, outputTokens: 10 }),
      ).resolves.toBe(0);
    });
  });

  describe('resolveUsageEntityFromThread', () => {
    it('resolves an interview from chat_thread_id', async () => {
      interviewFindFirst.mockResolvedValue({ id: 'int-1' });
      await expect(resolveUsageEntityFromThread('thread-1')).resolves.toEqual({
        entityType: 'interview',
        entityId: 'int-1',
      });
    });

    it('resolves a PRD from an assistant thread', async () => {
      prdFindFirst.mockResolvedValue({ id: 'prd-1' });
      await expect(resolveUsageEntityFromThread('asst-1')).resolves.toEqual({
        entityType: 'prd',
        entityId: 'prd-1',
      });
    });
  });

  describe('recordCursorChatUsage', () => {
    it('records entity, duration, and non-zero estimated cost when pricing exists', async () => {
      interviewFindFirst.mockResolvedValue({ id: 'int-9' });
      pricingLimit.mockResolvedValue([pricingRow('composer-2.5')]);

      await recordCursorChatUsage({
        kickoff: { skillPath: '.cursor/skills/grill-with-docs/SKILL.md', project: 'Apex' },
        modelId: 'composer-2.5',
        threadId: 'thread-9',
        runId: 'run-9',
        userId: 'user-1',
        inputTokens: 1_000_000,
        outputTokens: 0,
        durationMs: 4200,
        status: 'success',
      });

      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'cursor',
          modelId: 'composer-2.5',
          feature: 'interview',
          project: 'Apex',
          threadId: 'thread-9',
          entityType: 'interview',
          entityId: 'int-9',
          durationMs: 4200,
          costUsd: '1.00000000',
          costSource: 'estimated',
          tokenSource: 'estimated',
          status: 'success',
        }),
      );
    });

    it('marks runtime-reported counts as exact and prices cache tokens', async () => {
      interviewFindFirst.mockResolvedValue({ id: 'int-9' });
      pricingLimit.mockResolvedValue([pricingRow('composer-2.5')]);

      await recordCursorChatUsage({
        kickoff: { skillPath: '.cursor/skills/grill-with-docs/SKILL.md', project: 'Apex' },
        modelId: 'composer-2.5',
        threadId: 'thread-9',
        inputTokens: 42_000,
        outputTokens: 900,
        cacheReadTokens: 118_000,
        cacheWriteTokens: 3_000,
        tokenSource: 'exact',
        durationMs: 4200,
        status: 'success',
      });

      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          inputTokens: 42_000,
          outputTokens: 900,
          cacheReadTokens: 118_000,
          cacheWriteTokens: 3_000,
          tokenSource: 'exact',
          costSource: 'computed',
        }),
      );
    });

    it('keeps cost estimated when exact tokens have no catalog row', async () => {
      pricingLimit.mockResolvedValue([]);

      await recordCursorChatUsage({
        kickoff: { skillPath: '.cursor/skills/grill-with-docs/SKILL.md', project: 'Apex' },
        modelId: 'unknown-cursor-model',
        threadId: 'thread-9',
        inputTokens: 42_000,
        outputTokens: 900,
        tokenSource: 'exact',
        durationMs: 4200,
        status: 'success',
      });

      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          tokenSource: 'exact',
          costUsd: '0.00000000',
          costSource: 'estimated',
        }),
      );
    });
  });
});
