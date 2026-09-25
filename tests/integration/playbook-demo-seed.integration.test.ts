/**
 * TBI-026 — the two demo definitions.
 *
 * Covers VT-13 (A and B publish with the composition the criterion names), VT-14 (a second run
 * makes two definitions, not four), VT-15 (both go through the real publish path, guards included),
 * VT-16 (neither writes a pipeline artifact), and FEAT-008 VT-22/23 (legacy Demo A is corrected
 * through the retained-draft lifecycle exactly once without changing its published v1).
 *
 * Against a real database because every property here is about what the publish path does, and the
 * publish path is where the structural guards live. A mocked `db` would assert that the script
 * calls `publishVersion`, which is not the same claim as the guards having actually run.
 *
 * VT-16 is worth explaining. "Writes no pipeline artifact" sounds like a property of the Skill, and
 * asserting it by reading the Skill would be the obvious approach — but it is really a property of
 * the *definitions*, and it would stop holding the moment someone swapped a step's Skill for one
 * that generates a PRD. Counting rows before and after catches that, and reading the Skill does not.
 */
import pg from 'pg';
import { createScratchDatabase, ScratchDatabase } from './support/scratch-db';

type SeedModule = typeof import('../../scripts/seed-playbook-demos');
type GuardModule = typeof import('../../src/server/services/playbookGuardService');

const MIGRATE_TIMEOUT = 600_000;
const USER_OID = 'demo-seed-user';
const PROJECT = 'Apex';
const LEGACY_PROJECT = 'Apex Legacy Demo Upgrade';

let scratch: ScratchDatabase;
let client: pg.Client;
let seed: SeedModule;
let guards: GuardModule;
let pool: { end: () => Promise<void> };

async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: unknown[] = []
): Promise<T[]> {
  const { rows } = await client.query<T>(text, values);
  return rows;
}

beforeAll(async () => {
  scratch = await createScratchDatabase('playbookseed');

  process.env.DATABASE_URL = scratch.connectionString;
  /* eslint-disable @typescript-eslint/no-require-imports --
   * Required rather than imported so the pool is built after DATABASE_URL points at the scratch
   * database. A static import is hoisted and would bind to whatever URL was set at file load. */
  seed = require('../../scripts/seed-playbook-demos');
  guards = require('../../src/server/services/playbookGuardService');
  pool = require('../../src/server/db').default;
  /* eslint-enable @typescript-eslint/no-require-imports */

  client = new pg.Client({ connectionString: scratch.connectionString });
  await client.connect();

  await query(
    `INSERT INTO app_users (oid, display_name) VALUES ($1, 'Demo Seed User')
     ON CONFLICT (oid) DO NOTHING`,
    [USER_OID]
  );
}, MIGRATE_TIMEOUT);

afterAll(async () => {
  if (client) await client.end();
  // The engine holds its own pool; an open session blocks the scratch database from being dropped.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  await require('../../src/server/services/playbookEngine/runtime').closeEngineStore();
  if (pool) await pool.end();
  if (scratch) await scratch.drop();
});

/** The published graph for a definition, read back from the database rather than from the module. */
async function publishedGraph(name: string): Promise<{
  nodes: Array<{ id: string; stepType: string }>;
  edges: Array<{ from: string; to: string }>;
}> {
  const [row] = await query<{ graph: { nodes: Array<{ id: string; stepType: string }>; edges: Array<{ from: string; to: string }> } }>(
    `SELECT v.graph FROM playbook_definition_versions v
       JOIN playbook_definitions d ON d.id = v.definition_id
      WHERE d.name = $1 AND d.project = $2 AND v.status = 'published'`,
    [name, PROJECT]
  );
  return row.graph;
}

/** Step types in execution order, which is what "composition" means for a linear graph. */
function orderedStepTypes(graph: {
  nodes: Array<{ id: string; stepType: string }>;
  edges: Array<{ from: string; to: string }>;
}): string[] {
  const typeOf = new Map(graph.nodes.map((n) => [n.id, n.stepType]));
  const hasInbound = new Set(graph.edges.map((e) => e.to));
  let current = graph.nodes.find((n) => !hasInbound.has(n.id))?.id;

  const order: string[] = [];
  while (current) {
    order.push(typeOf.get(current)!);
    current = graph.edges.find((e) => e.from === current)?.to;
  }
  return order;
}

describe('VT-13 — A and B publish with gate-first external work', () => {
  beforeAll(async () => {
    await seed.seedDemoPlaybooks(PROJECT, USER_OID);
  });

  it('publishes definition A as approval-gate, then cursor-agent, then notify', async () => {
    const graph = await publishedGraph(seed.DEFINITION_A.name);

    expect(orderedStepTypes(graph)).toEqual(['approval-gate', 'cursor-agent', 'notify']);
  });

  it('keeps definition B valid with its distinct stored configuration', async () => {
    const a = orderedStepTypes(await publishedGraph(seed.DEFINITION_A.name));
    const bGraph = await publishedGraph(seed.DEFINITION_B.name);
    const b = orderedStepTypes(bGraph);

    expect(b).toEqual(a);
    expect(seed.DEFINITION_B.graph).not.toEqual(seed.DEFINITION_A.graph);
  });

  it('keeps one retained draft beside each immutable published v1', async () => {
    const rows = await query<{ name: string; status: string }>(
      `SELECT d.name, v.status FROM playbook_definition_versions v
         JOIN playbook_definitions d ON d.id = v.definition_id
        WHERE d.project = $1`,
      [PROJECT]
    );

    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => r.status === 'published')).toHaveLength(2);
    expect(rows.filter((r) => r.status === 'draft')).toHaveLength(2);
  });

  it('attributes both to the seeding user, satisfying the created_by foreign key', async () => {
    const rows = await query<{ created_by: string; published_by: string }>(
      `SELECT d.created_by, v.published_by FROM playbook_definition_versions v
         JOIN playbook_definitions d ON d.id = v.definition_id
        WHERE d.project = $1 AND v.status = 'published'`,
      [PROJECT]
    );

    expect(rows.every((r) => r.created_by === USER_OID && r.published_by === USER_OID)).toBe(true);
  });
});

describe('VT-14 — running the script twice leaves two definitions, not four', () => {
  it('is idempotent with no manual cleanup between runs', async () => {
    const second = await seed.seedDemoPlaybooks(PROJECT, USER_OID);

    // Reported as already present rather than silently re-published.
    expect(second.every((o) => o.created === false)).toBe(true);

    const [counts] = await query<{ definitions: number; versions: number }>(
      `SELECT
         (SELECT count(*)::int FROM playbook_definitions WHERE project = $1) AS definitions,
         (SELECT count(*)::int FROM playbook_definition_versions v
            JOIN playbook_definitions d ON d.id = v.definition_id
           WHERE d.project = $1) AS versions`,
      [PROJECT]
    );

    expect(counts.definitions).toBe(2);
    // The one that would actually break the demo: a second version would change which one a new
    // run pins, mid-rehearsal.
    expect(counts.versions).toBe(4);
  });

  it('returns the same version ids on the second run', async () => {
    const again = await seed.seedDemoPlaybooks(PROJECT, USER_OID);
    const versionIds = await query<{ id: string }>(
      `SELECT v.id FROM playbook_definition_versions v
         JOIN playbook_definitions d ON d.id = v.definition_id
        WHERE d.project = $1 AND v.status = 'published' ORDER BY d.name`,
      [PROJECT]
    );

    expect([...again].sort((x, y) => x.name.localeCompare(y.name)).map((o) => o.versionId)).toEqual(
      versionIds.map((r) => r.id)
    );
  });
});

describe('FEAT-008 VT-22/23 — upgrade legacy Demo A without rewriting history', () => {
  const legacyGraph = {
    nodes: [
      {
        id: 'ask',
        stepType: 'cursor-agent',
        config: {
          skillPath: '.cursor/skills/app-knowledge/SKILL.md',
          prompt: 'Legacy ungated prompt',
        },
      },
      {
        id: 'approve',
        stepType: 'approval-gate',
        config: { subject: 'Legacy approval after agent work' },
      },
      {
        id: 'announce',
        stepType: 'notify',
        config: { title: 'Legacy done', body: 'Legacy body' },
      },
    ],
    edges: [
      { from: 'ask', to: 'approve' },
      { from: 'approve', to: 'announce' },
    ],
  };

  beforeAll(async () => {
    const [definition] = await query<{ id: string }>(
      `INSERT INTO playbook_definitions (project, name, description, created_by)
       VALUES ($1, $2, 'Legacy Demo A', $3) RETURNING id`,
      [LEGACY_PROJECT, seed.DEFINITION_A.name, USER_OID]
    );
    await query(
      `INSERT INTO playbook_definition_versions
         (definition_id, version_number, graph, status, published_by, published_at)
       VALUES
         ($1, 1, $2, 'published', $3, now()),
         ($1, 2, $2, 'draft', NULL, NULL)`,
      [definition.id, legacyGraph, USER_OID]
    );
  });

  it('VT-22 retains ungated published v1 and publishes corrected Demo A as immutable v2', async () => {
    await seed.seedDefinition(seed.DEFINITION_A, LEGACY_PROJECT, USER_OID);

    const versions = await query<{
      version_number: number;
      status: string;
      graph: typeof legacyGraph;
    }>(
      `SELECT v.version_number, v.status, v.graph
         FROM playbook_definition_versions v
         JOIN playbook_definitions d ON d.id = v.definition_id
        WHERE d.project = $1 AND d.name = $2
        ORDER BY v.version_number`,
      [LEGACY_PROJECT, seed.DEFINITION_A.name]
    );

    expect(versions.map(({ version_number, status }) => [version_number, status])).toEqual([
      [1, 'published'],
      [2, 'published'],
      [3, 'draft'],
    ]);
    expect(versions[0].graph).toEqual(legacyGraph);
    expect(orderedStepTypes(versions[1].graph)).toEqual([
      'approval-gate',
      'cursor-agent',
      'notify',
    ]);
    expect(versions[2].graph).toEqual(seed.DEFINITION_A.graph);
  });

  it('VT-23 reruns without creating another identical current version', async () => {
    const outcome = await seed.seedDefinition(seed.DEFINITION_A, LEGACY_PROJECT, USER_OID);
    const [count] = await query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM playbook_definition_versions v
         JOIN playbook_definitions d ON d.id = v.definition_id
        WHERE d.project = $1 AND d.name = $2`,
      [LEGACY_PROJECT, seed.DEFINITION_A.name]
    );

    expect(outcome.created).toBe(false);
    expect(outcome.versionNumber).toBe(2);
    expect(count.n).toBe(3);
  });
});

describe('VT-15 — both publish through the real publish path, guards included', () => {
  it('accepts both demo graphs under the structural guards', () => {
    // The same function `publishVersion` calls. A graph that fails here could not have been
    // published, so this is the guard actually running rather than a claim that it did.
    expect(() => guards.assertGraphWithinGuards(seed.DEFINITION_A.graph)).not.toThrow();
    expect(() => guards.assertGraphWithinGuards(seed.DEFINITION_B.graph)).not.toThrow();
  });

  it('refuses to publish a demo-shaped definition that violates a guard', async () => {
    const looping = {
      name: 'Demo C — looping, must not publish',
      description: 'A deliberately invalid definition, to prove the seed path validates.',
      graph: {
        nodes: [
          { id: 'one', stepType: 'notify', config: { title: 'one' } },
          { id: 'two', stepType: 'notify', config: { title: 'two' } },
        ],
        edges: [
          { from: 'one', to: 'two' },
          { from: 'two', to: 'one' },
        ],
      },
    };

    /*
     * The assertion that makes VT-15 mean something. If the script inserted rows with
     * `status = 'published'` directly, this would succeed — and E3 would be proving that B runs,
     * not that B passed the same validation A did.
     */
    await expect(seed.seedDefinition(looping, PROJECT, USER_OID)).rejects.toThrow(/loop/i);

    const [row] = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM playbook_definition_versions v
         JOIN playbook_definitions d ON d.id = v.definition_id
        WHERE d.name = $1 AND v.status = 'published'`,
      [looping.name]
    );
    expect(row.n).toBe(0);
  });
});

describe('VT-16 — neither definition writes a pipeline artifact', () => {
  it('names only the app-knowledge Skill, which produces no pipeline artifact', () => {
    const skillPaths = [...seed.DEMO_DEFINITIONS]
      .flatMap((d) => d.graph.nodes)
      .filter((n) => n.stepType === 'cursor-agent')
      .map((n) => (n.config as { skillPath?: string }).skillPath);

    expect(skillPaths).toHaveLength(2);
    expect(new Set(skillPaths)).toEqual(new Set(['.cursor/skills/app-knowledge/SKILL.md']));
  });

  it('leaves every pipeline-artifact table untouched by seeding', async () => {
    /*
     * The tables a generation workflow writes into. Counted by name rather than by asking the
     * schema for "artifact-ish" tables, because a table that stopped being counted through a
     * rename would silently weaken the assertion.
     */
    const ARTIFACT_TABLES = ['prds', 'design_docs', 'design_prototypes', 'interviews', 'adrs'];

    const countAll = async (): Promise<Record<string, number>> => {
      const counts: Record<string, number> = {};
      for (const table of ARTIFACT_TABLES) {
        const [row] = await query<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}"`);
        counts[table] = row.n;
      }
      return counts;
    };

    const before = await countAll();
    await seed.seedDemoPlaybooks(PROJECT, USER_OID);
    const after = await countAll();

    expect(after).toEqual(before);
  });
});
