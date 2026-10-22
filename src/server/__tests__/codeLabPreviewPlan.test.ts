import { injectRouteReset, resolvePreviewPlan, type PreviewCandidate } from '../services/codeLabPreviewPlan';

describe('injectRouteReset', () => {
  const base = '/api/code-lab/preview/abc/tok/';

  it('inserts the reset script right after the opening head tag', () => {
    const html = injectRouteReset('<html><head lang="en"><title>x</title></head></html>', base);
    expect(html).toMatch(/^<html><head lang="en"><script>.*<\/script><title>x<\/title>/);
    expect(html).toContain(JSON.stringify(base));
  });

  it('prepends the script when the document has no head tag', () => {
    expect(injectRouteReset('<div>hi</div>', base)).toMatch(/^<script>.*<\/script><div>hi<\/div>$/);
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
