/**
 * Tests for fetchExistingPageContext deep import traversal + keyword-guided prioritization.
 *
 * The ADO HTTP layer (https.request) is mocked with an in-memory file system so we can assert
 * which component files end up in the EXTEND-mode page context for a given feature description,
 * without touching the network.
 */

import { EventEmitter } from 'events';
import https from 'https';
import type { RepoReader } from '../../shared/types/repoReader';

jest.mock('https');

import {
  clearDesignSystemCache,
  DESIGN_SYSTEM_CATALOG_CACHE_MAX_ENTRIES,
  fetchExistingPageContext,
  getDesignSystemCatalog,
  getScreenInventory,
} from '../services/designSystemService';

const INVENTORY_PATH = '/.cursor/skills/figma-ui-knowledge-base/clientapp-screens.md';

const INVENTORY_MD = [
  '| Route | Component / File | Purpose | User types | Key components | States |',
  '| --- | --- | --- | --- | --- | --- |',
  '| `/Timecard` | `components/timecards/manageTimecards/ManageTimecards.js` | Manage timecards landing | C, S | `TimecardsGrid`, `TimecardSearchWidget` | List |',
].join('\n');

const BASE = '/components/timecards/manageTimecards';

/** Build the standard Timecards component fixture tree (page → grid → snapshot dialog → panel). */
function timecardsFiles(pageSrc?: string): Record<string, string> {
  return {
    [INVENTORY_PATH]: INVENTORY_MD,
    [`${BASE}/ManageTimecards.js`]: pageSrc ?? [
      "import React from 'react';",
      "import TimecardsGrid from './TimecardsGrid';",
      "import TimecardSearchWidget from './TimecardSearchWidget';",
      'export default function ManageTimecards() { return null; }',
    ].join('\n'),
    [`${BASE}/TimecardsGrid.js`]: [
      "import TimecardSnapshotDialog from './dialogs/TimecardSnapshotDialog';",
      "import Unrelated from './Unrelated';",
      'export default function TimecardsGrid() { return null; }',
    ].join('\n'),
    [`${BASE}/TimecardSearchWidget.js`]: 'export default function TimecardSearchWidget() { return null; }',
    [`${BASE}/Unrelated.js`]: 'export default function Unrelated() { return null; }',
    [`${BASE}/dialogs/TimecardSnapshotDialog.js`]: [
      "import TimecardSnapshotEntriesPanel from '../snapShot/TimecardSnapshotEntriesPanel';",
      'export default function TimecardSnapshotDialog() { return null; }',
    ].join('\n'),
    [`${BASE}/snapShot/TimecardSnapshotEntriesPanel.js`]:
      'export default function TimecardSnapshotEntriesPanel() { return null; }',
  };
}

/** Install an in-memory ADO responder for the mocked https.request. */
function setupAdo(
  files: Record<string, string>,
  trees: Record<string, string[]> = {},
  componentRequests?: { active: number; maxActive: number },
): void {
  (https.request as jest.Mock).mockImplementation((options: any, cb: (res: any) => void) => {
    const url = new URL(`https://ado.local${options.path}`);
    const p = decodeURIComponent(
      url.searchParams.get('path')
      ?? url.searchParams.get('scopePath')
      ?? '',
    );
    const isTree = url.searchParams.has('recursionLevel');
    const tracksComponent =
      !isTree
      && p.includes('/components/')
      && /\.(?:ts|tsx|js|jsx)$/.test(p);
    if (tracksComponent && componentRequests) {
      componentRequests.active += 1;
      componentRequests.maxActive = Math.max(
        componentRequests.maxActive,
        componentRequests.active,
      );
    }

    const res: any = new EventEmitter();
    let body = '';
    if (isTree) {
      const items = trees[p];
      if (items) {
        res.statusCode = 200;
        body = JSON.stringify({ value: items.map(path => ({ path, gitObjectType: 'blob' })) });
      } else {
        res.statusCode = 404;
      }
    } else if (Object.prototype.hasOwnProperty.call(files, p)) {
      res.statusCode = 200;
      body = files[p];
    } else {
      res.statusCode = 404;
    }

    setImmediate(() => {
      cb(res);
      setImmediate(() => {
        if (body) res.emit('data', Buffer.from(body));
        if (tracksComponent && componentRequests) {
          componentRequests.active -= 1;
        }
        res.emit('end');
      });
    });

    return { on: jest.fn(), setTimeout: jest.fn(), end: jest.fn(), destroy: jest.fn() };
  });
}

function componentFixture(prefix: string, count: number): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => {
      const name = `${prefix}${String(index).padStart(2, '0')}`;
      return [
        `/src/client/components/${name}.tsx`,
        `/** ${name} component details. */\nexport function ${name}() { return <table />; }`,
      ];
    }),
  );
}

function pinnedReader(files: Record<string, string>): RepoReader & {
  readFile: jest.Mock;
} {
  const paths = Object.keys(files).sort((left, right) => left.localeCompare(right));
  return {
    identity: {
      provider: 'ado',
      project: 'MaxView',
      repo: 'MaxView',
      sha: 'a'.repeat(40),
    },
    readFile: jest.fn(async (path: string) => {
      const content = files[path];
      if (content === undefined) throw new Error(`missing ${path}`);
      return content;
    }),
    listDir: jest.fn(async (path: string) =>
      path === '/src/client/components'
        ? paths.map((filePath) => ({
            path: filePath,
            name: filePath.split('/').pop()!,
            isFolder: false,
          }))
        : []),
    searchCode: jest.fn(async () => []),
  };
}

describe('fetchExistingPageContext — deep traversal + keyword prioritization', () => {
  beforeEach(() => {
    clearDesignSystemCache();
    (https.request as jest.Mock).mockReset();
    process.env.ADO_ORG = 'https://dev.azure.com/myorg';
    process.env.ADO_PAT = 'test-pat';
    delete process.env.MAXVIEW_CLIENTAPP_ROOT;
    delete process.env.PAGE_CONTEXT_MAX_BYTES;
    delete process.env.PAGE_CONTEXT_MAX_DEPTH;
  });

  it('follows imports past depth 1 to reach a feature-relevant in-page sub-view', async () => {
    setupAdo(timecardsFiles());

    const context = await fetchExistingPageContext(
      '/Timecard',
      'Add an Export button to the snapshot view',
    );

    // Page shell + depth-1 imports are always included.
    expect(context).toContain('ManageTimecards.js');
    expect(context).toContain('TimecardsGrid.js');
    expect(context).toContain('TimecardSearchWidget.js');
    // Keyword-matched deep imports (depth 2 + 3) are reached.
    expect(context).toContain('dialogs/TimecardSnapshotDialog.js');
    expect(context).toContain('snapShot/TimecardSnapshotEntriesPanel.js');
  });

  it('excludes deep imports whose names do not match the feature keywords', async () => {
    setupAdo(timecardsFiles());

    const context = await fetchExistingPageContext(
      '/Timecard',
      'Add an Export button to the snapshot view',
    );

    // "Unrelated" is a depth-2 import of TimecardsGrid but matches no feature keyword.
    expect(context).not.toContain('Unrelated.js');
  });

  it('without feature keywords, includes only the page shell and depth-1 imports', async () => {
    setupAdo(timecardsFiles());

    const context = await fetchExistingPageContext('/Timecard');

    expect(context).toContain('ManageTimecards.js');
    expect(context).toContain('TimecardsGrid.js');
    // Deep (>= depth 2) imports require keyword matches, so the snapshot chain is not pulled in.
    expect(context).not.toContain('TimecardSnapshotDialog.js');
    expect(context).not.toContain('TimecardSnapshotEntriesPanel.js');
  });

  it('resolves .js child imports (not just .ts/.tsx)', async () => {
    setupAdo(timecardsFiles());

    const context = await fetchExistingPageContext(
      '/Timecard',
      'snapshot export button',
    );

    // The whole fixture tree is .js; if .js resolution were missing, only the page would appear.
    expect(context).toContain('TimecardsGrid.js');
  });

  it('roots relative inventory paths under MAXVIEW_CLIENTAPP_ROOT', async () => {
    const root = '/src/Maxim.TimeClock.Web/ClientApp/js';
    process.env.MAXVIEW_CLIENTAPP_ROOT = root;
    clearDesignSystemCache();

    // Same fixture tree, but every component file now lives under the ClientApp root.
    const rootedFiles: Record<string, string> = { [INVENTORY_PATH]: INVENTORY_MD };
    for (const [path, src] of Object.entries(timecardsFiles())) {
      if (path === INVENTORY_PATH) continue;
      rootedFiles[`${root}${path}`] = src;
    }
    setupAdo(rootedFiles);

    const context = await fetchExistingPageContext(
      '/Timecard',
      'Add an Export button to the snapshot view',
    );

    // Resolution + relative-import traversal both work when rooted under the ClientApp dir.
    expect(context).toContain(`${root}${BASE}/ManageTimecards.js`);
    expect(context).toContain(`${root}${BASE}/TimecardsGrid.js`);
    expect(context).toContain(`${root}${BASE}/dialogs/TimecardSnapshotDialog.js`);

    delete process.env.MAXVIEW_CLIENTAPP_ROOT;
  });

  it('respects the byte budget: a huge page is truncated and children are dropped', async () => {
    // Pin the budget so the test is independent of the (configurable) default.
    process.env.PAGE_CONTEXT_MAX_BYTES = String(64 * 1024);
    const hugePage = [
      "import TimecardsGrid from './TimecardsGrid';",
      `// ${'x'.repeat(70 * 1024)}`,
    ].join('\n');
    setupAdo(timecardsFiles(hugePage));

    const context = await fetchExistingPageContext(
      '/Timecard',
      'Add an Export button to the snapshot view',
    );

    expect(context).toContain('ManageTimecards.js');
    expect(context).toContain('…truncated…');
    // Budget is exhausted by the page, so no child files are appended.
    expect(context).not.toContain('TimecardsGrid.js');
  });
});

describe('getScreenInventory — per-project source', () => {
  beforeEach(() => {
    clearDesignSystemCache();
    (https.request as jest.Mock).mockReset();
    process.env.ADO_ORG = 'https://dev.azure.com/myorg';
    process.env.ADO_PAT = 'test-pat';
  });

  it('reads the project inventory path instead of the MaxView default', async () => {
    const apexInventory = [
      '| Route | Component / File | Purpose |',
      '| --- | --- | --- |',
      '| `/home` | `AgentHome.tsx` | Agent Home |',
    ].join('\n');
    setupAdo({
      [INVENTORY_PATH]: INVENTORY_MD,
      '/.cursor/skills/design-system/apex-screens.md': apexInventory,
    });

    const rows = await getScreenInventory({
      adoProject: 'ApexProj',
      repo: 'Apex',
      branch: 'main',
      inventoryPath: '.cursor/skills/design-system/apex-screens.md',
    });

    expect(rows.map((r) => r.route)).toEqual(['/home']);
    expect(rows[0].file).toContain('AgentHome.tsx');
  });
});

describe('getDesignSystemCatalog — component source coverage', () => {
  beforeEach(() => {
    clearDesignSystemCache();
    (https.request as jest.Mock).mockReset();
    process.env.ADO_ORG = 'https://dev.azure.com/myorg';
    process.env.ADO_PAT = 'test-pat';
  });

  it('reads more than twenty relevant component files through a pinned repository reader', async () => {
    const files = componentFixture('Approval', 25);
    const paths = Object.keys(files);
    setupAdo(files, { '/src/client/components': paths });
    const reader = pinnedReader(files);

    const catalog = await (
      getDesignSystemCatalog as unknown as (options: {
        componentReader: RepoReader;
        relevanceText: string;
        componentDetailBudgetBytes: number;
      }) => Promise<ReturnType<typeof getDesignSystemCatalog> extends Promise<infer T> ? T : never>
    )({
      componentReader: reader,
      relevanceText: 'approval workflow',
      componentDetailBudgetBytes: 1_000_000,
    });

    expect(Object.keys(catalog.componentDescriptions)).toHaveLength(25);
    expect(
      reader.readFile.mock.calls.filter(
        ([path]) =>
          String(path).includes('/components/')
          && String(path).endsWith('.tsx'),
      ),
    ).toHaveLength(25);
    expect(catalog.componentDetailCoverage).toMatchObject({
      source: 'repo-reader',
      includedPaths: paths.sort((left, right) => left.localeCompare(right)),
      omittedPaths: [],
    });
  });

  it('reads every ranked ADO candidate with bounded concurrency', async () => {
    const files = {
      ...componentFixture('Unrelated', 21),
      ...componentFixture('Approval', 4),
    };
    const paths = Object.keys(files);
    const requests = { active: 0, maxActive: 0 };
    setupAdo(files, { '/src/client/components': paths }, requests);

    const catalog = await (
      getDesignSystemCatalog as unknown as (options: {
        relevanceText: string;
        componentDetailBudgetBytes: number;
      }) => Promise<ReturnType<typeof getDesignSystemCatalog> extends Promise<infer T> ? T : never>
    )({
      relevanceText: 'approval action',
      componentDetailBudgetBytes: 1_000_000,
    });

    for (let index = 0; index < 4; index++) {
      expect(catalog.componentDescriptions[`Approval0${index}`]).toContain(
        'component details',
      );
    }
    expect(catalog.componentDetailCoverage.source).toBe('ado-api');
    expect(catalog.componentDetailCoverage.includedPaths).toHaveLength(25);
    expect(catalog.componentDetailCoverage.omittedPaths).toEqual([]);
    expect(requests.maxActive).toBeGreaterThan(1);
    expect(requests.maxActive).toBeLessThanOrEqual(4);
    expect(
      (https.request as jest.Mock).mock.calls.filter(([options]) => {
        const url = new URL(`https://ado.local${options.path}`);
        const path = decodeURIComponent(url.searchParams.get('path') ?? '');
        return path.includes('/components/') && path.endsWith('.tsx');
      }),
    ).toHaveLength(25);
  });

  it('reports every unreadable ADO component path as omitted', async () => {
    const files = componentFixture('Approval', 2);
    const missing = '/src/client/components/ApprovalMissing.tsx';
    const paths = [...Object.keys(files), missing];
    setupAdo(files, { '/src/client/components': paths });

    const catalog = await getDesignSystemCatalog({
      relevanceText: 'approval action',
      componentDetailBudgetBytes: 1_000_000,
    });

    expect(catalog.componentDetailCoverage.includedPaths).toEqual(
      Object.keys(files).sort((left, right) => left.localeCompare(right)),
    );
    expect(catalog.componentDetailCoverage.omittedPaths).toEqual([missing]);
  });

  it('reports every candidate when the byte budget includes none', async () => {
    const files = componentFixture('Approval', 3);
    const paths = Object.keys(files);
    setupAdo(files, { '/src/client/components': paths });

    const catalog = await getDesignSystemCatalog({
      relevanceText: 'approval action',
      componentDetailBudgetBytes: 1,
    });

    expect(catalog.componentDetailCoverage.includedPaths).toEqual([]);
    expect(catalog.componentDetailCoverage.omittedPaths).toEqual(
      paths.sort((left, right) => left.localeCompare(right)),
    );
  });
});

describe('getDesignSystemCatalog — relevance cache bounds', () => {
  beforeEach(() => {
    clearDesignSystemCache();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('evicts the oldest feature-text entry when the cache reaches its bound', async () => {
    const files = componentFixture('Approval', 1);
    const reader = pinnedReader(files);

    for (
      let index = 0;
      index <= DESIGN_SYSTEM_CATALOG_CACHE_MAX_ENTRIES;
      index += 1
    ) {
      await getDesignSystemCatalog({
        componentReader: reader,
        relevanceText: `feature-${index}`,
      });
    }

    reader.readFile.mockClear();
    await getDesignSystemCatalog({
      componentReader: reader,
      relevanceText: 'feature-0',
    });
    expect(reader.readFile).toHaveBeenCalled();

    reader.readFile.mockClear();
    await getDesignSystemCatalog({
      componentReader: reader,
      relevanceText: `feature-${DESIGN_SYSTEM_CATALOG_CACHE_MAX_ENTRIES}`,
    });
    expect(reader.readFile).not.toHaveBeenCalled();
  });

  it('evicts expired entries before serving a new relevance key', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-22T12:00:00.000Z'));
    const files = componentFixture('Approval', 1);
    const reader = pinnedReader(files);

    await getDesignSystemCatalog({
      componentReader: reader,
      relevanceText: 'first feature',
    });
    jest.setSystemTime(new Date('2026-09-22T12:11:00.000Z'));
    await getDesignSystemCatalog({
      componentReader: reader,
      relevanceText: 'second feature',
    });

    reader.readFile.mockClear();
    await getDesignSystemCatalog({
      componentReader: reader,
      relevanceText: 'first feature',
    });
    expect(reader.readFile).toHaveBeenCalled();
  });
});
