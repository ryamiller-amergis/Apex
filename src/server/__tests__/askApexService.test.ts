/**
 * Unit tests for askApexService.
 *
 * The Cursor SDK and filesystem are fully mocked — no real agent or temp dirs.
 */

jest.mock('fs', () => ({
  ...jest.requireActual<typeof import('fs')>('fs'),
  mkdirSync: jest.fn(),
  existsSync: jest.fn().mockReturnValue(false),
  rmSync: jest.fn(),
}));

jest.mock('../services/projectSettingsService', () => ({
  listSkillConfigs: jest.fn().mockResolvedValue([]),
}));

const mockCallerGroundingStart = jest.fn();
jest.mock('../services/callerGroundingService', () => ({
  callerGroundingService: {
    start: mockCallerGroundingStart,
  },
}));

const mockResolveConnectionProfile = jest.fn();
jest.mock('../services/groundingProfileResolver', () => ({
  groundingProfileResolver: {
    resolveConnectionProfile: mockResolveConnectionProfile,
  },
}));

jest.mock('uuid', () => ({
  v4: jest.fn(),
}));

jest.mock('@cursor/sdk', () => ({
  Agent: { create: jest.fn() },
}));

jest.mock('../utils/retry', () => ({
  retryWithBackoff: jest.fn((fn: () => any) => fn()),
}));

// recordAiUsage is a fire-and-forget DB write; mock it so no real pg
// connection is opened (which otherwise leaks past Jest teardown).
jest.mock('../services/aiUsageService', () => ({
  recordAiUsage: jest.fn(),
  estimateTokens: jest.fn().mockReturnValue(0),
}));

import {
  createSession,
  getSession,
  subscribeToSession,
  getSessionMessages,
  sendMessage,
  closeSession,
} from '../services/askApexService';
import { v4 as uuidv4 } from 'uuid';
import { Agent } from '@cursor/sdk';
import type {
  GroundingProfileId,
  RepoReader,
} from '../../shared/types/repoReader';

const mockUuid = uuidv4 as jest.Mock;
const mockAgentCreate = Agent.create as jest.Mock;
const { retryWithBackoff: mockRetryWithBackoff } = jest.requireMock('../utils/retry') as {
  retryWithBackoff: jest.Mock;
};
const { listSkillConfigs: mockListSkillConfigs } = jest.requireMock(
  '../services/projectSettingsService',
) as {
  listSkillConfigs: jest.Mock;
};

// ── Helpers ─────────────────────────────────────────────────────────────────────

let uuidCounter = 0;
function nextUuid() {
  return `uuid-${++uuidCounter}`;
}

// ── Tests ───────────────────────────────────────────────────────────────────────

describe('askApexService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    uuidCounter = 0;
    mockUuid.mockImplementation(nextUuid);
    mockRetryWithBackoff.mockImplementation((operation: () => unknown) => operation());
    mockListSkillConfigs.mockResolvedValue([]);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ── createSession ─────────────────────────────────────────────────────────

  describe('createSession', () => {
    it('returns a unique session ID', () => {
      const sid = createSession('user-1');
      expect(sid).toBe('uuid-1');
    });

    it('creates different IDs for multiple sessions', () => {
      const sid1 = createSession('user-1');
      const sid2 = createSession('user-1');
      expect(sid1).not.toBe(sid2);
    });
  });

  // ── getSession ────────────────────────────────────────────────────────────

  describe('getSession', () => {
    it('returns the session for the correct user', () => {
      const sid = createSession('user-1');
      const session = getSession(sid, 'user-1');
      expect(session).not.toBeNull();
      expect(session!.id).toBe(sid);
    });

    it('returns null for wrong user', () => {
      const sid = createSession('user-1');
      expect(getSession(sid, 'user-2')).toBeNull();
    });

    it('returns null for non-existent session', () => {
      expect(getSession('nonexistent', 'user-1')).toBeNull();
    });
  });

  // ── idle timeout ──────────────────────────────────────────────────────────

  describe('session idle timeout', () => {
    it('destroys session after 10 minutes of inactivity', () => {
      const sid = createSession('user-1');
      expect(getSession(sid, 'user-1')).not.toBeNull();

      jest.advanceTimersByTime(10 * 60 * 1000);

      expect(getSession(sid, 'user-1')).toBeNull();
    });

    it('session survives if closed before timeout fires', () => {
      const sid = createSession('user-1');
      closeSession(sid, 'user-1');

      jest.advanceTimersByTime(10 * 60 * 1000);
      expect(getSession(sid, 'user-1')).toBeNull();
    });
  });

  // ── subscribeToSession ────────────────────────────────────────────────────

  describe('subscribeToSession', () => {
    it('returns an unsubscribe function for a valid session', () => {
      const sid = createSession('user-1');
      const cb = jest.fn();
      const unsub = subscribeToSession(sid, 'user-1', cb);
      expect(typeof unsub).toBe('function');
    });

    it('returns null for non-existent session', () => {
      const unsub = subscribeToSession('bad-id', 'user-1', jest.fn());
      expect(unsub).toBeNull();
    });

    it('returns null for wrong user', () => {
      const sid = createSession('user-1');
      const unsub = subscribeToSession(sid, 'user-2', jest.fn());
      expect(unsub).toBeNull();
    });
  });

  // ── getSessionMessages ────────────────────────────────────────────────────

  describe('getSessionMessages', () => {
    it('returns empty array for a fresh session', () => {
      const sid = createSession('user-1');
      const msgs = getSessionMessages(sid, 'user-1');
      expect(msgs).toEqual([]);
    });

    it('returns null for non-existent session', () => {
      expect(getSessionMessages('bad-id', 'user-1')).toBeNull();
    });
  });

  // ── sendMessage ───────────────────────────────────────────────────────────

  describe('sendMessage', () => {
    it('throws when session does not exist', async () => {
      await expect(sendMessage('bad-id', 'user-1', 'hello')).rejects.toThrow(
        'Session not found',
      );
    });

    it('stores user message in the session', async () => {
      const sid = createSession('user-1');

      const mockRun = {
        supports: jest.fn().mockReturnValue(true),
        stream: jest.fn().mockReturnValue({
          [Symbol.asyncIterator]: async function* () {
            yield {
              type: 'assistant',
              message: { content: [{ type: 'text', text: 'Hi there' }] },
            };
          },
        }),
      };
      mockAgentCreate.mockResolvedValue({
        send: jest.fn().mockResolvedValue(mockRun),
        [Symbol.asyncDispose]: jest.fn().mockResolvedValue(undefined),
      });

      const originalEnv = process.env.CURSOR_API_KEY;
      process.env.CURSOR_API_KEY = 'test-key';

      await sendMessage(sid, 'user-1', 'Hello');

      const msgs = getSessionMessages(sid, 'user-1');
      expect(msgs).not.toBeNull();
      expect(msgs!.length).toBeGreaterThanOrEqual(2);
      expect(msgs![0]).toMatchObject({ role: 'user', text: 'Hello' });
      expect(msgs![1]).toMatchObject({ role: 'assistant' });

      process.env.CURSOR_API_KEY = originalEnv;
    });

    it('broadcasts events to subscribers', async () => {
      const sid = createSession('user-1');
      const cb = jest.fn();
      subscribeToSession(sid, 'user-1', cb);

      const mockRun = {
        supports: jest.fn().mockReturnValue(false),
        stream: jest.fn(),
      };
      mockAgentCreate.mockResolvedValue({
        send: jest.fn().mockResolvedValue(mockRun),
        [Symbol.asyncDispose]: jest.fn().mockResolvedValue(undefined),
      });

      const originalEnv = process.env.CURSOR_API_KEY;
      process.env.CURSOR_API_KEY = 'test-key';

      await sendMessage(sid, 'user-1', 'Hi');

      const eventTypes = cb.mock.calls.map((c: any[]) => c[0].type);
      expect(eventTypes).toContain('message');
      expect(eventTypes).toContain('status');
      expect(eventTypes).toContain('done');

      process.env.CURSOR_API_KEY = originalEnv;
    });

    it('AC-0 / VT-01 Ask Apex streams through repository MCP without native-read wiring', async () => {
      // Given a live Ask Apex session and a streaming Cursor SDK agent.
      const sid = createSession('user-1');
      const cb = jest.fn();
      subscribeToSession(sid, 'user-1', cb);
      const stream = async function* () {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Repository answer' }] },
        };
      };
      mockAgentCreate.mockResolvedValue({
        send: jest.fn().mockResolvedValue({
          supports: jest.fn().mockReturnValue(true),
          stream,
        }),
        [Symbol.asyncDispose]: jest.fn().mockResolvedValue(undefined),
      });
      process.env.CURSOR_API_KEY = 'test-key';

      // When the public session API runs a real streamed turn.
      await sendMessage(sid, 'user-1', 'Read the repository');

      // Then output completes and Apex adds no native-read tool configuration.
      expect(getSessionMessages(sid, 'user-1')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: 'assistant', text: 'Repository answer' }),
        ]),
      );
      const options = mockAgentCreate.mock.calls[0][0];
      expect(options.mcpServers).toEqual({
        'github-repo': expect.objectContaining({
          url: expect.stringMatching(/\/mcp\/github-repo/),
        }),
      });
      expect(options).not.toHaveProperty('tools');
      expect(options).not.toHaveProperty('nativeTools');
      expect(cb.mock.calls.map((call: any[]) => call[0].type)).toContain('done');
    });

    it('AC-0 / DoD-0 / DoD-1 / BR-010 / VT-07 Ask Apex uses the exact pinned reader with sandbox cwd and no provider browse', async () => {
      // Given Ask Apex resolves one usable, authorized, SHA-pinned local checkout.
      const reader: jest.Mocked<RepoReader> = {
        identity: {
          provider: 'github',
          project: 'Apex',
          repo: 'AI-Pilot',
          sha: 'sha-pinned',
        },
        readFile: jest.fn().mockResolvedValue('pinned repository context'),
        listDir: jest.fn().mockResolvedValue([]),
        searchCode: jest.fn().mockResolvedValue([]),
      };
      mockListSkillConfigs.mockResolvedValue([{
        skillProvider: 'github',
        isDefault: true,
        skillRepo: 'org/AI-Pilot',
        skillBranch: 'main',
      }]);
      mockCallerGroundingStart.mockResolvedValue({
        mode: 'local',
        cwd: 'C:\\checkouts\\sha-pinned',
        profileId: 'ask-profile' as GroundingProfileId,
        resolvedSha: 'sha-pinned',
        nativeReads: true,
        release: jest.fn(),
      });
      mockResolveConnectionProfile.mockResolvedValue(reader);
      const agent = {
        send: jest.fn().mockResolvedValue({
          supports: jest.fn().mockReturnValue(false),
        }),
        [Symbol.asyncDispose]: jest.fn().mockResolvedValue(undefined),
      };
      mockAgentCreate.mockResolvedValue(agent);
      process.env.CURSOR_API_KEY = 'test-key';
      const sid = createSession('user-native');

      // When the public Ask Apex API prepares and sends the first turn.
      await sendMessage(sid, 'user-native', 'Read the pinned repository');

      // Then exactly three in-process tools serve the checkout, cwd is not the checkout,
      // provider browse is absent, and the prompt describes native sandbox semantics.
      expect(mockResolveConnectionProfile).toHaveBeenCalledWith('ask-profile');
      const options = mockAgentCreate.mock.calls[0][0];
      expect(options.local.cwd).toBe(process.cwd());
      expect(options.local.cwd).not.toBe('C:\\checkouts\\sha-pinned');
      expect(Object.keys(options.local.customTools)).toEqual([
        'get_skill_file',
        'list_repo_dir',
        'search_repo_code',
      ]);
      expect(options.mcpServers).toEqual({
        'github-repo': {
          url: 'http://localhost:3001/mcp/github-repo?enableRepoBrowse=false',
        },
      });
      expect(agent.send).toHaveBeenCalledWith(
        expect.stringContaining('local checkout-backed read-only tools'),
      );
      expect(agent.send.mock.calls[0][0]).not.toContain('must be fetched via');
    });

    it('AC-1 / BR-009 / VT-08 Ask Apex falls back to configured provider MCP when the native reader is unusable', async () => {
      // Given grounding selected native reads but the authorized checkout cannot be resolved.
      mockListSkillConfigs.mockResolvedValue([{
        skillProvider: 'github',
        isDefault: true,
        skillRepo: 'org/AI-Pilot',
        skillBranch: 'main',
      }]);
      mockCallerGroundingStart.mockResolvedValue({
        mode: 'local',
        cwd: 'C:\\checkouts\\missing',
        profileId: 'ask-missing' as GroundingProfileId,
        resolvedSha: 'sha-missing',
        nativeReads: true,
        release: jest.fn(),
      });
      mockResolveConnectionProfile.mockRejectedValue(
        new Error('authorized checkout unavailable'),
      );
      const agent = {
        send: jest.fn().mockResolvedValue({
          supports: jest.fn().mockReturnValue(false),
        }),
        [Symbol.asyncDispose]: jest.fn().mockResolvedValue(undefined),
      };
      mockAgentCreate.mockResolvedValue(agent);
      process.env.CURSOR_API_KEY = 'test-key';
      const sid = createSession('user-fallback');

      // When the public Ask Apex API prepares the turn.
      await sendMessage(sid, 'user-fallback', 'Read with fallback');

      // Then no native tools leak and provider MCP plus fallback prompt are restored.
      const options = mockAgentCreate.mock.calls[0][0];
      expect(options.local).toEqual({ cwd: process.cwd() });
      expect(options.mcpServers).toEqual({
        'github-repo': {
          url: 'http://localhost:3001/mcp/github-repo',
        },
      });
      expect(agent.send).toHaveBeenCalledWith(
        expect.stringContaining('must be fetched via the `github-repo` MCP server'),
      );
    });

    it('AC-1 / VT-04 Ask Apex retries transient creation and terminates without hanging', async () => {
      // Given the SDK transport fails transiently before a successful create.
      const sid = createSession('user-1');
      const cb = jest.fn();
      subscribeToSession(sid, 'user-1', cb);
      const agent = {
        send: jest.fn().mockResolvedValue({
          supports: jest.fn().mockReturnValue(false),
        }),
        [Symbol.asyncDispose]: jest.fn().mockResolvedValue(undefined),
      };
      mockAgentCreate
        .mockRejectedValueOnce(new Error('503 transport unavailable'))
        .mockResolvedValueOnce(agent);
      mockRetryWithBackoff.mockImplementation(
        async (
          operation: () => Promise<unknown>,
          options?: { maxRetries?: number; shouldRetry?: (error: unknown) => boolean },
        ) => {
          let lastError: unknown;
          for (let attempt = 0; attempt <= (options?.maxRetries ?? 0); attempt += 1) {
            try {
              return await operation();
            } catch (error) {
              lastError = error;
              if (!options?.shouldRetry?.(error)) throw error;
            }
          }
          throw lastError;
        },
      );
      process.env.CURSOR_API_KEY = 'test-key';

      // When the existing bounded retry policy runs.
      await sendMessage(sid, 'user-1', 'Complete after retry');

      // Then it recovers within the configured attempt bound and emits completion.
      expect(mockAgentCreate).toHaveBeenCalledTimes(2);
      expect(getSession(sid, 'user-1')?.status).toBe('idle');
      expect(cb.mock.calls.map((call: any[]) => call[0].type)).toContain('done');
    });

    it('AC-1 / VT-04 Ask Apex stream failure terminates with idle and done', async () => {
      // Given the SDK stream fails after transport creation.
      const sid = createSession('user-1');
      const cb = jest.fn();
      subscribeToSession(sid, 'user-1', cb);
      const stream = async function* () {
        throw new Error('stream destroyed');
        yield undefined;
      };
      mockAgentCreate.mockResolvedValue({
        send: jest.fn().mockResolvedValue({
          supports: jest.fn().mockReturnValue(true),
          stream,
        }),
        [Symbol.asyncDispose]: jest.fn().mockResolvedValue(undefined),
      });
      process.env.CURSOR_API_KEY = 'test-key';

      // When streaming fails.
      await sendMessage(sid, 'user-1', 'Do not hang');

      // Then the public lifecycle returns to idle and emits terminal completion.
      expect(getSession(sid, 'user-1')?.status).toBe('idle');
      expect(cb.mock.calls.map((call: any[]) => call[0].type)).toEqual(
        expect.arrayContaining(['message', 'status', 'done']),
      );
      const messages = getSessionMessages(sid, 'user-1') ?? [];
      expect(messages[messages.length - 1]?.text).toContain('stream destroyed');
    });

    it('broadcasts error when CURSOR_API_KEY is missing', async () => {
      const sid = createSession('user-1');
      const cb = jest.fn();
      subscribeToSession(sid, 'user-1', cb);

      const originalEnv = process.env.CURSOR_API_KEY;
      delete process.env.CURSOR_API_KEY;

      await sendMessage(sid, 'user-1', 'Hello');

      const errorEvents = cb.mock.calls.filter((c: any[]) => c[0].type === 'error');
      expect(errorEvents.length).toBeGreaterThanOrEqual(1);
      expect(errorEvents[0][0].error).toContain('CURSOR_API_KEY');

      process.env.CURSOR_API_KEY = originalEnv;
    });
  });

  // ── closeSession ──────────────────────────────────────────────────────────

  describe('closeSession', () => {
    it('returns true and removes the session', () => {
      const sid = createSession('user-1');
      expect(closeSession(sid, 'user-1')).toBe(true);
      expect(getSession(sid, 'user-1')).toBeNull();
    });

    it('returns false for non-existent session', () => {
      expect(closeSession('bad-id', 'user-1')).toBe(false);
    });

    it('returns false for wrong user', () => {
      const sid = createSession('user-1');
      expect(closeSession(sid, 'user-2')).toBe(false);
    });
  });
});
