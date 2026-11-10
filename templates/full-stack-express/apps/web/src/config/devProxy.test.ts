import { afterEach, describe, expect, it, vi } from 'vitest';
import config from '../../vite.config';

describe('dev server proxy', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('proxies /api and /health to APEX_API_PROXY_TARGET when it is set', async () => {
    vi.stubEnv('APEX_API_PROXY_TARGET', 'http://studio-api:3000');
    const resolved =
      typeof config === 'function'
        ? await config({ command: 'serve', mode: 'development' })
        : config;
    const proxy = resolved.server?.proxy as Record<string, unknown> | undefined;
    expect(proxy?.['/api']).toBe('http://studio-api:3000');
    expect(proxy?.['/health']).toBe('http://studio-api:3000');
  });

  it('TBI-022 DoD-2 local development proxies /api', async () => {
    const resolved =
      typeof config === 'function'
        ? await config({ command: 'serve', mode: 'development' })
        : config;
    const proxy = resolved.server?.proxy as Record<string, unknown> | undefined;
    expect(proxy?.['/api']).toBeTruthy();
    expect(String(proxy?.['/api'])).toContain('http://localhost:');
  });
});
