/**
 * Unit tests for artifactCycleTimeService (FEAT-001 / TBI-002, PBI-002).
 *
 * The Drizzle `db` instance is mocked, but the real schema objects are imported,
 * so each fake query is routed by the tables it actually joins. That lets the
 * tests assert what the service reads (created_at + the frozen done event, never
 * updated_at) and how it scopes the read (project + trailing 90 days), on top of
 * the median values themselves.
 */

jest.mock('../db/drizzle', () => ({
  db: { select: jest.fn() },
}));

import {
  artifactDoneEvents,
  designDocs,
  designPrototypes,
  interviews,
  prds,
  testCases,
} from '../db/schema';
import { getMedians } from '../services/artifactCycleTimeService';

const { db: mockDb } = jest.requireMock('../db/drizzle') as { db: any };

const NOW = new Date('2026-08-31T00:00:00.000Z');
/** NOW minus 90 days. */
const WINDOW_START = '2026-06-02T00:00:00.000Z';
const PROJECT = 'Apex';

type QueryKey =
  | 'interview'
  | 'prd'
  | 'testCase'
  | 'designPrototype'
  | 'designDoc'
  | 'prototypeEnabled';

type PlannedResult = { rows: unknown[] } | { error: Error };

interface RecordedQuery {
  key: QueryKey;
  projection: Record<string, unknown>;
  conditions: unknown[];
}

let plan: Partial<Record<QueryKey, PlannedResult>>;
let recorded: RecordedQuery[];

/**
 * A row as the fake query returns it. `title` / `updatedAt` are columns the
 * service must never read — they are present so an edit to them can be proven
 * harmless (VT-21).
 */
interface ArtifactRow {
  createdAt: string;
  doneAt: string;
  title?: string;
  updatedAt?: string;
}

/** An edited row keeps a concrete title so the edit itself is expressible. */
type EditableArtifactRow = ArtifactRow & { title: string; updatedAt: string };

const sample = (
  createdAt: string,
  doneAt: string,
  extra: Omit<ArtifactRow, 'createdAt' | 'doneAt'> = {},
): ArtifactRow => ({
  createdAt,
  doneAt,
  ...extra,
});

/** Routes a fake query by the tables it joined — each artifact type joins a distinct set. */
function keyFor(tables: unknown[]): QueryKey {
  if (tables[0] === interviews) return 'prototypeEnabled';
  if (tables.includes(testCases)) return 'testCase';
  if (tables.includes(designPrototypes)) return 'designPrototype';
  if (tables.includes(designDocs)) return 'designDoc';
  if (tables.includes(interviews)) return 'interview';
  if (tables.includes(prds)) return 'prd';
  throw new Error(`unrecognised query over tables: ${tables.length}`);
}

/** Collects bound parameter values out of a Drizzle condition tree. */
function boundValues(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    node.forEach((child) => boundValues(child, out));
    return out;
  }
  if (node === null || typeof node !== 'object') return out;
  const record = node as Record<string, unknown>;
  if (Array.isArray(record.queryChunks)) boundValues(record.queryChunks, out);
  if (typeof record.value === 'string') out.push(record.value);
  else if (Array.isArray(record.value)) {
    record.value.forEach((entry) => {
      if (typeof entry === 'string') out.push(entry);
    });
  }
  return out;
}

function fakeSelect(projection: Record<string, unknown>) {
  const tables: unknown[] = [];
  const conditions: unknown[] = [];

  const settle = async () => {
    const key = keyFor(tables);
    recorded.push({ key, projection, conditions });
    const planned = plan[key];
    if (planned && 'error' in planned) throw planned.error;
    return planned?.rows ?? [];
  };

  const chain: any = {
    from: (table: unknown) => {
      tables.push(table);
      return chain;
    },
    innerJoin: (table: unknown) => {
      tables.push(table);
      return chain;
    },
    where: (condition: unknown) => {
      conditions.push(condition);
      return chain;
    },
    limit: () => chain,
    then: (onFulfilled: any, onRejected: any) => settle().then(onFulfilled, onRejected),
    catch: (onRejected: any) => settle().catch(onRejected),
  };
  return chain;
}

const queryFor = (key: QueryKey) => recorded.find((entry) => entry.key === key);

describe('artifactCycleTimeService.getMedians', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    plan = {};
    recorded = [];
    mockDb.select.mockImplementation(fakeSelect);
  });

  it('VT-05 / PBI-002 AC-0 / TBI-002 DoD-0 computes an independent median and sample size per artifact type', async () => {
    plan = {
      prototypeEnabled: { rows: [{ id: 'int-1' }] },
      interview: {
        rows: [
          sample('2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z'), // 1 day
          sample('2026-08-01T00:00:00.000Z', '2026-08-04T00:00:00.000Z'), // 3 days
          sample('2026-08-01T00:00:00.000Z', '2026-08-11T00:00:00.000Z'), // 10 days
        ],
      },
      prd: {
        rows: [
          sample('2026-08-01T00:00:00.000Z', '2026-08-03T00:00:00.000Z'), // 2 days
          sample('2026-08-01T00:00:00.000Z', '2026-08-09T00:00:00.000Z'), // 8 days
        ],
      },
      testCase: { rows: [sample('2026-08-10T00:00:00.000Z', '2026-08-14T00:00:00.000Z')] }, // 4 days
      designPrototype: { rows: [sample('2026-08-10T00:00:00.000Z', '2026-08-15T00:00:00.000Z')] }, // 5 days
      designDoc: { rows: [sample('2026-08-10T00:00:00.000Z', '2026-08-16T00:00:00.000Z')] }, // 6 days
    };

    const data = await getMedians(PROJECT, NOW);

    expect(data.interview).toEqual({ medianDays: 3, sampleSize: 3, windowDays: 90 });
    expect(data.prd).toEqual({ medianDays: 5, sampleSize: 2, windowDays: 90 });
    expect(data.testCase).toEqual({ medianDays: 4, sampleSize: 1, windowDays: 90 });
    expect(data.prototype).toEqual({ medianDays: 5, sampleSize: 1, windowDays: 90 });
    expect(data.designDoc).toEqual({ medianDays: 6, sampleSize: 1, windowDays: 90 });
  });

  it('VT-07 / PBI-002 AC-2 / TBI-002 DoD-1 returns an explicit empty KPI for a type with no completed items in the window', async () => {
    plan = {
      prototypeEnabled: { rows: [{ id: 'int-1' }] },
      interview: { rows: [sample('2026-08-01T00:00:00.000Z', '2026-08-05T00:00:00.000Z')] },
    };

    const data = await getMedians(PROJECT, NOW);

    expect(data.prd).toEqual({ medianDays: null, sampleSize: 0, windowDays: 90 });
    expect(data.prd.unavailable).toBeUndefined();
    expect(data.testCase).toEqual({ medianDays: null, sampleSize: 0, windowDays: 90 });
    expect(data.designDoc).toEqual({ medianDays: null, sampleSize: 0, windowDays: 90 });
    expect(data.interview.medianDays).toBe(4);
  });

  it('VT-08 / PBI-002 AC-3 / BR-005 omits the prototype key when every project Interview disables the prototype stage', async () => {
    plan = {
      prototypeEnabled: { rows: [] },
      interview: { rows: [sample('2026-08-01T00:00:00.000Z', '2026-08-05T00:00:00.000Z')] },
    };

    const data = await getMedians(PROJECT, NOW);

    expect('prototype' in data).toBe(false);
    expect(queryFor('designPrototype')).toBeUndefined();
    expect(data.interview.medianDays).toBe(4);
  });

  it('VT-08 / BR-005 keeps the prototype KPI when any project Interview enables the prototype stage', async () => {
    plan = {
      prototypeEnabled: { rows: [{ id: 'int-enabled' }] },
      designPrototype: { rows: [sample('2026-08-01T00:00:00.000Z', '2026-08-08T00:00:00.000Z')] },
    };

    const data = await getMedians(PROJECT, NOW);

    expect(data.prototype).toEqual({ medianDays: 7, sampleSize: 1, windowDays: 90 });
  });

  it('VT-21 / TBI-002 NFR a title or updated_at edit after the done event leaves the median unchanged', async () => {
    const frozen: EditableArtifactRow[] = [
      {
        createdAt: '2026-08-01T00:00:00.000Z',
        doneAt: '2026-08-03T00:00:00.000Z',
        title: 'Original title',
        updatedAt: '2026-08-03T00:00:00.000Z',
      },
      {
        createdAt: '2026-08-01T00:00:00.000Z',
        doneAt: '2026-08-06T00:00:00.000Z',
        title: 'Second interview',
        updatedAt: '2026-08-06T00:00:00.000Z',
      },
    ];
    plan = { prototypeEnabled: { rows: [] }, interview: { rows: frozen } };

    const before = await getMedians(PROJECT, NOW);

    // Both interviews are edited long after their frozen done events.
    recorded = [];
    plan = {
      prototypeEnabled: { rows: [] },
      interview: {
        rows: frozen.map((row) => ({
          ...row,
          title: `${row.title} (edited)`,
          updatedAt: '2026-08-29T00:00:00.000Z',
        })),
      },
    };

    const after = await getMedians(PROJECT, NOW);

    expect(after.interview).toEqual(before.interview);
    expect(after.interview.medianDays).toBe(3.5);
  });

  it('VT-21 / TBI-002 DoD-2 reads only created_at and the frozen done event, never updated_at', async () => {
    plan = { prototypeEnabled: { rows: [{ id: 'int-1' }] } };

    await getMedians(PROJECT, NOW);

    const typeKeys: QueryKey[] = ['interview', 'prd', 'testCase', 'designPrototype', 'designDoc'];
    for (const key of typeKeys) {
      const query = queryFor(key);
      expect(query).toBeDefined();
      expect(Object.keys(query!.projection).sort()).toEqual(['createdAt', 'doneAt']);
    }
    const doneEventQueries = recorded.filter((entry) => typeKeys.includes(entry.key));
    expect(doneEventQueries).toHaveLength(5);
  });

  it('BR-007 / TBI-002 DoD-0 scopes every type query to the project and to done events inside the trailing 90 days', async () => {
    plan = { prototypeEnabled: { rows: [{ id: 'int-1' }] } };

    await getMedians(PROJECT, NOW);

    const typeKeys: QueryKey[] = ['interview', 'prd', 'testCase', 'designPrototype', 'designDoc'];
    for (const key of typeKeys) {
      const values = boundValues(queryFor(key)!.conditions);
      expect(values).toContain(WINDOW_START);
      expect(values).toContain(PROJECT);
    }
  });

  it('PBI-002 AC-1 marks one failed type source unavailable while sibling KPIs keep their values', async () => {
    plan = {
      prototypeEnabled: { rows: [{ id: 'int-1' }] },
      interview: { rows: [sample('2026-08-01T00:00:00.000Z', '2026-08-03T00:00:00.000Z')] },
      prd: { error: new Error('prd median query failed') },
      testCase: { rows: [sample('2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z')] },
      designPrototype: { rows: [sample('2026-08-01T00:00:00.000Z', '2026-08-05T00:00:00.000Z')] },
      designDoc: { rows: [sample('2026-08-01T00:00:00.000Z', '2026-08-07T00:00:00.000Z')] },
    };

    const data = await getMedians(PROJECT, NOW);

    expect(data.prd).toEqual({
      medianDays: null,
      sampleSize: 0,
      windowDays: 90,
      unavailable: true,
    });
    expect(data.interview.medianDays).toBe(2);
    expect(data.testCase.medianDays).toBe(1);
    expect(data.prototype?.medianDays).toBe(4);
    expect(data.designDoc.medianDays).toBe(6);
  });

  it('PBI-002 AC-1 / BR-005 marks the prototype KPI unavailable when the prototype-stage lookup fails', async () => {
    plan = {
      prototypeEnabled: { error: new Error('prototype stage lookup failed') },
      interview: { rows: [sample('2026-08-01T00:00:00.000Z', '2026-08-03T00:00:00.000Z')] },
    };

    const data = await getMedians(PROJECT, NOW);

    expect(data.prototype).toEqual({
      medianDays: null,
      sampleSize: 0,
      windowDays: 90,
      unavailable: true,
    });
    expect(data.interview.medianDays).toBe(2);
  });
});
