import { createRunImpactContextRegistry } from '../services/runImpactContextRegistry';

const ref = {
  runType: 'service' as const,
  runId: 'ask-apex-session-1',
  project: 'Apex',
};

describe('TBI-008 process-local run impact context', () => {
  it('registers and unregisters only notification-safe run ownership', () => {
    // Arrange
    const registry = createRunImpactContextRegistry();

    // Act
    registry.register(ref, {
      authorId: 'user-1',
      title: 'Ask Apex run',
      link: '/home',
      caller: 'ask-apex',
      checkoutPath: 'C:\\private\\checkout',
      credential: 'secret',
    } as never);
    const resolved = registry.resolve(ref);
    registry.unregister(ref);

    // Assert
    expect(resolved).toEqual({
      authorId: 'user-1',
      title: 'Ask Apex run',
      link: '/home',
      caller: 'ask-apex',
    });
    expect(JSON.stringify(resolved)).not.toContain('private');
    expect(JSON.stringify(resolved)).not.toContain('secret');
    expect(registry.resolve(ref)).toBeNull();
  });

  it('isolates identical run IDs by run type and project', () => {
    // Arrange
    const registry = createRunImpactContextRegistry();
    registry.register(ref, {
      authorId: 'user-1',
      title: 'Ask Apex run',
      caller: 'ask-apex',
    });

    // Act / Assert
    expect(registry.resolve({ ...ref, runType: 'chat' })).toBeNull();
    expect(registry.resolve({ ...ref, project: 'Other' })).toBeNull();
  });
});
