export const DEFAULT_CONTEXT_TOKEN_LIMIT = 200_000;

export const MODEL_CONTEXT_TOKEN_LIMITS: Record<string, number> = {
  'composer-2': 200_000,
  'claude-opus-4-6': 200_000,
  'claude-sonnet-4-6': 200_000,
  'gpt-5.5': 200_000,
  'gemini-3.1-pro': 1_000_000,
};
