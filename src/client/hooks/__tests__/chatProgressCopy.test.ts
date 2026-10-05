import { friendlyChatProgressLabel } from '../../../shared/utils/chatProgressCopy';

describe('friendlyChatProgressLabel', () => {
  it('maps native/MCP file reads to Reading', () => {
    expect(friendlyChatProgressLabel('mcp:get_skill_file running')).toBe(
      'Reading…'
    );
    expect(friendlyChatProgressLabel('get_skill_file started')).toBe(
      'Reading…'
    );
    expect(
      friendlyChatProgressLabel('github-repo:get_skill_file running')
    ).toBe('Reading…');
  });

  it('maps tree walk and search', () => {
    expect(friendlyChatProgressLabel('mcp:list_repo_dir running')).toBe(
      'Listing…'
    );
    expect(friendlyChatProgressLabel('mcp:search_repo_code running')).toBe(
      'Searching…'
    );
  });

  it('maps actor and mirror stage labels', () => {
    expect(
      friendlyChatProgressLabel('Queued — waiting for available worker', 'queued')
    ).toBe('Waiting…');
    expect(friendlyChatProgressLabel('Starting…', 'dispatched')).toBe(
      'Starting…'
    );
    expect(friendlyChatProgressLabel('Preparing project repository…')).toBe(
      'Loading…'
    );
    expect(friendlyChatProgressLabel('Refreshing the repository mirror…')).toBe(
      'Loading…'
    );
  });

  it('is idempotent on already-friendly copy', () => {
    expect(friendlyChatProgressLabel('Reading…')).toBe('Reading…');
  });

  it('leaves unrelated worker labels alone', () => {
    expect(friendlyChatProgressLabel('Running focused tests', 'testing')).toBe(
      'Running focused tests'
    );
  });

  it('uses phase copy when detail is empty', () => {
    expect(friendlyChatProgressLabel(undefined, 'analysis')).toBe('Thinking…');
    expect(friendlyChatProgressLabel(null, 'planning')).toBe('Planning…');
  });

  it('keeps grounding failure copy', () => {
    expect(
      friendlyChatProgressLabel(
        'Repository preparation timed out. Please retry.',
        'setup'
      )
    ).toBe('Repository preparation timed out. Please retry.');
  });
});
