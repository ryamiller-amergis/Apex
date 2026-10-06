import {
  isLocalExecution,
  localContainerJobStatus,
  useLocalCursorContainer,
} from '../services/localCursorContainerService';
import { mapContainerJobStatus } from '../services/cursorContainerCliService';

describe('local cursor container', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('runs in Docker only outside production when no Container Apps job is configured', () => {
    process.env.NODE_ENV = 'development';
    delete process.env.CURSOR_CONTAINER_JOB_NAME;
    expect(useLocalCursorContainer()).toBe(true);

    process.env.CURSOR_CONTAINER_JOB_NAME = 'cursor-pool-worker';
    expect(useLocalCursorContainer()).toBe(false);

    delete process.env.CURSOR_CONTAINER_JOB_NAME;
    process.env.NODE_ENV = 'production';
    expect(useLocalCursorContainer()).toBe(false);
  });

  it('maps container state to the statuses the poller already understands', () => {
    expect(mapContainerJobStatus(localContainerJobStatus('running', 0))).toBe('running');
    expect(mapContainerJobStatus(localContainerJobStatus('created', 0))).toBe('running');
    expect(mapContainerJobStatus(localContainerJobStatus('exited', 0))).toBe('finished');
    expect(mapContainerJobStatus(localContainerJobStatus('exited', 1))).toBe('failed');
    expect(mapContainerJobStatus(localContainerJobStatus('dead', 0))).toBe('failed');
  });

  it('tells local executions apart from Container Apps executions', () => {
    expect(isLocalExecution('apex-local-77-ab12cd34')).toBe(true);
    expect(isLocalExecution('cursor-pool-worker-x1y2z3')).toBe(false);
  });
});
