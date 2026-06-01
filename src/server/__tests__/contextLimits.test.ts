import {
  MODEL_CONTEXT_TOKEN_LIMITS,
  DEFAULT_CONTEXT_TOKEN_LIMIT,
} from '../../shared/config/contextLimits';

describe('contextLimits', () => {
  describe('DEFAULT_CONTEXT_TOKEN_LIMIT', () => {
    it('is a positive number', () => {
      expect(typeof DEFAULT_CONTEXT_TOKEN_LIMIT).toBe('number');
      expect(DEFAULT_CONTEXT_TOKEN_LIMIT).toBeGreaterThan(0);
    });
  });

  describe('MODEL_CONTEXT_TOKEN_LIMITS', () => {
    it('contains at least one model entry', () => {
      expect(Object.keys(MODEL_CONTEXT_TOKEN_LIMITS).length).toBeGreaterThan(0);
    });

    it.each(Object.entries(MODEL_CONTEXT_TOKEN_LIMITS))(
      'model "%s" has a positive numeric limit (%d)',
      (model, limit) => {
        expect(typeof limit).toBe('number');
        expect(limit).toBeGreaterThan(0);
      },
    );

    it('includes the expected known models', () => {
      const models = Object.keys(MODEL_CONTEXT_TOKEN_LIMITS);
      expect(models).toContain('composer-2');
      expect(models).toContain('claude-opus-4-6');
      expect(models).toContain('gemini-3.1-pro');
    });
  });
});
