import { cursorPromptBlobUrl, resolveCursorPromptBlobAccount } from '../services/cursorPromptStore';

describe('cursor prompt blob', () => {
  const keys = [
    'CURSOR_PROMPT_BLOB_ACCOUNT_NAME',
    'CURSOR_PROMPT_BLOB_CONTAINER_NAME',
    'GROUNDING_BLOB_ACCOUNT_NAME',
    'PDF_BLOB_ACCOUNT_NAME',
  ] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

  afterEach(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });

  it('builds a private blob URL on the shared account', () => {
    process.env.CURSOR_PROMPT_BLOB_CONTAINER_NAME = 'cursor-prompts';
    expect(cursorPromptBlobUrl('stapexdevasync', 'prompts/abc.txt')).toBe(
      'https://stapexdevasync.blob.core.windows.net/cursor-prompts/prompts/abc.txt',
    );
  });

  it('uses the grounding account when the prompt account is unset', () => {
    delete process.env.CURSOR_PROMPT_BLOB_ACCOUNT_NAME;
    delete process.env.PDF_BLOB_ACCOUNT_NAME;
    process.env.GROUNDING_BLOB_ACCOUNT_NAME = 'stapexprdasync';
    expect(resolveCursorPromptBlobAccount()).toBe('stapexprdasync');
  });

  it('fails when no shared blob account is configured', () => {
    delete process.env.CURSOR_PROMPT_BLOB_ACCOUNT_NAME;
    delete process.env.GROUNDING_BLOB_ACCOUNT_NAME;
    delete process.env.PDF_BLOB_ACCOUNT_NAME;
    expect(() => resolveCursorPromptBlobAccount()).toThrow('Shared blob account is not configured');
  });
});
