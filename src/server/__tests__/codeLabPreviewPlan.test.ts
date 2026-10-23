import {
  injectPreviewBootstrap,
  resolvePreviewBackendPath,
  resolvePreviewPlan,
  type PreviewCandidate,
} from '../services/codeLabPreviewPlan';

describe('injectPreviewBootstrap', () => {
  const base = '/api/code-lab/preview/abc/tok/';

  it('inserts the reset script right after the opening head tag', () => {
    const html = injectPreviewBootstrap('<html><head lang="en"><title>x</title></head></html>', base);
    expect(html).toMatch(/^<html><head lang="en"><script>.*<\/script><title>x<\/title>/);
    expect(html).toContain(JSON.stringify(base));
  });

  it('prepends the script when the document has no head tag', () => {
    expect(injectPreviewBootstrap('<div>hi</div>', base)).toMatch(/^<script>.*<\/script><div>hi<\/div>$/);
  });

  function runBootstrap() {
    const blocked = () => {
      throw new Error('SecurityError');
    };
    const fetch = jest.fn(async () => 'ok');
    const window = { fetch } as Record<string, unknown>;
    Object.defineProperty(window, 'localStorage', { get: blocked, configurable: true });
    Object.defineProperty(window, 'sessionStorage', { get: blocked, configurable: true });
    const document = {} as Record<string, unknown>;
    Object.defineProperty(document, 'cookie', { get: blocked, set: blocked, configurable: true });
    const origin = 'https://apex.example';
    const location = {
      origin,
      href: `${origin}${base}settings?a=1`,
      pathname: `${base}settings`,
      search: '?a=1',
      hash: '',
    };
    const history = { state: null, replaceState: jest.fn() };
    const open = jest.fn();
    class FakeXhr {
      withCredentials = true;
      open(...args: unknown[]) {
        open(...args);
      }
      send() {}
    }
    const script = /<script>([\s\S]*)<\/script>/.exec(injectPreviewBootstrap('<div></div>', base))![1];
    new Function('window', 'document', 'location', 'history', 'XMLHttpRequest', script)(
      window, document, location, history, FakeXhr,
    );
    return { window, document, history, fetch, open, FakeXhr, origin };
  }

  it('replaces blocked storage and cookies and strips the base from the path', () => {
    const { window, document, history } = runBootstrap();

    const storage = window.localStorage as Storage;
    storage.setItem('theme', 'dark');
    expect(storage.getItem('theme')).toBe('dark');
    expect(storage.length).toBe(1);
    expect((window.sessionStorage as Storage).getItem('missing')).toBeNull();
    expect(document.cookie).toBe('');
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/settings?a=1');
  });

  it('reroutes same-origin server calls under the base without credentials', async () => {
    const { window, fetch, open, FakeXhr, origin } = runBootstrap();
    const patchedFetch = window.fetch as (input: string, init?: RequestInit) => Promise<unknown>;

    await patchedFetch('/auth/status', { credentials: 'include' });
    expect(fetch).toHaveBeenLastCalledWith(`${base}__backend__/auth/status`, { credentials: 'omit' });

    await patchedFetch(`${base}src/main.tsx`);
    expect(fetch).toHaveBeenLastCalledWith(`${base}src/main.tsx`);

    await patchedFetch('https://other.example/data');
    expect(fetch).toHaveBeenLastCalledWith('https://other.example/data');

    const xhr = new FakeXhr();
    xhr.open('GET', `${origin}/api/menu-config?project=x`);
    xhr.send();
    expect(open).toHaveBeenCalledWith('GET', `${base}__backend__/api/menu-config?project=x`);
    expect(xhr.withCredentials).toBe(false);
  });
});

describe('resolvePreviewBackendPath', () => {
  const base = '/api/code-lab/preview/abc/tok/';

  it('returns the host path and query for a rerouted call', () => {
    expect(resolvePreviewBackendPath(`${base}__backend__/auth/status?x=1`, base)).toBe('/auth/status?x=1');
  });

  it('keeps a leading double slash as a path, not a host', () => {
    expect(resolvePreviewBackendPath(`${base}__backend__//evil.example/x`, base)).toBe('/evil.example/x');
  });

  it('ignores preview assets and other sessions', () => {
    expect(resolvePreviewBackendPath(`${base}src/main.tsx`, base)).toBeNull();
    expect(resolvePreviewBackendPath(`${base}__backend__auth`, base)).toBeNull();
  });

  it('refuses calls that point back into a Code Lab preview', () => {
    expect(resolvePreviewBackendPath(`${base}__backend__/api/code-lab/preview/x/y/`, base)).toBeNull();
    expect(resolvePreviewBackendPath(`${base}__backend__//api//code-lab/preview/x/`, base)).toBeNull();
    expect(resolvePreviewBackendPath(`${base}__backend__/a/../API/code-lab/preview/x/`, base)).toBeNull();
  });
});

function candidate(overrides: Partial<PreviewCandidate> = {}): PreviewCandidate {
  return { appDir: '.', packageJson: null, hasIndexHtml: false, ...overrides };
}

describe('resolvePreviewPlan', () => {
  it('previews a React + Vite app at the repository root', () => {
    const plan = resolvePreviewPlan([
      candidate({
        packageJson: { dependencies: { react: '^18.0.0' }, devDependencies: { vite: '^5.0.0' } },
        hasIndexHtml: true,
      }),
    ]);
    expect(plan).toEqual({ kind: 'vite', label: 'React + Vite', appDir: '.' });
  });

  it('labels a Vite app without a known UI library as plain Vite', () => {
    const plan = resolvePreviewPlan([candidate({ packageJson: { devDependencies: { vite: '^6.0.0' } } })]);
    expect(plan.label).toBe('Vite');
  });

  it('serves a folder with index.html and no package.json as static HTML', () => {
    const plan = resolvePreviewPlan([candidate({ hasIndexHtml: true })]);
    expect(plan).toEqual({ kind: 'static', label: 'Static HTML', appDir: '.' });
  });

  it('reports Next.js as unsupported even though it may depend on vite-like tooling', () => {
    const plan = resolvePreviewPlan([
      candidate({ packageJson: { dependencies: { next: '14.0.0', react: '18.0.0', vite: '5.0.0' } } }),
    ]);
    expect(plan.kind).toBe('unsupported');
    expect(plan.label).toBe('Next.js');
    expect(plan.reason).toMatch(/not supported/);
  });

  it('reports SvelteKit as unsupported before matching vite', () => {
    const plan = resolvePreviewPlan([
      candidate({ packageJson: { devDependencies: { '@sveltejs/kit': '2.0.0', vite: '5.0.0' } } }),
    ]);
    expect(plan.label).toBe('SvelteKit');
  });

  it('prefers a runnable app in a subfolder over an unsupported root', () => {
    const plan = resolvePreviewPlan([
      candidate({ packageJson: { dependencies: { '@angular/core': '17.0.0' } } }),
      candidate({ appDir: 'client', packageJson: { devDependencies: { vite: '5.0.0', vue: '3.0.0' } } }),
    ]);
    expect(plan).toEqual({ kind: 'vite', label: 'Vue + Vite', appDir: 'client' });
  });

  it('skips a root package.json with no web stack and finds the app in a subfolder', () => {
    const plan = resolvePreviewPlan([
      candidate({ packageJson: { devDependencies: { typescript: '5.0.0' } } }),
      candidate({ appDir: 'web', hasIndexHtml: true }),
    ]);
    expect(plan).toEqual({ kind: 'static', label: 'Static HTML', appDir: 'web' });
  });

  it('explains when no web app exists', () => {
    const plan = resolvePreviewPlan([candidate({ packageJson: { dependencies: { express: '4.0.0' } } })]);
    expect(plan.kind).toBe('unsupported');
    expect(plan.reason).toMatch(/No web app was found/);
  });
});
