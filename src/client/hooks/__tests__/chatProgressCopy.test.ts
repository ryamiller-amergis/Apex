import {
  friendlyChatProgressLabel,
  friendlyChatErrorMessage,
  friendlyDurableInteractiveLimitError,
  friendlyToolActivityLabel,
} from '../../../shared/utils/chatProgressCopy';

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
    ).toBe('Queued');
    expect(friendlyChatProgressLabel('Starting…', 'dispatched')).toBe(
      'Dispatched'
    );
    expect(
      friendlyChatProgressLabel('Waiting for your other chat to finish', 'queued')
    ).toBe('Waiting for your other chat to finish');
    expect(friendlyChatProgressLabel('Preparing project repository…')).toBe(
      'Loading…'
    );
    expect(friendlyChatProgressLabel('Refreshing the repository mirror…')).toBe(
      'Loading…'
    );
  });

  it('maps durable per-user limit codes to exact copy', () => {
    expect(friendlyDurableInteractiveLimitError('USER_INTERACTIVE_LIMIT')).toBe(
      'You already have as many AI turns running or waiting as allowed. Finish or stop one before starting another.',
    );
    expect(friendlyDurableInteractiveLimitError('USER_AGENTIC_LIMIT')).toBe(
      'You already have as many agentic AI turns running or waiting as allowed. Finish or stop one before starting another.',
    );
    expect(friendlyDurableInteractiveLimitError('OTHER')).toBeNull();
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

describe('friendlyToolActivityLabel', () => {
  it('names the kind of work for native tools', () => {
    expect(friendlyToolActivityLabel('grep')).toBe('Searching the codebase');
    expect(friendlyToolActivityLabel('glob')).toBe('Browsing folders');
    expect(friendlyToolActivityLabel('read')).toBe('Reading files');
    expect(friendlyToolActivityLabel('shell')).toBe('Running a command');
  });

  it('uses the underlying tool name for MCP calls', () => {
    expect(
      friendlyToolActivityLabel('mcp', { toolName: 'search_repo_code', keys: ['query'] }),
    ).toBe('Searching the codebase');
    expect(friendlyToolActivityLabel('mcp', { toolName: 'create_work_item' })).toBe(
      'Using a connected tool',
    );
  });

  it('falls back for unknown tools', () => {
    expect(friendlyToolActivityLabel('something_new')).toBe('Working…');
  });
});

describe('friendlyChatErrorMessage', () => {
  it('turns durable admission codes into guidance', () => {
    expect(friendlyChatErrorMessage('INTERACTIVE_V2_SKILL_UNAVAILABLE')).toMatch(/Project Settings/);
    expect(friendlyChatErrorMessage('INTERACTIVE_V2_GROUNDING_UNAVAILABLE')).toMatch(/repository/);
    expect(friendlyChatErrorMessage('Agent is already running')).toMatch(/already in progress/);
  });

  it('keeps the existing per-user limit copy', () => {
    expect(friendlyChatErrorMessage('USER_AGENTIC_LIMIT')).toBe(
      friendlyDurableInteractiveLimitError('USER_AGENTIC_LIMIT'),
    );
  });

  it('explains deadlines, blocked models, and raw turn failures', () => {
    expect(friendlyChatErrorMessage('Interactive absolute deadline exceeded')).toMatch(/too long/);
    expect(
      friendlyChatErrorMessage('Interactive turn exceeded its absolute deadline'),
    ).toMatch(/too long/);
    expect(friendlyChatErrorMessage('Interactive first event deadline exceeded')).toBe(
      "The AI didn't start answering in time. Please retry.",
    );
    expect(
      friendlyChatErrorMessage(
        'Interactive turn failed: Error: Interactive turn ended with status: error: Model Blocked for team',
      ),
    ).toMatch(/model isn't allowed/);
    expect(
      friendlyChatErrorMessage('Interactive turn failed: AiRunCallbackError: AI run callback failed (500)'),
    ).toBe('Something went wrong while answering. Please retry.');
  });

  it('passes readable messages through', () => {
    expect(friendlyChatErrorMessage('Interactive agent did not start. Please retry.')).toBe(
      'Interactive agent did not start. Please retry.',
    );
    expect(friendlyChatErrorMessage('')).toBe('Something went wrong. Please retry.');
  });
});
