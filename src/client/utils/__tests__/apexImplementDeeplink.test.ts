import { buildApexImplementPrompt, buildCursorPromptDeeplink } from '../../utils/cursorDeeplink';

describe('buildApexImplementPrompt', () => {
  it('returns the slash-command with the given feature ADO id', () => {
    expect(buildApexImplementPrompt(42)).toBe('/apex-implement-feature 42');
  });

  it('works for any positive integer', () => {
    expect(buildApexImplementPrompt(12345)).toBe('/apex-implement-feature 12345');
  });
});

describe('buildCursorPromptDeeplink with apex-implement-feature prompt', () => {
  it('encodes the prompt into a desktop cursor:// link', () => {
    const prompt = buildApexImplementPrompt(99);
    const { desktop } = buildCursorPromptDeeplink(prompt);
    expect(desktop).toContain('cursor://');
    expect(desktop).toContain(encodeURIComponent(prompt));
  });

  it('encodes the prompt into a web link', () => {
    const prompt = buildApexImplementPrompt(99);
    const { web } = buildCursorPromptDeeplink(prompt);
    expect(web).toContain('cursor.com');
    expect(web).toContain(encodeURIComponent(prompt));
  });
});
