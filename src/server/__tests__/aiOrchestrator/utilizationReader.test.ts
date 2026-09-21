import { createUtilizationReader } from '../../services/aiOrchestrator/utilizationReader';

describe('utilizationReader', () => {
  it('counts in-flight attempts per lane and attributes them to providers', async () => {
    const reader = createUtilizationReader({
      executor: {
        execute: async () => ({
          rows: [
            { workload_lane: 'document', in_flight: 3 },
            { workload_lane: 'visual', in_flight: 2 },
            { workload_lane: 'agentic', in_flight: 1 },
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
  });

  it('ignores rows whose dispatch command carried no usable lane', async () => {
    const reader = createUtilizationReader({
      executor: {
        execute: async () => ({
          rows: [
            { workload_lane: null, in_flight: 5 },
            { workload_lane: 'batch', in_flight: 4 },
            { workload_lane: 'fast', in_flight: 2 },
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
    });
  });
});
