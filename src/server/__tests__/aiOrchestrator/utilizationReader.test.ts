import { createUtilizationReader } from '../../services/aiOrchestrator/utilizationReader';

describe('utilizationReader', () => {
  it('counts in-flight attempts per lane and attributes them to providers', async () => {
    const reader = createUtilizationReader({
      executor: {
        execute: async () => ({
          rows: [
            {
              attempt_status: 'running',
              published_at: '2026-09-22T12:00:00.000Z',
              workload_lane: 'document',
              capacity_class: 'batch',
            },
            {
              attempt_status: 'checking_worker',
              published_at: '2026-09-22T12:00:00.000Z',
              workload_lane: 'document',
              capacity_class: 'batch',
            },
            {
              attempt_status: 'finalizing',
              published_at: '2026-09-22T12:00:00.000Z',
              workload_lane: 'document',
              capacity_class: 'batch',
            },
            {
              attempt_status: 'dispatched',
              published_at: '2026-09-22T12:00:00.000Z',
              workload_lane: 'visual',
              capacity_class: 'batch',
            },
            {
              attempt_status: 'running',
              published_at: '2026-09-22T12:00:00.000Z',
              workload_lane: 'visual',
              capacity_class: 'interactive',
            },
            {
              attempt_status: 'running',
              published_at: '2026-09-22T12:00:00.000Z',
              workload_lane: 'agentic',
              capacity_class: 'interactive',
            },
          ],
        }),
      },
    });

    const utilization = await reader.read();

    expect(utilization.laneInFlight).toEqual({
      document: 3,
      visual: 2,
      fast: 0,
      agentic: 1,
    });
    // Visual is the only Bedrock lane; everything else counts against Cursor.
    expect(utilization.bedrockInFlight).toBe(2);
    expect(utilization.cursorInFlight).toBe(4);
    expect(utilization.providerClassInFlight).toEqual({
      cursor: { batch: 3, interactive: 1 },
      bedrock: { batch: 1, interactive: 1 },
    });
  });

  it('ignores rows whose dispatch command carried no usable lane', async () => {
    const reader = createUtilizationReader({
      executor: {
        execute: async () => ({
          rows: [
            {
              attempt_status: 'running',
              published_at: '2026-09-22T12:00:00.000Z',
              workload_lane: null,
              capacity_class: 'batch',
            },
            {
              attempt_status: 'running',
              published_at: '2026-09-22T12:00:00.000Z',
              workload_lane: 'batch',
              capacity_class: 'batch',
            },
            {
              attempt_status: 'running',
              published_at: '2026-09-22T12:00:00.000Z',
              workload_lane: 'fast',
              capacity_class: 'interactive',
            },
            {
              attempt_status: 'running',
              published_at: '2026-09-22T12:00:00.000Z',
              workload_lane: 'fast',
              capacity_class: 'interactive',
            },
          ],
        }),
      },
    });

    const utilization = await reader.read();

    expect(utilization.cursorInFlight).toBe(2);
    expect(utilization.bedrockInFlight).toBe(0);
    expect(utilization.laneInFlight.fast).toBe(2);
  });

  it('reports zero utilization when nothing is in flight', async () => {
    const reader = createUtilizationReader({
      executor: { execute: async () => ({ rows: [] }) },
    });

    expect(await reader.read()).toEqual({
      cursorInFlight: 0,
      bedrockInFlight: 0,
      laneInFlight: { document: 0, visual: 0, fast: 0, agentic: 0 },
      providerClassInFlight: {
        cursor: { batch: 0, interactive: 0 },
        bedrock: { batch: 0, interactive: 0 },
      },
    });
  });

  it('does not count dispatched attempts until their outbox command is published', async () => {
    const rows: Array<{
      attempt_status: string;
      published_at: string | null;
      workload_lane: string;
      capacity_class: string;
    }> = [
      {
        attempt_status: 'dispatched',
        published_at: null,
        workload_lane: 'visual',
        capacity_class: 'interactive',
      },
      {
        attempt_status: 'dispatched',
        published_at: null,
        workload_lane: 'visual',
        capacity_class: 'interactive',
      },
    ];
    const executor = { execute: jest.fn(async () => ({ rows })) };
    const reader = createUtilizationReader({ executor });

    expect(await reader.read()).toMatchObject({
      bedrockInFlight: 0,
      laneInFlight: { visual: 0 },
      providerClassInFlight: {
        bedrock: { batch: 0, interactive: 0 },
      },
    });

    rows[0].published_at = '2026-09-22T12:00:00.000Z';
    rows[1].published_at = '2026-09-22T12:00:01.000Z';
    expect(await reader.read()).toMatchObject({
      bedrockInFlight: 2,
      laneInFlight: { visual: 2 },
      providerClassInFlight: {
        bedrock: { batch: 0, interactive: 2 },
      },
    });
  });
});
