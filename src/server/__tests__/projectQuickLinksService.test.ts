const returning = jest.fn();
const values = jest.fn(() => ({ returning }));
const insert = jest.fn(() => ({ values }));
const selectWhere = jest.fn();
const select = jest.fn(() => ({ from: () => ({ where: selectWhere }) }));

jest.mock('../db/drizzle', () => {
  const db = {
    insert: (...args: unknown[]) => (insert as jest.Mock)(...args),
    select: (...args: unknown[]) => (select as jest.Mock)(...args),
    transaction: (fn: (tx: unknown) => unknown) => fn(db),
  };
  return { db };
});

import {
  createLink,
  importLinks,
  normalizeCategory,
  normalizeLabel,
  normalizeSortOrder,
  normalizeUrl,
  reorderLinks,
} from '../services/projectQuickLinksService';
import {
  PROJECT_QUICK_LINKS_MAX_PER_PROJECT,
  ProjectQuickLinkError,
  QUICK_LINK_LABEL_MAX_LENGTH,
} from '../../shared/types/projectQuickLinks';

beforeEach(() => {
  jest.clearAllMocks();
  selectWhere.mockResolvedValue([{ value: 0 }]);
});

describe('normalizeUrl', () => {
  it.each(['https://maxview.example.com', 'http://localhost:3000/path?q=1'])('accepts %s', (url) => {
    expect(() => normalizeUrl(url)).not.toThrow();
  });

  it('trims whitespace', () => {
    expect(normalizeUrl('  https://clerk.com/dashboard  ')).toBe('https://clerk.com/dashboard');
  });

  it.each([
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'ftp://files.example.com',
    'file:///etc/passwd',
    'mailto:team@example.com',
  ])('rejects non-http scheme %s', (url) => {
    expect(() => normalizeUrl(url)).toThrow(ProjectQuickLinkError);
  });

  it.each(['', '   ', 'not a url', 'example.com', undefined, null, 42])('rejects %p', (url) => {
    expect(() => normalizeUrl(url)).toThrow(ProjectQuickLinkError);
  });
});

describe('normalizeLabel', () => {
  it('trims the label', () => {
    expect(normalizeLabel('  MaxView Prod ')).toBe('MaxView Prod');
  });

  it.each(['', '   ', undefined, null, 5])('requires a label (%p)', (label) => {
    expect(() => normalizeLabel(label)).toThrow('Label is required');
  });

  it('rejects labels over the max length', () => {
    expect(() => normalizeLabel('x'.repeat(QUICK_LINK_LABEL_MAX_LENGTH + 1))).toThrow(ProjectQuickLinkError);
    expect(normalizeLabel('x'.repeat(QUICK_LINK_LABEL_MAX_LENGTH))).toHaveLength(QUICK_LINK_LABEL_MAX_LENGTH);
  });
});

describe('normalizeCategory', () => {
  it('turns blank into null', () => {
    expect(normalizeCategory('  ')).toBeNull();
    expect(normalizeCategory(undefined)).toBeNull();
    expect(normalizeCategory(null)).toBeNull();
  });

  it('trims a category', () => {
    expect(normalizeCategory(' Tools ')).toBe('Tools');
  });
});

describe('normalizeSortOrder', () => {
  it('defaults to 0', () => {
    expect(normalizeSortOrder(undefined)).toBe(0);
  });

  it.each([-1, 1.5, 'abc', Number.NaN])('rejects %p', (value) => {
    expect(() => normalizeSortOrder(value)).toThrow(ProjectQuickLinkError);
  });
});

describe('createLink', () => {
  const row = {
    id: 'link-1',
    project: 'MaxView',
    label: 'Clerk',
    url: 'https://dashboard.clerk.com/',
    category: 'Tools',
    sortOrder: 2,
    createdBy: 'user-1',
    updatedBy: 'user-1',
    createdAt: '2026-10-28T19:00:00.000Z',
    updatedAt: '2026-10-28T19:00:00.000Z',
  };

  it('inserts normalized values scoped to the project', async () => {
    returning.mockResolvedValue([row]);

    const result = await createLink(
      'MaxView',
      { label: ' Clerk ', url: 'https://dashboard.clerk.com', category: ' Tools ', sortOrder: 2 },
      'user-1',
    );

    expect(values).toHaveBeenCalledWith({
      project: 'MaxView',
      label: 'Clerk',
      url: 'https://dashboard.clerk.com/',
      category: 'Tools',
      sortOrder: 2,
      createdBy: 'user-1',
      updatedBy: 'user-1',
    });
    expect(result).toEqual(row);
  });

  it('rejects a javascript: URL without touching the database', async () => {
    await expect(
      createLink('MaxView', { label: 'Bad', url: 'javascript:alert(1)' }, 'user-1'),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(insert).not.toHaveBeenCalled();
  });

  it('requires a label', async () => {
    await expect(
      createLink('MaxView', { label: '  ', url: 'https://example.com' }, 'user-1'),
    ).rejects.toThrow('Label is required');
    expect(insert).not.toHaveBeenCalled();
  });

  it('requires a project', async () => {
    await expect(
      createLink('  ', { label: 'Clerk', url: 'https://example.com' }, 'user-1'),
    ).rejects.toThrow('Project is required');
    expect(insert).not.toHaveBeenCalled();
  });
});

describe('reorderLinks', () => {
  it.each([[undefined], ['abc'], [[1, 2]], [['a', 'a']]])('rejects ids %p', async (ids) => {
    await expect(reorderLinks('MaxView', ids, 'user-1')).rejects.toBeInstanceOf(ProjectQuickLinkError);
  });
});

describe('shared link cap on single adds and moves', () => {
  it('refuses a new shared link once the project has the maximum', async () => {
    selectWhere.mockResolvedValue([{ value: PROJECT_QUICK_LINKS_MAX_PER_PROJECT }]);

    await expect(
      createLink('MaxView', { label: 'One more', url: 'https://more.example.com' }, 'admin-1'),
    ).rejects.toMatchObject({ code: 'LIMIT_REACHED', message: 'A project can have up to 200 shared links' });
    expect(insert).not.toHaveBeenCalled();
  });

  it('allows the last link under the cap', async () => {
    selectWhere.mockResolvedValue([{ value: PROJECT_QUICK_LINKS_MAX_PER_PROJECT - 1 }]);
    returning.mockResolvedValue([
      {
        id: 'l', project: 'MaxView', label: 'Last', url: 'https://last.example.com/', category: null, sortOrder: 0,
        createdBy: 'admin-1', updatedBy: 'admin-1', createdAt: 'x', updatedAt: 'x',
      },
    ]);

    await expect(
      createLink('MaxView', { label: 'Last', url: 'https://last.example.com' }, 'admin-1'),
    ).resolves.toMatchObject({ id: 'l' });
  });
});

describe('importLinks (shared project links)', () => {
  it('skips URLs the project already has, rejects invalid items, and records the importer', async () => {
    selectWhere.mockResolvedValue([{ url: 'https://dashboard.clerk.com/' }]);

    const result = await importLinks(
      'MaxView',
      [
        { label: 'Clerk', url: 'https://dashboard.clerk.com' },
        { label: 'Pendo', url: 'https://app.pendo.io', category: 'Analytics' },
        { label: 'Bad', url: 'chrome://settings' },
        { label: 'Pendo again', url: 'https://app.pendo.io/' },
      ],
      'admin-1',
    );

    expect(result.created).toBe(1);
    expect(result.skippedDuplicates).toBe(2);
    expect(result.rejected.map((r) => r.index)).toEqual([2]);
    expect(values).toHaveBeenCalledWith([
      {
        project: 'MaxView',
        label: 'Pendo',
        url: 'https://app.pendo.io/',
        category: 'Analytics',
        sortOrder: 1,
        createdBy: 'admin-1',
        updatedBy: 'admin-1',
      },
    ]);
  });

  it('rejects links past the project cap', async () => {
    selectWhere.mockResolvedValue(
      Array.from({ length: PROJECT_QUICK_LINKS_MAX_PER_PROJECT }, (_, i) => ({ url: `https://e${i}.example.com/` })),
    );

    const result = await importLinks('MaxView', [{ label: 'One more', url: 'https://more.example.com' }], 'admin-1');

    expect(result).toEqual({
      created: 0,
      skippedDuplicates: 0,
      rejected: [expect.objectContaining({ index: 0, reason: expect.stringContaining('shared links') })],
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it('rejects a malformed list before querying', async () => {
    await expect(importLinks('MaxView', 'nope', 'admin-1')).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(select).not.toHaveBeenCalled();
  });
});
