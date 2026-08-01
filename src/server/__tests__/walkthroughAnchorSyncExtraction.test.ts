/**
 * Phase 3 — walkthrough anchor sync extraction (fixtures only; no DB persistence).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  extractWalkthroughAnchorCandidatesFromSource,
  extractWalkthroughAnchorsFromFiles,
  resolveOwningComponentsByPath,
  scanLocalWalkthroughAnchors,
  syncExtractWalkthroughAnchors,
} from '../services/walkthroughAnchorSyncExtraction';
import type { WalkthroughAnchorCatalogSnapshotEntry } from '../services/walkthroughAnchorSyncExtraction';

const FIXTURE_ROOT = path.resolve(
  __dirname,
  'fixtures/walkthrough-anchor-scan'
);

function loadFixtureSources(): Array<{ path: string; content: string }> {
  const clientRoot = path.join(FIXTURE_ROOT, 'src', 'client');
  const files: Array<{ path: string; content: string }> = [];

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.tsx.txt') && !entry.name.endsWith('.ts.txt'))
        continue;
      const relUnderClient = path
        .relative(clientRoot, full)
        .split(path.sep)
        .join('/');
      // Strip trailing .txt so reported paths look like real client sources.
      const repoPath = `src/client/${relUnderClient.replace(/\.txt$/, '')}`;
      files.push({ path: repoPath, content: fs.readFileSync(full, 'utf8') });
    }
  };

  walk(clientRoot);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

describe('walkthroughAnchorSyncExtraction (Phase 3 fixtures)', () => {
  const sources = loadFixtureSources();

  it('classifies literal data-testid as data_testid and anchorTestIdProps as explicit', () => {
    const result = extractWalkthroughAnchorsFromFiles(sources, {
      provider: 'local',
      catalogSnapshot: [],
    });

    const byTestId = new Map(result.discoveries.map((d) => [d.testId, d]));

    expect(byTestId.get('save-draft-button')?.sourceKind).toBe('data_testid');
    expect(byTestId.get('settings-panel')?.sourceKind).toBe('data_testid');
    expect(byTestId.get('confirm-dialog')?.sourceKind).toBe('data_testid');

    expect(byTestId.get('user-menu-trigger')?.sourceKind).toBe('explicit');
    expect(byTestId.get('user-menu-trigger')?.suggestedAnchorKey).toBe(
      'user-menu-trigger'
    );
    expect(byTestId.get('user-menu-profile')?.sourceKind).toBe('explicit');
    expect(byTestId.get('user-menu-profile')?.suggestedAnchorKey).toBe(
      'user-menu-profile'
    );

    // Mixed: explicit + literal for same id → explicit wins
    expect(byTestId.get('whats-new-modal')?.sourceKind).toBe('explicit');
    expect(
      byTestId.get('whats-new-modal')?.sourceLocations.length
    ).toBeGreaterThanOrEqual(2);
  });

  it('aggregates duplicate source locations and lists duplicate groups', () => {
    const result = extractWalkthroughAnchorsFromFiles(sources, {
      provider: 'local',
      catalogSnapshot: [],
    });

    const shared = result.discoveries.find(
      (d) => d.testId === 'shared-action-button'
    );
    expect(shared).toBeDefined();
    expect(shared!.sourceLocations).toHaveLength(2);
    expect(shared!.sourceLocations.map((l) => l.filePath).sort()).toEqual([
      'src/client/components/DuplicateLeft.tsx',
      'src/client/components/DuplicateRight.tsx',
    ]);

    const dup = result.duplicates.find(
      (d) => d.testId === 'shared-action-button'
    );
    expect(dup).toBeDefined();
    expect(dup!.locations).toHaveLength(2);
  });

  it('limits discoveries to transitive imports of configured page entries', () => {
    const result = extractWalkthroughAnchorsFromFiles(
      [
        {
          path: 'src/client/components/EnabledPage.tsx',
          content:
            "import { CommonPanel } from './CommonPanel'; export const EnabledPage = CommonPanel;",
        },
        {
          path: 'src/client/components/CommonPanel.tsx',
          content: '<button data-testid="shared-save-button">Save</button>',
        },
        {
          path: 'src/client/components/DisabledPage.tsx',
          content:
            "import { DisabledPanel } from './DisabledPanel'; export const DisabledPage = DisabledPanel;",
        },
        {
          path: 'src/client/components/DisabledPanel.tsx',
          content:
            '<button data-testid="disabled-delete-button">Delete</button>',
        },
      ],
      {
        provider: 'local',
        catalogSnapshot: [],
        pageEntryComponents: ['src/client/components/EnabledPage.tsx'],
      }
    );

    expect(result.discoveries.map((discovery) => discovery.testId)).toEqual([
      'shared-save-button',
    ]);
    expect(result.diagnostics.filesScanned).toBe(2);
  });

  it('ignores dynamic / expression test IDs as unsupported patterns', () => {
    const result = extractWalkthroughAnchorsFromFiles(sources, {
      provider: 'local',
      catalogSnapshot: [],
    });

    const discoveryIds = new Set(result.discoveries.map((d) => d.testId));
    expect(discoveryIds.has('work-item-${itemId}')).toBe(false);
    expect([...discoveryIds].some((id) => id.includes('${'))).toBe(false);

    expect(result.unsupportedDynamicPatterns.length).toBeGreaterThanOrEqual(3);
    const snippets = result.unsupportedDynamicPatterns
      .map((p) => p.snippet)
      .join('\n');
    expect(snippets).toMatch(/work-item-\$/);
    expect(snippets).toMatch(/pref-\$/);
    expect(
      result.unsupportedDynamicPatterns.every((p) =>
        p.filePath.includes('DynamicIds')
      )
    ).toBe(true);
  });

  it('resolves AppSidebar view: literals to nav-item-* (with rare testId overrides)', () => {
    const sidebarSource = `
function navItemTestIdProps(item) {
  return { 'data-testid': item.testId ?? \`nav-item-\${item.view}\` };
}
const moduleGroups = [{
  items: [
    { label: 'Interview', view: 'backlog', onNavigate: () => {} },
    { label: 'Design Module', view: 'design-module', onNavigate: () => {} },
    { label: 'Load Tests', view: 'load-tests', testId: 'nav-load-tests', onNavigate: () => {} },
  ],
}];
export function AppSidebar() {
  return moduleGroups[0].items.map((item) => (
    <button key={item.view} {...navItemTestIdProps(item)} />
  ));
}
`;

    const result = extractWalkthroughAnchorsFromFiles(
      [
        {
          path: 'src/client/components/AppSidebar.tsx',
          content: sidebarSource,
        },
      ],
      { provider: 'local', catalogSnapshot: [] }
    );

    const ids = result.discoveries.map((d) => d.testId).sort();
    expect(ids).toEqual([
      'nav-item-backlog',
      'nav-item-design-module',
      'nav-load-tests',
    ]);
    expect(ids).not.toContain('nav-item-load-tests');
    expect(
      result.unsupportedDynamicPatterns.every(
        (p) => !/nav-item-\$\{/.test(p.snippet)
      )
    ).toBe(true);

    const matched = extractWalkthroughAnchorsFromFiles(
      [
        {
          path: 'src/client/components/AppSidebar.tsx',
          content: sidebarSource,
        },
      ],
      {
        provider: 'local',
        catalogSnapshot: [
          {
            testId: 'nav-item-design-module',
            anchorKey: 'nav-item-design-module',
            reviewStatus: 'approved',
            isActive: true,
            deletedAt: null,
          },
        ],
      }
    );
    expect(
      matched.existingMatches.some((m) => m.testId === 'nav-item-design-module')
    ).toBe(true);
    expect(
      matched.missingWarnings.some((m) => m.testId === 'nav-item-design-module')
    ).toBe(false);
  });

  it('resolves AppSidebar inline testId fallback expressions', () => {
    const sidebarSource = `
const moduleGroups = [{
  items: [
    { label: 'My Work', view: 'my-work', onNavigate: () => {} },
    { label: 'Load Tests', view: 'load-tests', testId: 'nav-load-tests', onNavigate: () => {} },
  ],
}];
export function AppSidebar() {
  return moduleGroups[0].items.map((item) => (
    <button
      key={item.view}
      {...{ 'data-testid': item.testId ?? \`nav-item-\${item.view}\` }}
    />
  ));
}
`;

    const result = extractWalkthroughAnchorsFromFiles(
      [
        {
          path: 'src/client/components/AppSidebar.tsx',
          content: sidebarSource,
        },
      ],
      {
        provider: 'local',
        catalogSnapshot: [
          {
            testId: 'nav-item-my-work',
            anchorKey: 'nav-item-my-work',
            reviewStatus: 'approved',
            isActive: true,
            deletedAt: null,
          },
        ],
      }
    );

    expect(result.discoveries.map((d) => d.testId).sort()).toEqual([
      'nav-item-my-work',
      'nav-load-tests',
    ]);
    expect(
      result.existingMatches.some((m) => m.testId === 'nav-item-my-work')
    ).toBe(true);
    expect(
      result.missingWarnings.some((m) => m.testId === 'nav-item-my-work')
    ).toBe(false);
  });

  it('does not resolve view: literals outside AppSidebar', () => {
    const result = extractWalkthroughAnchorsFromFiles(
      [
        {
          path: 'src/client/components/OtherNav.tsx',
          content: `
function navItemTestIdProps(item) {
  return { 'data-testid': item.testId ?? \`nav-item-\${item.view}\` };
}
const items = [{ view: 'design-module' }];
`,
        },
      ],
      { provider: 'local', catalogSnapshot: [] }
    );

    expect(result.discoveries.map((d) => d.testId)).not.toContain(
      'nav-item-design-module'
    );
  });

  it('diffs against an injected catalog snapshot without writing to DB', () => {
    const catalog: WalkthroughAnchorCatalogSnapshotEntry[] = [
      {
        testId: 'user-menu-trigger',
        anchorKey: 'user-menu-trigger',
        reviewStatus: 'approved',
        isActive: true,
        deletedAt: null,
      },
      {
        testId: 'legacy-missing-anchor',
        anchorKey: 'legacy-missing-anchor',
        reviewStatus: 'approved',
        isActive: true,
        deletedAt: null,
      },
      {
        testId: 'soft-deleted-should-ignore',
        anchorKey: 'soft-deleted-should-ignore',
        reviewStatus: 'approved',
        isActive: false,
        deletedAt: '2026-01-01T00:00:00.000Z',
      },
    ];

    const result = extractWalkthroughAnchorsFromFiles(sources, {
      provider: 'local',
      catalogSnapshot: catalog,
    });

    expect(
      result.existingMatches.some((m) => m.testId === 'user-menu-trigger')
    ).toBe(true);
    expect(
      result.newCandidates.some((c) => c.testId === 'save-draft-button')
    ).toBe(true);
    expect(
      result.newCandidates.some((c) => c.testId === 'user-menu-trigger')
    ).toBe(false);

    expect(result.missingWarnings.map((m) => m.testId)).toEqual([
      'legacy-missing-anchor',
    ]);
    expect(
      result.missingWarnings.some(
        (m) => m.testId === 'soft-deleted-should-ignore'
      )
    ).toBe(false);

    // Proposed review state for Wave 2 persistence (not written here)
    for (const candidate of result.newCandidates) {
      expect(candidate.proposedReviewStatus).toBe('pending');
      expect(candidate.proposedIsActive).toBe(false);
      expect(candidate.sourceHash).toMatch(/^[a-f0-9]{16,64}$/);
    }
  });

  it('excludes __tests__ / *.test.* client files from local disk scans', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-anchor-scan-'));
    try {
      const clientRoot = path.join(tmpRoot, 'src', 'client', 'components');
      fs.mkdirSync(path.join(clientRoot, '__tests__'), { recursive: true });

      fs.writeFileSync(
        path.join(clientRoot, 'Live.tsx'),
        `<button {...{ 'data-testid': 'live-button' }} />\n`,
        'utf8'
      );
      fs.writeFileSync(
        path.join(clientRoot, '__tests__', 'Ignored.tsx'),
        `<button {...{ 'data-testid': 'should-not-be-discovered' }} />\n`,
        'utf8'
      );
      fs.writeFileSync(
        path.join(clientRoot, 'Live.test.tsx'),
        `<button {...{ 'data-testid': 'test-file-id' }} />\n`,
        'utf8'
      );

      const result = scanLocalWalkthroughAnchors({
        repositoryRoot: tmpRoot,
        catalogSnapshot: [],
      });

      const ids = result.discoveries.map((d) => d.testId).sort();
      expect(ids).toEqual(['live-button']);
      expect(result.diagnostics.filesScanned).toBe(1);
      expect(result.diagnostics.provider).toBe('local');
      expect(result.diagnostics.committedTruth).toBe(false);
      expect(result.diagnostics.branch).toBeNull();
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('provider-aware entry delegates local scans and returns structured diagnostics', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-anchor-sync-'));
    try {
      const clientRoot = path.join(tmpRoot, 'src', 'client');
      fs.mkdirSync(clientRoot, { recursive: true });
      fs.writeFileSync(
        path.join(clientRoot, 'Only.tsx'),
        `<div {...{ 'data-testid': 'only-one-button' }} />\n`,
        'utf8'
      );

      const result = await syncExtractWalkthroughAnchors({
        provider: 'local',
        repositoryRoot: tmpRoot,
        catalogSnapshot: [{ testId: 'only-one-button', deletedAt: null }],
      });

      expect(result.existingMatches).toHaveLength(1);
      expect(result.newCandidates).toHaveLength(0);
      expect(result.diagnostics.filesScanned).toBe(1);
      expect(result.diagnostics.bytesRead).toBeGreaterThan(0);
      expect(result.diagnostics.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.diagnostics.committedTruth).toBe(false);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('extracts line numbers for literal occurrences', () => {
    const source = [
      'export const X = () => (',
      "  <button {...{ 'data-testid': 'lined-button' }}>",
      '    Go',
      '  </button>',
      ');',
      '',
    ].join('\n');

    const hits = extractWalkthroughAnchorCandidatesFromSource(
      source,
      'src/client/components/Lined.tsx'
    );
    expect(hits.literalOccurrences).toHaveLength(1);
    expect(hits.literalOccurrences[0].testId).toBe('lined-button');
    expect(hits.literalOccurrences[0].line).toBe(2);
  });

  it('skips oversized files and records them in diagnostics', () => {
    const huge =
      `const x = '${'a'.repeat(100)}';\n` + `{'data-testid': 'never-seen'}\n`;
    const result = extractWalkthroughAnchorsFromFiles(
      [{ path: 'src/client/Huge.tsx', content: huge }],
      { provider: 'local', catalogSnapshot: [], maxFileBytes: 40 }
    );
    expect(result.discoveries).toHaveLength(0);
    expect(result.diagnostics.truncatedFiles).toContain('src/client/Huge.tsx');
    expect(result.diagnostics.filesSkipped).toBe(1);
  });

  describe('resolveOwningComponentsByPath', () => {
    const files = [
      {
        path: 'src/client/components/PageA.tsx',
        content: `import { Shared } from './Shared';\nexport const PageA = () => <Shared />;\n`,
      },
      {
        path: 'src/client/components/PageB.tsx',
        content: `import { OnlyB } from './OnlyB';\nexport const PageB = () => <OnlyB />;\n`,
      },
      {
        path: 'src/client/components/Shared.tsx',
        content: `export const Shared = () => <div data-testid="shared-btn" />;\n`,
      },
      {
        path: 'src/client/components/OnlyB.tsx',
        content: `export const OnlyB = () => <div data-testid="only-b" />;\n`,
      },
    ];

    it('maps each source file to the page entries that transitively import it', () => {
      const owners = resolveOwningComponentsByPath(files, [
        'src/client/components/PageA.tsx',
        'src/client/components/PageB.tsx',
      ]);

      // A shared component owned by the single page that renders it.
      expect(owners.get('src/client/components/Shared.tsx')).toEqual([
        'src/client/components/PageA.tsx',
      ]);
      expect(owners.get('src/client/components/OnlyB.tsx')).toEqual([
        'src/client/components/PageB.tsx',
      ]);
      // Each page entry owns itself.
      expect(owners.get('src/client/components/PageA.tsx')).toEqual([
        'src/client/components/PageA.tsx',
      ]);
    });

    it('lists every owning page entry when a component is shared across pages', () => {
      const shared = [
        ...files,
        {
          path: 'src/client/components/PageC.tsx',
          content: `import { Shared } from './Shared';\nexport const PageC = () => <Shared />;\n`,
        },
      ];

      const owners = resolveOwningComponentsByPath(shared, [
        'src/client/components/PageA.tsx',
        'src/client/components/PageC.tsx',
      ]);

      expect(owners.get('src/client/components/Shared.tsx')).toEqual([
        'src/client/components/PageA.tsx',
        'src/client/components/PageC.tsx',
      ]);
    });

    it('ignores page entries that are not present in the file set', () => {
      const owners = resolveOwningComponentsByPath(files, [
        'src/client/components/PageA.tsx',
        'src/client/components/DoesNotExist.tsx',
      ]);

      expect(owners.has('src/client/components/OnlyB.tsx')).toBe(false);
      expect(owners.get('src/client/components/Shared.tsx')).toEqual([
        'src/client/components/PageA.tsx',
      ]);
    });
  });
});
