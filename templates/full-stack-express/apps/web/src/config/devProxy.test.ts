import { describe, expect, it } from 'vitest';
import config from '../../vite.config';

describe('dev server proxy', () => {
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
