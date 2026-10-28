import { CursorExecutionWaitError } from '../../services/cursorExecutionCore';
import { isTransientCursorConnectionError } from '../../services/aiRunsV2Worker/transientCursorError';

function connectError(message: string): Error {
  const error = new Error(`[unknown] ${message}`);
  error.name = 'ConnectError';
  (error as Error & { code: number }).code = 2;
  return error;
}

describe('isTransientCursorConnectionError', () => {
  it('treats the bare ConnectError seen in production as transient', () => {
    expect(
      isTransientCursorConnectionError(connectError('Premature close'))
    ).toBe(true);
  });

  it('finds a dropped connection wrapped by the execution core', () => {
    const wrapped = new CursorExecutionWaitError(
      connectError('Premature close')
    );
    expect(isTransientCursorConnectionError(wrapped)).toBe(true);
  });

  it('reads a failed wait result error message', () => {
    expect(
      isTransientCursorConnectionError({ message: 'Premature close' })
    ).toBe(true);
    expect(isTransientCursorConnectionError('socket hang up')).toBe(true);
  });

  it('honours the SDK network class, retryable flag, and socket codes', () => {
    expect(
      isTransientCursorConnectionError({ name: 'NetworkError', message: 'x' })
    ).toBe(true);
    expect(isTransientCursorConnectionError({ isRetryable: true })).toBe(true);
    expect(
      isTransientCursorConnectionError(
        Object.assign(new Error('reset'), { code: 'ECONNRESET' })
      )
    ).toBe(true);
  });

  it('never retries authentication, configuration, model policy, or aborts', () => {
    expect(
      isTransientCursorConnectionError({
        name: 'AuthenticationError',
        isRetryable: true,
      })
    ).toBe(false);
    expect(
      isTransientCursorConnectionError({
        status: 401,
        message: 'Premature close',
      })
    ).toBe(false);
    expect(
      isTransientCursorConnectionError({ name: 'ConfigurationError' })
    ).toBe(false);
    expect(
      isTransientCursorConnectionError({
        message: 'Model Blocked This model has been blocked',
      })
    ).toBe(false);
    const abort = new Error('Document execution aborted');
    abort.name = 'AbortError';
    expect(isTransientCursorConnectionError(abort)).toBe(false);
    expect(isTransientCursorConnectionError(new Error('Cursor failed'))).toBe(
      false
    );
    expect(isTransientCursorConnectionError(undefined)).toBe(false);
  });
});
