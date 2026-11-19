import { trackEvent } from '../../services/telemetry';
import type { HarnessTimingMetric, HarnessTimingRecord } from '../types';
import {
  CHAT_HARNESS_TIMING_EVENT,
  createChatHarnessTelemetry,
  recordHarnessTiming,
} from '../telemetry';
import {
  FIXTURE_CMD_ID_1,
  FIXTURE_CMD_ID_2,
  FIXTURE_RUN_ID,
  FIXTURE_THREAD_ID,
} from '../testFixtures';

jest.mock('../../services/telemetry', () => ({
  trackEvent: jest.fn(),
}));

const ALLOWED_KEYS = new Set([
  'area',
  'threadId',
  'runId',
  'commandId',
  'metric',
  'durationMs',
  'status',
]);

const SENTINEL = 'SECRET_PROMPT_SENTINEL_999';

function getTimingBuffer(): HarnessTimingRecord[] | undefined {
  return (globalThis as { __APEX_CHAT_TIMINGS__?: HarnessTimingRecord[] })
    .__APEX_CHAT_TIMINGS__;
}

function setTimingBuffer(value: unknown): void {
  (globalThis as { __APEX_CHAT_TIMINGS__?: unknown }).__APEX_CHAT_TIMINGS__ = value;
}

function clearTimingBuffer(): void {
  delete (globalThis as { __APEX_CHAT_TIMINGS__?: unknown }).__APEX_CHAT_TIMINGS__;
}

describe('S4 chatHarness telemetry module', () => {
  const mockedTrackEvent = trackEvent as jest.MockedFunction<typeof trackEvent>;

  beforeEach(() => {
    mockedTrackEvent.mockReset();
    clearTimingBuffer();
  });

  afterEach(() => {
    clearTimingBuffer();
  });

  describe('VT-40 / BR-007 privacy filtering and string-only properties', () => {
    it('strips non-allowlisted fields and never leaks sentinel text to trackEvent or __APEX_CHAT_TIMINGS__', () => {
      const buffer: HarnessTimingRecord[] = [];
      setTimingBuffer(buffer);

      let clock = 1000;
      const now = () => clock;

      // Pass extra forbidden keys at runtime alongside a full turn lifecycle
      const unsafeInput = {
        area: 'agent-home',
        threadId: FIXTURE_THREAD_ID,
        runId: FIXTURE_RUN_ID,
        commandId: FIXTURE_CMD_ID_1,
        metric: 'send_to_first_feedback' as HarnessTimingMetric,
        durationMs: 42.7,
        status: 'ok',
        text: SENTINEL,
        prompt: SENTINEL,
        steer: SENTINEL,
        summary: SENTINEL,
        message: SENTINEL,
        args: { target: SENTINEL },
        result: SENTINEL,
        extraKey: SENTINEL,
      };

      recordHarnessTiming(unsafeInput as Parameters<typeof recordHarnessTiming>[0], { now });

      const telemetry = createChatHarnessTelemetry({
        area: 'agent-home',
        threadId: FIXTURE_THREAD_ID,
        now,
      });

      // Simulate a full turn where user message / steer / summary carry sentinel text outside telemetry
      const userTurnPayload = {
        commandId: FIXTURE_CMD_ID_1,
        text: SENTINEL,
        steer: SENTINEL,
        summary: SENTINEL,
      };

      clock = 2000;
      telemetry.markSendStarted(userTurnPayload.commandId);
      clock = 2055;
      telemetry.markFirstFeedback(userTurnPayload.commandId);
      clock = 2210;
      telemetry.markFirstToken(FIXTURE_RUN_ID);
      clock = 2400;
      telemetry.markTurnActivity();
      clock = 2450;
      telemetry.markSteerStarted(FIXTURE_CMD_ID_2);
      clock = 2525;
      telemetry.markSteerAcknowledged(FIXTURE_CMD_ID_2, 'applied');
      clock = 2700;
      telemetry.markTurnFinished('ok', FIXTURE_RUN_ID);

      expect(mockedTrackEvent.mock.calls.length).toBeGreaterThanOrEqual(5);

      for (const [eventName, props] of mockedTrackEvent.mock.calls) {
        expect(eventName).toBe(CHAT_HARNESS_TIMING_EVENT);
        expect(eventName).toBe('chat_harness_client_timing');
        expect(props).toBeDefined();

        const entries = Object.entries(props ?? {});
        for (const [key, value] of entries) {
          expect(ALLOWED_KEYS.has(key)).toBe(true);
          expect(typeof value).toBe('string');
          expect(value).not.toContain(SENTINEL);
        }

        expect(JSON.stringify(props)).not.toContain(SENTINEL);
      }

      // Verify in-page timing buffer entries contain no sentinel and no forbidden keys
      expect(buffer.length).toBe(mockedTrackEvent.mock.calls.length);
      const allowedRecordKeys = new Set([
        'area',
        'threadId',
        'runId',
        'commandId',
        'metric',
        'durationMs',
        'status',
        'recordedAt',
      ]);

      for (const record of buffer) {
        for (const key of Object.keys(record)) {
          expect(allowedRecordKeys.has(key)).toBe(true);
        }
        expect(JSON.stringify(record)).not.toContain(SENTINEL);
      }

      // Rounded non-negative integer string for durationMs (42.7 -> '43')
      expect(mockedTrackEvent.mock.calls[0]?.[1]).toEqual({
        area: 'agent-home',
        threadId: FIXTURE_THREAD_ID,
        runId: FIXTURE_RUN_ID,
        commandId: FIXTURE_CMD_ID_1,
        metric: 'send_to_first_feedback',
        durationMs: '43',
        status: 'ok',
      });
    });

    it('clamps negative and non-finite durations to 0', () => {
      recordHarnessTiming({
        area: 'brainstorm',
        threadId: FIXTURE_THREAD_ID,
        metric: 'send_to_first_token',
        durationMs: -50,
        status: 'ok',
      });
      recordHarnessTiming({
        area: 'brainstorm',
        threadId: FIXTURE_THREAD_ID,
        metric: 'longest_silent_gap',
        durationMs: Number.NaN,
        status: 'ok',
      });

      expect(mockedTrackEvent).toHaveBeenNthCalledWith(1, 'chat_harness_client_timing', {
        area: 'brainstorm',
        threadId: FIXTURE_THREAD_ID,
        metric: 'send_to_first_token',
        durationMs: '0',
        status: 'ok',
      });
      expect(mockedTrackEvent).toHaveBeenNthCalledWith(2, 'chat_harness_client_timing', {
        area: 'brainstorm',
        threadId: FIXTURE_THREAD_ID,
        metric: 'longest_silent_gap',
        durationMs: '0',
        status: 'ok',
      });
    });
  });

  describe('all 8 harness timing metrics with injected monotonic clock', () => {
    it('measures send_to_first_feedback, send_to_first_token, and longest_silent_gap accurately', () => {
      let clock = 1000;
      const emit = jest.fn();
      const telemetry = createChatHarnessTelemetry({
        area: 'interview',
        threadId: FIXTURE_THREAD_ID,
        now: () => clock,
        emit,
      });

      telemetry.markSendStarted(FIXTURE_CMD_ID_1);

      // First feedback after 85ms; second call in same turn should be ignored
      clock = 1085;
      telemetry.markFirstFeedback(FIXTURE_CMD_ID_1);
      clock = 1120;
      telemetry.markFirstFeedback(FIXTURE_CMD_ID_1);

      // First token after 340ms from send; second call in same turn should be ignored
      clock = 1340;
      telemetry.markFirstToken(FIXTURE_RUN_ID);
      clock = 1500;
      telemetry.markFirstToken(FIXTURE_RUN_ID);

      // Activity events: gap from 1340 -> 1600 = 260ms, then 1600 -> 2450 = 850ms (max)
      clock = 1600;
      telemetry.markTurnActivity();
      clock = 2450;
      telemetry.markTurnActivity();

      // Finish turn at 2600 (gap 150ms < 850ms)
      clock = 2600;
      telemetry.markTurnFinished('ok', FIXTURE_RUN_ID);
      // Duplicate finish should be a no-op
      clock = 3000;
      telemetry.markTurnFinished('ok', FIXTURE_RUN_ID);

      expect(emit).toHaveBeenCalledTimes(3);
      expect(emit).toHaveBeenNthCalledWith(1, 'chat_harness_client_timing', {
        area: 'interview',
        threadId: FIXTURE_THREAD_ID,
        commandId: FIXTURE_CMD_ID_1,
        metric: 'send_to_first_feedback',
        durationMs: '85',
        status: 'ok',
      });
      expect(emit).toHaveBeenNthCalledWith(2, 'chat_harness_client_timing', {
        area: 'interview',
        threadId: FIXTURE_THREAD_ID,
        runId: FIXTURE_RUN_ID,
        commandId: FIXTURE_CMD_ID_1,
        metric: 'send_to_first_token',
        durationMs: '340',
        status: 'ok',
      });
      expect(emit).toHaveBeenNthCalledWith(3, 'chat_harness_client_timing', {
        area: 'interview',
        threadId: FIXTURE_THREAD_ID,
        runId: FIXTURE_RUN_ID,
        commandId: FIXTURE_CMD_ID_1,
        metric: 'longest_silent_gap',
        durationMs: '850',
        status: 'ok',
      });
    });

    it('measures stop_ui_halt and stop_confirmed accurately', () => {
      let clock = 5000;
      const emit = jest.fn();
      const telemetry = createChatHarnessTelemetry({
        area: 'prd-assistant',
        threadId: FIXTURE_THREAD_ID,
        now: () => clock,
        emit,
      });

      telemetry.markStopRequested(FIXTURE_CMD_ID_1);

      clock = 5018;
      telemetry.markStopUiHalted(FIXTURE_CMD_ID_1);
      // Duplicate halt ignored
      clock = 5050;
      telemetry.markStopUiHalted(FIXTURE_CMD_ID_1);

      clock = 5320;
      telemetry.markStopConfirmed(FIXTURE_CMD_ID_1, 'applied');
      // Duplicate confirmation ignored
      clock = 5500;
      telemetry.markStopConfirmed(FIXTURE_CMD_ID_1, 'applied');

      expect(emit).toHaveBeenCalledTimes(2);
      expect(emit).toHaveBeenNthCalledWith(1, 'chat_harness_client_timing', {
        area: 'prd-assistant',
        threadId: FIXTURE_THREAD_ID,
        commandId: FIXTURE_CMD_ID_1,
        metric: 'stop_ui_halt',
        durationMs: '18',
        status: 'ok',
      });
      expect(emit).toHaveBeenNthCalledWith(2, 'chat_harness_client_timing', {
        area: 'prd-assistant',
        threadId: FIXTURE_THREAD_ID,
        commandId: FIXTURE_CMD_ID_1,
        metric: 'stop_confirmed',
        durationMs: '320',
        status: 'applied',
      });
    });

    it('measures steer_acknowledged independently for concurrent steer commands', () => {
      let clock = 10_000;
      const emit = jest.fn();
      const telemetry = createChatHarnessTelemetry({
        area: 'agent-home',
        threadId: FIXTURE_THREAD_ID,
        now: () => clock,
        emit,
      });

      telemetry.markSteerStarted(FIXTURE_CMD_ID_1);
      clock = 10_040;
      telemetry.markSteerStarted(FIXTURE_CMD_ID_2);

      clock = 10_190;
      telemetry.markSteerAcknowledged(FIXTURE_CMD_ID_2, 'queued');
      clock = 10_275;
      telemetry.markSteerAcknowledged(FIXTURE_CMD_ID_1, 'applied');
      // Duplicate acknowledgement ignored
      clock = 10_400;
      telemetry.markSteerAcknowledged(FIXTURE_CMD_ID_1, 'applied');

      expect(emit).toHaveBeenCalledTimes(2);
      expect(emit).toHaveBeenNthCalledWith(1, 'chat_harness_client_timing', {
        area: 'agent-home',
        threadId: FIXTURE_THREAD_ID,
        commandId: FIXTURE_CMD_ID_2,
        metric: 'steer_acknowledged',
        durationMs: '150',
        status: 'queued',
      });
      expect(emit).toHaveBeenNthCalledWith(2, 'chat_harness_client_timing', {
        area: 'agent-home',
        threadId: FIXTURE_THREAD_ID,
        commandId: FIXTURE_CMD_ID_1,
        metric: 'steer_acknowledged',
        durationMs: '275',
        status: 'applied',
      });
    });

    it('measures reconnect_restored and reload_restored accurately', () => {
      let clock = 20_000;
      const emit = jest.fn();
      const telemetry = createChatHarnessTelemetry({
        area: 'dev-session',
        threadId: FIXTURE_THREAD_ID,
        now: () => clock,
        emit,
      });

      // Reconnect: preserve first disconnect timestamp across retry attempts
      telemetry.markDisconnected();
      clock = 20_500;
      telemetry.markDisconnected();
      clock = 21_450;
      telemetry.markReconnected();
      // Calling reconnected without a disconnect is a no-op
      clock = 22_000;
      telemetry.markReconnected();

      // Reload restore
      clock = 25_000;
      telemetry.markReloadStarted();
      clock = 25_615;
      telemetry.markReloadRestored();
      // Duplicate reload restore is a no-op
      clock = 26_000;
      telemetry.markReloadRestored();

      expect(emit).toHaveBeenCalledTimes(2);
      expect(emit).toHaveBeenNthCalledWith(1, 'chat_harness_client_timing', {
        area: 'dev-session',
        threadId: FIXTURE_THREAD_ID,
        metric: 'reconnect_restored',
        durationMs: '1450',
        status: 'ok',
      });
      expect(emit).toHaveBeenNthCalledWith(2, 'chat_harness_client_timing', {
        area: 'dev-session',
        threadId: FIXTURE_THREAD_ID,
        metric: 'reload_restored',
        durationMs: '615',
        status: 'ok',
      });
    });
  });

  describe('in-page Playwright timing buffer (window.__APEX_CHAT_TIMINGS__)', () => {
    it('does NOT create window.__APEX_CHAT_TIMINGS__ when absent', () => {
      expect(getTimingBuffer()).toBeUndefined();
      expect('__APEX_CHAT_TIMINGS__' in globalThis).toBe(false);

      recordHarnessTiming({
        area: 'agent-home',
        threadId: FIXTURE_THREAD_ID,
        metric: 'reload_restored',
        durationMs: 210,
        status: 'ok',
      });

      expect(getTimingBuffer()).toBeUndefined();
      expect('__APEX_CHAT_TIMINGS__' in globalThis).toBe(false);
    });

    it('does NOT overwrite a non-array __APEX_CHAT_TIMINGS__ value', () => {
      const sentinelObj = { untouched: true };
      setTimingBuffer(sentinelObj);

      recordHarnessTiming({
        area: 'agent-home',
        threadId: FIXTURE_THREAD_ID,
        metric: 'reconnect_restored',
        durationMs: 300,
        status: 'ok',
      });

      expect(getTimingBuffer()).toBe(sentinelObj);
    });

    it('populates __APEX_CHAT_TIMINGS__ with sanitized HarnessTimingRecord entries when initialized as an array', () => {
      const buffer: HarnessTimingRecord[] = [];
      setTimingBuffer(buffer);

      let clock = 9000;
      const telemetry = createChatHarnessTelemetry({
        area: 'ask-apex',
        threadId: FIXTURE_THREAD_ID,
        now: () => clock,
      });

      telemetry.markSendStarted(FIXTURE_CMD_ID_1);
      clock = 9064;
      telemetry.markFirstFeedback(FIXTURE_CMD_ID_1);
      clock = 9210;
      telemetry.markFirstToken(FIXTURE_RUN_ID);
      clock = 9510;
      telemetry.markTurnFinished('cancelled', FIXTURE_RUN_ID);

      expect(buffer).toEqual([
        {
          area: 'ask-apex',
          threadId: FIXTURE_THREAD_ID,
          commandId: FIXTURE_CMD_ID_1,
          metric: 'send_to_first_feedback',
          durationMs: 64,
          status: 'ok',
          recordedAt: 9064,
        },
        {
          area: 'ask-apex',
          threadId: FIXTURE_THREAD_ID,
          runId: FIXTURE_RUN_ID,
          commandId: FIXTURE_CMD_ID_1,
          metric: 'send_to_first_token',
          durationMs: 210,
          status: 'ok',
          recordedAt: 9210,
        },
        {
          area: 'ask-apex',
          threadId: FIXTURE_THREAD_ID,
          runId: FIXTURE_RUN_ID,
          commandId: FIXTURE_CMD_ID_1,
          metric: 'longest_silent_gap',
          durationMs: 300,
          status: 'cancelled',
          recordedAt: 9510,
        },
      ]);
    });
  });
});
