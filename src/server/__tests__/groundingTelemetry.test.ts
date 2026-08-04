import {
  createGroundingTelemetry,
} from '../services/groundingTelemetry';

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

describe('TBI-004 DoD-4 / VT-06 lifecycle telemetry', () => {
  it('emits content-free recreation and binding-write events', () => {
    const emit = jest.fn();
    const telemetry = createGroundingTelemetry(emit);
    const context = {
      caller: 'interview',
      project: 'Apex',
      runId: 'thread-1',
      checkoutPath: 'C:\\secret\\checkout',
      rawArguments: 'rm -rf repository',
    };

    telemetry.recreation(
      context,
      'legacy-binding-missing',
      'success',
    );
    telemetry.bindingWrite(context, 'remote', 'success');
    telemetry.lifecycleFlag(context, false, 'success');

    expect(emit).toHaveBeenNthCalledWith(
      1,
      'grounding.binding.recreation',
      {
        caller: 'interview',
        project: 'Apex',
        runId: 'thread-1',
        reason: 'legacy-binding-missing',
        outcome: 'success',
      },
      { recreationCount: 1 },
    );
    expect(emit).toHaveBeenNthCalledWith(
      2,
      'grounding.binding.write',
      {
        caller: 'interview',
        project: 'Apex',
        runId: 'thread-1',
        mode: 'remote',
        outcome: 'success',
      },
      { bindingWriteCount: 1 },
    );
    expect(emit).toHaveBeenNthCalledWith(
      3,
      'grounding.binding.flag',
      {
        caller: 'interview',
        project: 'Apex',
        runId: 'thread-1',
        result: 'disabled',
        outcome: 'success',
      },
      { evaluationCount: 1 },
    );
    expect(JSON.stringify(emit.mock.calls)).not.toContain('secret');
    expect(JSON.stringify(emit.mock.calls)).not.toContain('rm -rf');
  });
});

describe('TBI-005 DoD-2 native-read telemetry', () => {
  it('emits approved flag, self-check, binding-write, and recreation events', () => {
    const emit = jest.fn();
    const telemetry = createGroundingTelemetry(emit);
    const context = {
      caller: 'interview',
      project: 'Apex',
      runId: 'thread-4',
      provider: 'github' as const,
    };

    telemetry.nativeReadFlagEvaluated(context, 'disabled', 'default-off');
    telemetry.nativeReadCapabilitySelfCheck(
      context,
      'not-proven',
      'harness-not-run',
    );
    telemetry.bindingWrite(context, 'remote', 'success');
    telemetry.agentRecreate(context, 'grounding-mode-changed');

    expect(emit.mock.calls).toEqual([
      [
        'native-read.flag.evaluated',
        {
          caller: 'interview',
          project: 'Apex',
          runId: 'thread-4',
          provider: 'github',
          flag: 'native-read',
          outcome: 'disabled',
          reason: 'default-off',
        },
        { evaluationCount: 1 },
      ],
      [
        'native-read.capability.self-check',
        {
          caller: 'interview',
          project: 'Apex',
          runId: 'thread-4',
          provider: 'github',
          outcome: 'not-proven',
          selfCheckReason: 'harness-not-run',
        },
        { selfCheckCount: 1 },
      ],
      [
        'grounding.binding.write',
        {
          caller: 'interview',
          project: 'Apex',
          runId: 'thread-4',
          provider: 'github',
          mode: 'remote',
          outcome: 'success',
        },
        { bindingWriteCount: 1 },
      ],
      [
        'grounding.agent.recreate',
        {
          caller: 'interview',
          project: 'Apex',
          runId: 'thread-4',
          provider: 'github',
          recreateReason: 'grounding-mode-changed',
        },
        { recreationCount: 1 },
      ],
    ]);
  });
});

describe('TBI-005 DoD-4 / BR-011 / VT-07 telemetry redaction', () => {
  it('drops repository content, raw arguments, paths, commands, and secrets', () => {
    const emit = jest.fn();
    const telemetry = createGroundingTelemetry(emit);
    const adversarialContext = {
      caller: 'interview',
      project: 'Apex',
      repository: 'https://example.test/org/repo?secret=credential',
      branch: 'feature/native-read',
      sourceContent: 'const proprietaryRepositoryContent = true;',
      rawArguments: '{"path":"C:\\\\Users\\\\owner\\\\private-repo"}',
      rawCommand: 'git show super-secret-source',
      command: 'cat /home/owner/private-repo/source.ts',
      checkoutPath: '\\\\server\\share\\private-repo',
      linuxPath: '/home/owner/private-repo/source.ts',
      authorization: 'Bearer top-secret-token',
      secret: 'secret=top-secret-value',
    };

    telemetry.nativeReadFlagEvaluated(
      adversarialContext,
      'enabled',
      'targeted-rollout',
    );
    telemetry.nativeReadCapabilitySelfCheck(
      adversarialContext,
      'proven',
      'read-harness-passed',
    );
    telemetry.agentRecreate(adversarialContext, 'grounding-mode-changed');

    const serialized = JSON.stringify(emit.mock.calls);
    expect(serialized).not.toContain('proprietaryRepositoryContent');
    expect(serialized).not.toContain('private-repo');
    expect(serialized).not.toContain('git show');
    expect(serialized).not.toContain('/home/');
    expect(serialized).not.toContain('Bearer');
    expect(serialized).not.toContain('top-secret');
    expect(serialized).not.toContain('rawArguments');
    expect(serialized).not.toContain('rawCommand');
    expect(serialized).not.toContain('sourceContent');
  });
});

describe('TBI-006 S1 content-free native-read outcomes', () => {
  it('keeps enabling engagement and fallback telemetry content-free', () => {
    // Arrange
    const emit = jest.fn();
    const telemetry = createGroundingTelemetry(emit);
    const adversarialContext = {
      caller: 'chat-agent',
      project: 'Apex',
      runId: 'thread-5',
      runType: 'chat' as const,
      repositoryContent: 'const proprietarySource = true;',
      checkoutPath: 'C:\\Users\\owner\\private-repo',
      rawCommand: 'git show super-secret-source',
      rawArguments: '{"path":"/home/owner/private-repo"}',
      credential: 'Bearer top-secret-token',
    };

    // Act
    telemetry.nativeReadEngaged(adversarialContext);
    telemetry.fallback(
      adversarialContext,
      'native-read-capability-unproven'
    );

    // Assert
    expect(emit.mock.calls).toEqual([
      [
        'native-read.engaged',
        {
          caller: 'chat-agent',
          project: 'Apex',
          runId: 'thread-5',
          runType: 'chat',
        },
        { engagementCount: 1 },
      ],
      [
        'grounding.fallback',
        {
          caller: 'chat-agent',
          project: 'Apex',
          runId: 'thread-5',
          runType: 'chat',
          reason: 'native-read-capability-unproven',
        },
        { fallbackCount: 1 },
      ],
    ]);
    const serialized = JSON.stringify(emit.mock.calls);
    expect(serialized).not.toContain('proprietarySource');
    expect(serialized).not.toContain('private-repo');
    expect(serialized).not.toContain('git show');
    expect(serialized).not.toContain('Bearer');
    expect(serialized).not.toContain('top-secret');
  });
});
