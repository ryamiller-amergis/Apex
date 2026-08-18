import type { RepositoryIdentity } from '../../shared/types/repoReader';
import { createBackgroundBundlePublisher } from '../services/grounding/backgroundBundlePublisher';

const identity: RepositoryIdentity = {
  provider: 'ado',
  project: 'MaxView',
  repo: 'MaxView',
  sha: 'a'.repeat(40),
};

const input = {
  identity,
  cacheDir: '/mirror.git',
  branch: 'main',
  userId: 'user-1',
};

function publisherWith(overrides: {
  enabled?: boolean;
  publish?: jest.Mock;
  log?: jest.Mock;
}) {
  const publish = overrides.publish ?? jest.fn().mockResolvedValue('published');
  const subject = createBackgroundBundlePublisher({
    publisher: { publish },
    isEnabled: jest.fn().mockResolvedValue(overrides.enabled ?? true),
    log: overrides.log ?? jest.fn(),
  });
  return { subject, publish };
}

describe('backgroundBundlePublisher', () => {
  it('publishes a bundle the read service can restore', async () => {
    const { subject, publish } = publisherWith({ enabled: true });

    await subject.publish(input);

    expect(publish).toHaveBeenCalledWith({
      identity,
      cacheDir: '/mirror.git',
      branch: 'main',
    });
  });

  it('stays inert until the repo-read service is switched on', async () => {
    const { subject, publish } = publisherWith({ enabled: false });

    await subject.publish(input);

    // Building a bundle nobody restores burns minutes of CPU on the mirror.
    expect(publish).not.toHaveBeenCalled();
  });

  it('never rejects, because callers do not await it', async () => {
    const { subject } = publisherWith({
      publish: jest.fn().mockRejectedValue(new Error('ACR unreachable')),
    });

    // An unhandled rejection here would take down the server process.
    await expect(subject.publish(input)).resolves.toBeUndefined();
  });

  it('records why a publish failed instead of failing silently', async () => {
    const log = jest.fn();
    const { subject } = publisherWith({
      publish: jest.fn().mockRejectedValue(new Error('ACR unreachable')),
      log,
    });

    await subject.publish(input);

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('ACR unreachable')
    );
  });

  it('builds the bundle once when turns overlap on the same SHA', async () => {
    let release: () => void = () => {};
    const publish = jest.fn(
      () => new Promise((resolve) => {
        release = () => resolve('published');
      })
    );
    const { subject } = publisherWith({ publish });

    const first = subject.publish(input);
    const second = subject.publish(input);
    // The flag check has to settle before the publisher is reached.
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await Promise.all([first, second]);

    expect(publish).toHaveBeenCalledTimes(1);
  });

  it('still publishes a different SHA while one is in flight', async () => {
    const publish = jest.fn().mockResolvedValue('published');
    const { subject } = publisherWith({ publish });

    await subject.publish(input);
    await subject.publish({
      ...input,
      identity: { ...identity, sha: 'b'.repeat(40) },
    });

    expect(publish).toHaveBeenCalledTimes(2);
  });
});
