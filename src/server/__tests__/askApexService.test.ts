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

jest.mock('uuid', () => ({
  v4: jest.fn(),
}));

jest.mock('@cursor/sdk', () => ({
  Agent: { create: jest.fn() },
}));

jest.mock('../utils/retry', () => ({
  retryWithBackoff: jest.fn((fn: () => any) => fn()),
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

const mockUuid = uuidv4 as jest.Mock;
const mockAgentCreate = Agent.create as jest.Mock;

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
