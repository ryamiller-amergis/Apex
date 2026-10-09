const mockModelsList = jest.fn();
const mockAgentCreate = jest.fn();

jest.mock('@cursor/sdk', () => ({
  Cursor: { models: { list: (...args: unknown[]) => mockModelsList(...args) } },
  Agent: { create: (...args: unknown[]) => mockAgentCreate(...args) },
}));

import {
  fetchAvailableModels,
  modelProbeInFlightForTests,
  requestModelAvailabilityProbe,
  resetModelsServiceForTests,
  resolveCursorModelChoice,
} from '../services/modelsService';

const levels = (...values: string[]) => values.map((value) => ({ value }));

const CATALOG = [
  { id: 'auto-smart', displayName: 'Auto', parameters: [{ id: 'optimize_for', values: levels('cost') }] },
  { id: 'default', displayName: 'Auto', parameters: [] },
  {
    id: 'grok-4.7',
    displayName: 'Grok 4.7',
    parameters: [{ id: 'reasoning_effort', values: levels('low', 'medium', 'high') }],
  },
  { id: 'grok-4.6', displayName: 'Grok 4.6', parameters: [{ id: 'effort', values: levels('low', 'medium', 'high') }] },
  {
    id: 'claude-opus-5-5',
    displayName: 'Claude Opus 5.5',
    parameters: [{ id: 'effort', values: levels('low', 'medium', 'high') }],
  },
];

const BLOCKED = {
  status: 'error',
  error: { message: 'Model Blocked This model has been blocked by your team admin settings.' },
};

function agentFinishingWith(result: unknown) {
  return {
    send: jest.fn().mockResolvedValue({ wait: jest.fn().mockResolvedValue(result) }),
    [Symbol.asyncDispose]: jest.fn().mockResolvedValue(undefined),
  };
}

function blockModels(...ids: string[]) {
  mockAgentCreate.mockImplementation(async ({ model }: { model: { id: string } }) =>
    agentFinishingWith(ids.includes(model.id) ? BLOCKED : { status: 'finished' }),
  );
}

const ids = (models: Array<{ id: string }>) => models.map((m) => m.id);

describe('modelsService', () => {
  const originalApiKey = process.env.CURSOR_API_KEY;

  beforeEach(() => {
    resetModelsServiceForTests();
    jest.restoreAllMocks();
    mockModelsList.mockReset().mockResolvedValue(CATALOG);
    mockAgentCreate.mockReset();
    delete process.env.CURSOR_API_KEY;
  });

  afterAll(() => {
    if (originalApiKey === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = originalApiKey;
  });

  it('lists a single Auto and does not probe without an API key', async () => {
    expect(ids(await fetchAvailableModels())).toEqual([
      'default',
      'grok-4.7',
      'grok-4.6',
      'claude-opus-5-5',
    ]);
    expect(modelProbeInFlightForTests()).toBeNull();
    expect(mockAgentCreate).not.toHaveBeenCalled();
  });

  it('maps a retired model to its family and keeps an effort the model takes as `effort`', async () => {
    await expect(resolveCursorModelChoice('claude-opus-4-6', 'high')).resolves.toEqual({
      model: 'claude-opus-5-5',
      effort: 'high',
    });
  });

  it('drops the effort when the model takes it under another parameter name', async () => {
    await expect(resolveCursorModelChoice('grok-4.7', 'high')).resolves.toEqual({
      model: 'grok-4.7',
      effort: undefined,
    });
  });

  it('keeps the request unchanged when the catalog cannot be read', async () => {
    mockModelsList.mockRejectedValue(new Error('offline'));
    await expect(resolveCursorModelChoice('claude-opus-4-6', 'low')).resolves.toEqual({
      model: 'claude-opus-4-6',
      effort: 'low',
    });
  });

  it('hides a model the Cursor team admin blocked once the probe reports it', async () => {
    process.env.CURSOR_API_KEY = 'test-key';
    blockModels('grok-4.7');

    expect(ids(await fetchAvailableModels())).toContain('grok-4.7');
    await modelProbeInFlightForTests();

    expect(ids(await fetchAvailableModels())).not.toContain('grok-4.7');
    expect(mockAgentCreate.mock.calls.map(([options]) => options.model.id)).not.toContain('auto-smart');
    await expect(resolveCursorModelChoice('grok-4.7', undefined)).resolves.toEqual({
      model: 'grok-4.6',
      effort: undefined,
    });
  });

  it('disposes a probe agent created after its timeout and waits for it before the next round', async () => {
    process.env.CURSOR_API_KEY = 'test-key';
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      let finishCreate: (agent: unknown) => void = () => {};
      const lateAgent = agentFinishingWith({ status: 'finished' });
      mockAgentCreate.mockImplementation(async ({ model }: { model: { id: string } }) =>
        model.id === 'default'
          ? new Promise((resolve) => {
              finishCreate = resolve;
            })
          : agentFinishingWith({ status: 'finished' }),
      );

      await fetchAvailableModels();
      await jest.advanceTimersByTimeAsync(60 * 1000);
      await modelProbeInFlightForTests();

      jest.setSystemTime(Date.now() + 6 * 60 * 1000);
      requestModelAvailabilityProbe();
      await new Promise((resolve) => setImmediate(resolve));
      expect(modelProbeInFlightForTests()).toBeNull();

      finishCreate(lateAgent);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(lateAgent.send).not.toHaveBeenCalled();
      expect(lateAgent[Symbol.asyncDispose]).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('probes once per interval, and again soon after a run reports a block', async () => {
    process.env.CURSOR_API_KEY = 'test-key';
    blockModels('grok-4.7');
    const start = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(start);

    await fetchAvailableModels();
    await modelProbeInFlightForTests();
    const probedOnce = mockAgentCreate.mock.calls.length;
    await fetchAvailableModels();
    expect(modelProbeInFlightForTests()).toBeNull();
    expect(mockAgentCreate).toHaveBeenCalledTimes(probedOnce);

    blockModels();
    clock.mockReturnValue(start + 6 * 60 * 1000);
    requestModelAvailabilityProbe();
    await new Promise((resolve) => setImmediate(resolve));
    await modelProbeInFlightForTests();

    expect(mockAgentCreate.mock.calls.length).toBeGreaterThan(probedOnce);
    expect(ids(await fetchAvailableModels())).toContain('grok-4.7');
  });
});
