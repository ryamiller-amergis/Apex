/**
 * Tests for fetchExistingPageContext deep import traversal + keyword-guided prioritization.
 *
 * The ADO HTTP layer (https.request) is mocked with an in-memory file system so we can assert
 * which component files end up in the EXTEND-mode page context for a given feature description,
 * without touching the network.
 */

import { EventEmitter } from 'events';
import https from 'https';

jest.mock('https');

import { fetchExistingPageContext, clearDesignSystemCache } from '../services/designSystemService';

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
function setupAdo(files: Record<string, string>, trees: Record<string, string[]> = {}): void {
  (https.request as jest.Mock).mockImplementation((options: any, cb: (res: any) => void) => {
    const url = new URL(`https://ado.local${options.path}`);
    const p = decodeURIComponent(url.searchParams.get('path') ?? '');
    const isTree = url.searchParams.has('recursionLevel');

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
        res.emit('end');
      });
    });

    return { on: jest.fn(), setTimeout: jest.fn(), end: jest.fn(), destroy: jest.fn() };
  });
}

describe('fetchExistingPageContext — deep traversal + keyword prioritization', () => {
  beforeEach(() => {
    clearDesignSystemCache();
    (https.request as jest.Mock).mockReset();
    process.env.ADO_ORG = 'https://dev.azure.com/myorg';
    process.env.ADO_PAT = 'test-pat';
    delete process.env.MAXVIEW_CLIENTAPP_ROOT;
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
    const hugePage = [
      "import TimecardsGrid from './TimecardsGrid';",
      `// ${'x'.repeat(60 * 1024)}`,
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
