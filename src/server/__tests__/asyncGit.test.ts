import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import { git } from '../utils/asyncGit';

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

function createChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: jest.Mock;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  return child;
}

describe('git', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('resets the inactivity timer whenever git reports progress', async () => {
    const child = createChild();
    (spawn as jest.Mock).mockReturnValue(child);

    const result = git(['-c', 'core.longpaths=true', 'clone', '--progress'], {
      timeout: 1_000,
      idleTimeout: 50,
    });

    await jest.advanceTimersByTimeAsync(40);
    child.stderr.emit('data', Buffer.from('Receiving objects: 10%'));
    await jest.advanceTimersByTimeAsync(40);
    expect(child.kill).not.toHaveBeenCalled();

    child.emit('close', 0);
    await expect(result).resolves.toBe('');
  });

  it('kills a silent clone after the inactivity timeout with a useful command name', async () => {
    const child = createChild();
    (spawn as jest.Mock).mockReturnValue(child);

    const result = git(['-c', 'core.longpaths=true', 'clone', '--progress'], {
      timeout: 1_000,
      idleTimeout: 50,
    });
    const rejection = expect(result).rejects.toThrow('git clone made no progress for 50ms');

    await jest.advanceTimersByTimeAsync(51);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('close', null);
    await rejection;
  });
});
