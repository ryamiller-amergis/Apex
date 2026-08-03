import type { GroundingMetricSample } from '../../shared/types/groundingOperations';
import { createGroundingGateService } from '../services/groundingGateService';

const passingSample: GroundingMetricSample = {
  sampleSize: 100,
  fallbackRate: 0.019,
  warmMaterializationP95Ms: 9_999,
  coldMaterializationP95Ms: 59_999,
  mirrorHitRate: 0.901,
  groundingFailureCount: 0,
};

describe('BR-011 / TBI-008 DoD-1 advancement gates', () => {
  it('reports every approved threshold and supporting value for sample >= 100', async () => {
    // Arrange
    const source = { loadSample: jest.fn().mockResolvedValue(passingSample) };
    const service = createGroundingGateService(source);

    // Act
    const result = await service.evaluate('design-module');

    // Assert
    expect(source.loadSample).toHaveBeenCalledWith('design-module');
    expect(result).toEqual(
      expect.objectContaining({
        cohort: 'design-module',
        sampleSize: 100,
        minimumSampleSize: 100,
        eligible: true,
        blockingGates: [],
      })
    );
    expect(result.gates).toEqual([
      expect.objectContaining({
        id: 'fallback-rate',
        value: 0.019,
        threshold: 0.02,
        status: 'pass',
      }),
      expect.objectContaining({
        id: 'warm-materialization-p95',
        value: 9_999,
        threshold: 10_000,
        status: 'pass',
      }),
      expect.objectContaining({
        id: 'cold-materialization-p95',
        value: 59_999,
        threshold: 60_000,
        status: 'pass',
      }),
      expect.objectContaining({
        id: 'mirror-hit-rate',
        value: 0.901,
        threshold: 0.9,
        status: 'pass',
      }),
      expect.objectContaining({
        id: 'grounding-failures',
        value: 0,
        threshold: 0,
        status: 'pass',
      }),
    ]);
  });

  it('treats missing metrics and below-minimum samples as unknown and blocking', async () => {
    // Arrange
    const source = {
      loadSample: jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ...passingSample, sampleSize: 99 }),
    };
    const service = createGroundingGateService(source);

    // Act
    const missing = await service.evaluate('missing');
    const undersized = await service.evaluate('undersized');

    // Assert
    for (const result of [missing, undersized]) {
      expect(result.eligible).toBe(false);
      expect(result.gates).toHaveLength(5);
      expect(result.gates.every((gate) => gate.status === 'unknown')).toBe(
        true
      );
      expect(result.blockingGates).toEqual(result.gates.map((gate) => gate.id));
    }
    expect(missing.sampleSize).toBe(0);
    expect(undersized.sampleSize).toBe(99);
  });

  it('blocks and identifies every failed or individually missing metric', async () => {
    // Arrange
    const source = {
      loadSample: jest.fn().mockResolvedValue({
        ...passingSample,
        fallbackRate: 0.03,
        warmMaterializationP95Ms: null,
      }),
    };
    const service = createGroundingGateService(source);

    // Act
    const result = await service.evaluate('mixed');

    // Assert
    expect(result.eligible).toBe(false);
    expect(result.blockingGates).toEqual([
      'fallback-rate',
      'warm-materialization-p95',
    ]);
    expect(
      result.gates.find((gate) => gate.id === 'fallback-rate')?.status
    ).toBe('fail');
    expect(
      result.gates.find((gate) => gate.id === 'warm-materialization-p95')
        ?.status
    ).toBe('unknown');
  });
});

describe('BR-011 / TBI-008 DoD-4 strict gate boundaries', () => {
  it('fails exact 2%, 10s, 60s, and 90% boundaries while zero failures passes', async () => {
    // Arrange
    const source = {
      loadSample: jest.fn().mockResolvedValue({
        sampleSize: 100,
        fallbackRate: 0.02,
        warmMaterializationP95Ms: 10_000,
        coldMaterializationP95Ms: 60_000,
        mirrorHitRate: 0.9,
        groundingFailureCount: 0,
      } satisfies GroundingMetricSample),
    };
    const service = createGroundingGateService(source);

    // Act
    const result = await service.evaluate('boundary');

    // Assert
    expect(result.eligible).toBe(false);
    expect(result.blockingGates).toEqual([
      'fallback-rate',
      'warm-materialization-p95',
      'cold-materialization-p95',
      'mirror-hit-rate',
    ]);
    expect(
      result.gates.find((gate) => gate.id === 'grounding-failures')?.status
    ).toBe('pass');
  });
});
