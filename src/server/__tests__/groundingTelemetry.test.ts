import { createGroundingTelemetry } from '../services/groundingTelemetry';

describe('TBI-008 DoD-0 grounding telemetry', () => {
  it('emits every required event with numeric measurements', () => {
    // Arrange
    const emit = jest.fn();
    const telemetry = createGroundingTelemetry(emit);
    const context = {
      caller: 'interview',
      project: 'Apex',
      runId: 'run-1',
      provider: 'github' as const,
    };

    // Act
    telemetry.materialization(context, 'cold', 12_000, 'success');
    telemetry.materialization(context, 'warm', 2_000, 'success');
    telemetry.mirror(context, true);
    telemetry.mirror(context, false);
    telemetry.bundle(context, true);
    telemetry.bundle(context, false);
    telemetry.localRead(context, 14);
    telemetry.fallback(context, 'materialization-unavailable');
    telemetry.drift(context);
    telemetry.staleness(context);
    telemetry.failure(context, 'activation-failed');
    telemetry.notification(context, {
      candidateCount: 7,
      filteredCount: 4,
      aiEvaluatedCount: 3,
      notifiedCount: 1,
      deduplicatedCount: 1,
    });

    // Assert
    expect(emit.mock.calls.map(([name]) => name)).toEqual([
      'grounding.materialize',
      'grounding.materialize',
      'grounding.mirror',
      'grounding.mirror',
      'grounding.bundle',
      'grounding.bundle',
      'grounding.read.latency',
      'grounding.fallback',
      'grounding.drift',
      'grounding.staleness',
      'grounding.failure',
      'grounding.notification',
    ]);
    for (const [, , measurements] of emit.mock.calls) {
      expect(measurements).toBeDefined();
      expect(Object.values(measurements)).toEqual(
        expect.arrayContaining([expect.any(Number)])
      );
    }
    expect(emit).toHaveBeenCalledWith(
      'grounding.materialize',
      expect.objectContaining({ mode: 'cold' }),
      { durationMs: 12_000 }
    );
    expect(emit).toHaveBeenCalledWith(
      'grounding.notification',
      expect.any(Object),
      {
        candidateCount: 7,
        filteredCount: 4,
        aiEvaluatedCount: 3,
        notifiedCount: 1,
        deduplicatedCount: 1,
      }
    );
  });
});

describe('TBI-008 DoD-4 telemetry redaction', () => {
  it('does not emit credentials, source content, or local checkout paths', () => {
    // Arrange
    const emit = jest.fn();
    const telemetry = createGroundingTelemetry(emit);
    const unsafe = {
      caller: 'interview',
      project: 'Apex',
      runId: 'run-secret',
      provider: 'github' as const,
      repository: 'https://user:repo-password@example.test/org/repo?token=abc',
      sourceContent: 'const privateSource = "do-not-emit";',
      checkoutPath: 'C:\\Users\\someone\\secret-checkout',
      credential: 'credential-value',
    };

    // Act
    telemetry.failure(unsafe, 'startup-failed');

    // Assert
    const serializedProperties = JSON.stringify(emit.mock.calls[0][1]);
    expect(serializedProperties).not.toContain('repo-password');
    expect(serializedProperties).not.toContain('token=abc');
    expect(serializedProperties).not.toContain('privateSource');
    expect(serializedProperties).not.toContain('secret-checkout');
    expect(serializedProperties).not.toContain('credential-value');
    expect(emit.mock.calls[0][2]).toEqual({ failureCount: 1 });
  });
});
