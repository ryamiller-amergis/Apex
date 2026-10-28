import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  BOOKMARK_IMPORT_MAX_FILE_BYTES,
  PROJECT_QUICK_LINKS_MAX_PER_PROJECT,
  ProjectQuickLinkError,
  QUICK_LINKS_IMPORT_MAX_ITEMS,
  QUICK_LINK_CATEGORY_MAX_LENGTH,
  QUICK_LINK_LABEL_MAX_LENGTH,
  QUICK_LINK_URL_MAX_LENGTH,
  USER_QUICK_LINKS_LIMIT_MESSAGE,
  USER_QUICK_LINKS_MAX_PER_PROJECT,
} from '../../shared/types/projectQuickLinks';

interface RecordedCall {
  op: 'select' | 'insert' | 'update' | 'delete';
  where?: SQL;
  values?: unknown;
  set?: unknown;
}

jest.mock('../db/drizzle', () => {
  const calls: RecordedCall[] = [];
  const results: unknown[] = [];
  const errors: (unknown | undefined)[] = [];

  function chain(op: RecordedCall['op']) {
    const record: RecordedCall = { op };
    calls.push(record);
    const builder: Record<string, unknown> = {};
    const self = () => builder;
    Object.assign(builder, {
      from: self,
      orderBy: self,
      returning: self,
      onConflictDoNothing: self,
      where: (w: SQL) => { record.where = w; return builder; },
      values: (v: unknown) => { record.values = v; return builder; },
      set: (s: unknown) => { record.set = s; return builder; },
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
        const error = errors.shift();
        if (error) return Promise.reject(error).then(resolve, reject);
        return Promise.resolve(results.shift() ?? []).then(resolve, reject);
      },
    });
    return builder;
  }

  const db = {
    select: () => chain('select'),
    insert: () => chain('insert'),
    update: () => chain('update'),
    delete: () => chain('delete'),
    transaction: (fn: (tx: unknown) => unknown) => fn(db),
  };

  return { db, __mock: { calls, results, errors } };
});

import * as drizzleModule from '../db/drizzle';
import {
  createUserLink,
  deleteUserLink,
  importUserLinks,
  listUserLinks,
  updateUserLink,
} from '../services/userQuickLinksService';

const mock = (drizzleModule as unknown as {
  __mock: { calls: RecordedCall[]; results: unknown[]; errors: (unknown | undefined)[] };
}).__mock;

const dialect = new PgDialect();

function whereOf(call: RecordedCall) {
  return dialect.sqlToQuery(call.where as SQL);
}

/** Queues one result per awaited query, in order. `undefined` keeps an error slot empty. */
function queue(...results: unknown[]) {
  mock.results.push(...results);
}

const row = {
  id: 'link-1',
  userId: 'alice',
  project: 'MaxView',
  label: 'Clerk',
  url: 'https://dashboard.clerk.com/',
  category: null,
  sortOrder: 0,
  createdAt: '2026-10-28T19:00:00.000Z',
  updatedAt: '2026-10-28T19:00:00.000Z',
};

beforeEach(() => {
  mock.calls.length = 0;
  mock.results.length = 0;
  mock.errors.length = 0;
});

describe('limits', () => {
  it('lets a user keep 1,000 personal links and import that many in one request', () => {
    expect(USER_QUICK_LINKS_MAX_PER_PROJECT).toBe(1000);
    expect(QUICK_LINKS_IMPORT_MAX_ITEMS).toBe(USER_QUICK_LINKS_MAX_PER_PROJECT);
    expect(PROJECT_QUICK_LINKS_MAX_PER_PROJECT).toBe(200);
    expect(BOOKMARK_IMPORT_MAX_FILE_BYTES).toBe(20 * 1024 * 1024);
  });

  it('keeps the worst-case import body under the 10 MB server limit', () => {
    const worst = {
      label: 'x'.repeat(QUICK_LINK_LABEL_MAX_LENGTH),
      url: `https://${'a'.repeat(QUICK_LINK_URL_MAX_LENGTH - 8)}`,
      category: 'c'.repeat(QUICK_LINK_CATEGORY_MAX_LENGTH),
    };
    const body = JSON.stringify({ items: Array.from({ length: QUICK_LINKS_IMPORT_MAX_ITEMS }, () => worst) });
    expect(body.length).toBeLessThan(10 * 1024 * 1024);
  });

  it('states the personal cap in the limit message', async () => {
    queue([{ value: USER_QUICK_LINKS_MAX_PER_PROJECT }]);
    await expect(
      createUserLink('alice', 'MaxView', { label: 'x', url: 'https://x.com' }),
    ).rejects.toThrow('You can keep up to 1,000 personal links per project');
  });
});

describe('ownership isolation', () => {
  it('lists only the given user’s links for the given project', async () => {
    queue([row]);

    const items = await listUserLinks('alice', 'MaxView');

    const { sql, params } = whereOf(mock.calls[0]);
    expect(sql).toContain('"user_quick_links"."user_id" = $1');
    expect(sql).toContain('"user_quick_links"."project" = $2');
    expect(params).toEqual(['alice', 'MaxView']);
    expect(items).toEqual([expect.not.objectContaining({ userId: expect.anything() })]);
    expect(items[0].id).toBe('link-1');
  });

  it('updates a link only when it belongs to the user and project', async () => {
    queue([{ ...row, label: 'Clerk dashboard' }]);

    await updateUserLink('alice', 'MaxView', 'link-1', { label: 'Clerk dashboard' });

    const { sql, params } = whereOf(mock.calls[0]);
    expect(sql).toContain('"user_quick_links"."id" = $1');
    expect(sql).toContain('"user_quick_links"."user_id" = $2');
    expect(params).toEqual(['link-1', 'alice', 'MaxView']);
  });

  it('reports another user’s link as not found on update', async () => {
    queue([]);
    await expect(
      updateUserLink('mallory', 'MaxView', 'link-1', { label: 'mine now' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('reports another user’s link as not found on delete', async () => {
    queue([]);
    await expect(deleteUserLink('mallory', 'MaxView', 'link-1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const { params } = whereOf(mock.calls[0]);
    expect(params).toEqual(['link-1', 'mallory', 'MaxView']);
  });

  it('creates the link for the given user and project', async () => {
    queue([{ value: 3 }], [row]);

    await createUserLink('alice', 'MaxView', { label: ' Clerk ', url: 'https://dashboard.clerk.com' });

    expect(mock.calls[1].values).toEqual({
      userId: 'alice',
      project: 'MaxView',
      label: 'Clerk',
      url: 'https://dashboard.clerk.com/',
      category: null,
      sortOrder: 3,
    });
  });

  it('requires a user id', async () => {
    await expect(listUserLinks('', 'MaxView')).rejects.toThrow('User is required');
    expect(mock.calls).toHaveLength(0);
  });
});

describe('validation', () => {
  it.each(['javascript:alert(1)', 'chrome://settings', 'file:///etc/passwd', 'not a url'])(
    'rejects %s before touching the database',
    async (url) => {
      await expect(createUserLink('alice', 'MaxView', { label: 'x', url })).rejects.toBeInstanceOf(
        ProjectQuickLinkError,
      );
      expect(mock.calls).toHaveLength(0);
    },
  );

  it('requires a label', async () => {
    await expect(
      createUserLink('alice', 'MaxView', { label: ' ', url: 'https://x.com' }),
    ).rejects.toThrow('Label is required');
  });
});

describe('create: dedupe and cap', () => {
  it('reports a duplicate URL', async () => {
    queue([{ value: 1 }], []);
    await expect(
      createUserLink('alice', 'MaxView', { label: 'Clerk', url: 'https://dashboard.clerk.com' }),
    ).rejects.toMatchObject({ code: 'DUPLICATE' });
  });

  it('refuses to go past the per-project cap', async () => {
    queue([{ value: USER_QUICK_LINKS_MAX_PER_PROJECT }]);
    await expect(
      createUserLink('alice', 'MaxView', { label: 'One more', url: 'https://x.com' }),
    ).rejects.toMatchObject({ code: 'LIMIT_REACHED' });
    expect(mock.calls.filter((c) => c.op === 'insert')).toHaveLength(0);
  });

  it('maps a unique violation on update to DUPLICATE', async () => {
    mock.errors.push(Object.assign(new Error('duplicate key'), { code: '23505' }));
    await expect(
      updateUserLink('alice', 'MaxView', 'link-1', { url: 'https://taken.example.com' }),
    ).rejects.toMatchObject({ code: 'DUPLICATE' });
  });
});

describe('importUserLinks', () => {
  it('creates new links, skips existing and repeated URLs, and rejects invalid items', async () => {
    queue([{ url: 'https://dashboard.clerk.com/' }], [{ id: 'a' }, { id: 'b' }]);

    const result = await importUserLinks('alice', 'MaxView', [
      { label: 'Clerk', url: 'https://dashboard.clerk.com' },
      { label: 'Pendo', url: 'https://app.pendo.io', category: 'Analytics' },
      { label: 'Bookmarklet', url: 'javascript:alert(1)' },
      { label: 'Pendo again', url: 'https://app.pendo.io/' },
      { label: '', url: 'https://empty-label.example.com' },
      { label: 'SendGrid', url: 'https://app.sendgrid.com' },
    ]);

    expect(result.created).toBe(2);
    expect(result.skippedDuplicates).toBe(2);
    expect(result.rejected.map((r) => r.index)).toEqual([2, 4]);

    const existingQuery = whereOf(mock.calls[0]);
    expect(existingQuery.params).toEqual(['alice', 'MaxView']);

    const insert = mock.calls.find((c) => c.op === 'insert');
    expect(insert?.values).toEqual([
      expect.objectContaining({ userId: 'alice', project: 'MaxView', url: 'https://app.pendo.io/', category: 'Analytics', sortOrder: 1 }),
      expect.objectContaining({ userId: 'alice', project: 'MaxView', url: 'https://app.sendgrid.com/', sortOrder: 2 }),
    ]);
  });

  it('counts rows the database skipped on conflict as duplicates', async () => {
    queue([], [{ id: 'a' }]);

    const result = await importUserLinks('alice', 'MaxView', [
      { label: 'A', url: 'https://a.example.com' },
      { label: 'B', url: 'https://b.example.com' },
    ]);

    expect(result).toEqual({ created: 1, skippedDuplicates: 1, rejected: [] });
  });

  it('rejects items past the per-project cap', async () => {
    const existing = Array.from({ length: USER_QUICK_LINKS_MAX_PER_PROJECT - 1 }, (_, i) => ({
      url: `https://existing-${i}.example.com/`,
    }));
    queue(existing, [{ id: 'a' }]);

    const result = await importUserLinks('alice', 'MaxView', [
      { label: 'Fits', url: 'https://fits.example.com' },
      { label: 'Over', url: 'https://over.example.com' },
      { label: 'Over too', url: 'https://over-too.example.com' },
    ]);

    expect(result.created).toBe(1);
    expect(result.rejected).toEqual([
      expect.objectContaining({ index: 1, reason: USER_QUICK_LINKS_LIMIT_MESSAGE }),
      expect.objectContaining({ index: 2 }),
    ]);
    const insert = mock.calls.find((c) => c.op === 'insert');
    expect(insert?.values).toHaveLength(1);
  });

  it('does not insert when nothing is new', async () => {
    queue([{ url: 'https://a.example.com/' }]);

    const result = await importUserLinks('alice', 'MaxView', [{ label: 'A', url: 'https://a.example.com' }]);

    expect(result).toEqual({ created: 0, skippedDuplicates: 1, rejected: [] });
    expect(mock.calls.some((c) => c.op === 'insert')).toBe(false);
  });

  it.each([[undefined], [[]], ['nope']])('rejects items %p', async (items) => {
    await expect(importUserLinks('alice', 'MaxView', items)).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('rejects an import larger than the request limit', async () => {
    const items = Array.from({ length: QUICK_LINKS_IMPORT_MAX_ITEMS + 1 }, (_, i) => ({
      label: `L${i}`,
      url: `https://l${i}.example.com`,
    }));
    await expect(importUserLinks('alice', 'MaxView', items)).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(mock.calls).toHaveLength(0);
  });
});
