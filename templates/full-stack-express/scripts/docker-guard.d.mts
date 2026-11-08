export function dockerRequiredMessage(suite: 'integration' | 'e2e'): string;

export function assertDockerAvailable(
  suite: 'integration' | 'e2e'
): Promise<void>;
