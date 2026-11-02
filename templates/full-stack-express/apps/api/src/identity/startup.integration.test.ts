import { connect } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  baseEnv,
  freePort,
  gracefulExitCode,
  runApi,
} from '../../test/support/apiProcess.ts';

const DATABASE_URL =
  'postgresql://app_user:local-dev-only-password@localhost:5432/project_db';

function portRefuses(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(true));
  });
}

describe('identity startup guard (VT-09, VT-12)', () => {
  it('VT-09 PBI-008 AC-1 TBI-013 DoD-1 aborts on development mode in production and opens no port', async () => {
    const port = await freePort();
    const result = await runApi({
      ...baseEnv(),
      NODE_ENV: 'production',
      AUTH_MODE: 'development',
      DATABASE_URL,
      PORT: String(port),
    });
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      'development is not allowed when NODE_ENV is production'
    );
    expect(result.output).not.toContain('auth.development_adapter_active');
    expect(await portRefuses(port)).toBe(true);
  }, 20000);

  it('VT-09 PBI-008 AC-2 aborts naming AUTH_MODE when it is unset and never falls back', async () => {
    const port = await freePort();
    const result = await runApi({
      ...baseEnv(),
      NODE_ENV: 'development',
      DATABASE_URL,
      PORT: String(port),
    });
    expect(result.status).toBe(1);
    expect(result.output).toContain('AUTH_MODE: required but not set');
    expect(result.output).not.toContain('auth.development_adapter_active');
    expect(await portRefuses(port)).toBe(true);
  }, 20000);

  it('VT-12 aborts in external mode while no adapter is registered', async () => {
    const port = await freePort();
    const result = await runApi({
      ...baseEnv(),
      NODE_ENV: 'production',
      AUTH_MODE: 'external',
      DATABASE_URL,
      PORT: String(port),
      OTEL_SDK_DISABLED: 'true',
    });
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      'AUTH_MODE=external requires an adapter registered in apps/api/src/identity/registry.ts.'
    );
    expect(await portRefuses(port)).toBe(true);
  }, 20000);

  it('TBI-013 DoD-2 starts in development mode and logs the adapter warning', async () => {
    const result = await runApi({
      ...baseEnv(),
      NODE_ENV: 'development',
      AUTH_MODE: 'development',
      DATABASE_URL,
    });
    expect(result.listened).toBe(true);
    expect(result.status).toBe(gracefulExitCode);
    expect(result.output).toContain('auth.development_adapter_active');
    expect(result.output).not.toContain('synthetic-dev-subject');
  }, 20000);
});
