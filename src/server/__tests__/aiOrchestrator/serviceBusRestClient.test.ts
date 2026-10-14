import { createServiceBusRestQueueConsumer } from '../../services/aiOrchestrator/serviceBusRestClient';

describe('Service Bus REST queue consumer settlement', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = 'production';
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  function consumerWith(fetchImpl: jest.Mock) {
    return createServiceBusRestQueueConsumer({
      namespace: 'sbns-test',
      queueName: 'ai-runs-v2-result',
      credential: { getToken: async () => ({ token: 't', expiresOnTimestamp: Date.now() + 60_000 }) },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
  }

  it('completes, abandons, and dead-letters with a two-segment lock path', async () => {
    const fetchImpl = jest.fn(
      async (_url: string, _init: RequestInit) => new Response(null, { status: 200 }),
    );
    const consumer = consumerWith(fetchImpl);

    await consumer.complete('lock/1');
    await consumer.abandon('lock/1');
    await consumer.deadLetter('lock/1', 'poison');

    const expected =
      'https://sbns-test.servicebus.windows.net/ai-runs-v2-result/messages/lock%2F1/lock%2F1';
    expect(fetchImpl.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
      [expected, 'DELETE'],
      [expected, 'PUT'],
      [expected, 'PUT'],
    ]);
  });

  it('reports a rejected completion', async () => {
    const consumer = consumerWith(jest.fn(async () => new Response(null, { status: 400 })));

    await expect(consumer.complete('lock-1')).rejects.toThrow('Service Bus complete failed (400)');
  });
});
