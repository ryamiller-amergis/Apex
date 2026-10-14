/**
 * Playbook engine conformance suite — FEAT-001 (TBI-006).
 *
 * Re-asks the six verification questions from FEAT-001 so they can be re-run before any
 * future version-pin move. Each check reads `design-docs/playbook-engine-verification.md`
 * and asserts the question has an explicit answer.
 *
 * A check that cannot evaluate its question THROWS with a named reason. It never skips —
 * skipping is how a suite quietly stops asking (TBI-006 DoD-1, VT-12).
 *
 * This file deliberately does NOT import './setup'. The record-assertion checks are pure
 * file reads; the live-engine checks build their own disposable database through
 * `support/scratch-db.ts`, which refuses any non-local host. Neither path touches production
 * (TBI-006 NFR, VT-13).
 *
 * Live-engine checks (VT-01, VT-02, VT-03, VT-05, VT-06, VT-08) drive the real engine through
 * `support/engine-probe.ts` in a child process. That indirection is not decoration: Mastra's CJS
 * bundle `require()`s an ESM-only dependency, which Node 22 permits and Jest's module runtime does
 * not. Running the engine under ts-node keeps the protected `jest.config.integration.js` untouched.
 *
 * Every live check asserts the observation against what the record claims. The point is not merely
 * that the engine behaves well, but that the written record still tells the truth about it.
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { createScratchDatabase, ScratchDatabase, serverSetting } from './support/scratch-db';

const REPO_ROOT = path.resolve(__dirname, '../..');
const RECORD_PATH = path.join(REPO_ROOT, 'design-docs/playbook-engine-verification.md');
const SUITE_PATH = path.join(REPO_ROOT, 'tests/integration/playbook-engine-conformance.integration.test.ts');

/** The marker the record uses for a question nobody has investigated yet. */
const UNANSWERED = 'not yet answered';

let record: string;

beforeAll(() => {
  if (!fs.existsSync(RECORD_PATH)) {
    throw new Error(
      `Verification record missing at design-docs/playbook-engine-verification.md. ` +
        `Every check in this suite asserts against it; without the record no question can be evaluated.`
    );
  }
  record = fs.readFileSync(RECORD_PATH, 'utf8');
});

/** Text of one `## Heading` section, up to the next `## ` heading. */
function section(heading: string): string {
  const lines = record.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith('## ') && l.slice(3).trim().startsWith(heading));
  if (start === -1) {
    throw new Error(`Verification record has no "## ${heading}" section — cannot evaluate this question.`);
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/** Last cell of the first table row whose first cell contains `rowLabel`. */
function cell(body: string, rowLabel: string): string {
  const row = body
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith('|') && !/^\|[\s:|-]+\|$/.test(l.trim()))
    .find((l) => stripMd(l.split('|')[1] ?? '').includes(stripMd(rowLabel)));
  if (!row) {
    throw new Error(`Verification record has no row for "${rowLabel}" — cannot evaluate this question.`);
  }
  const cells = row.split('|').slice(1, -1).map((c) => c.trim());
  return stripMd(cells[cells.length - 1] ?? '');
}

/** Cell at a specific column index (1-based over content cells). */
function cellAt(body: string, rowLabel: string, index: number): string {
  const row = body
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith('|') && !/^\|[\s:|-]+\|$/.test(l.trim()))
    .find((l) => stripMd(l.split('|')[1] ?? '').includes(stripMd(rowLabel)));
  if (!row) {
    throw new Error(`Verification record has no row for "${rowLabel}" — cannot evaluate this question.`);
  }
  const cells = row.split('|').slice(1, -1).map((c) => stripMd(c));
  return cells[index] ?? '';
}

function stripMd(s: string): string {
  return s.replace(/`/g, '').replace(/\*\*/g, '').trim();
}

/** Body of a fenced block with the given info string. */
function fenced(tag: string): string {
  const re = new RegExp('```' + tag + '\\r?\\n([\\s\\S]*?)```', 'm');
  const m = record.match(re);
  if (!m) {
    throw new Error(`Verification record has no \`\`\`${tag} block — cannot evaluate this question.`);
  }
  return m[1].trim();
}

/**
 * Fails with a named reason when a finding has not been recorded.
 * This is the mechanism VT-12 asserts: unevaluable means fail, not skip.
 */
function requireAnswered(value: string, vt: string, item: string, question: string): string {
  if (!value || value.toLowerCase() === UNANSWERED || value.startsWith('(')) {
    throw new Error(
      `${vt} cannot evaluate ${item}: ${question}\n` +
        `  The verification record still reads "${UNANSWERED}".\n` +
        `  Run the verification step and record what you observed in design-docs/playbook-engine-verification.md.`
    );
  }
  return value;
}

describe('Playbook engine conformance — fallback triggers', () => {
  // VT-04 — TBI-001 (d)
  it('VT-04: records an explicit verdict for fallback trigger one (store DDL under the app role)', () => {
    const verdict = requireAnswered(
      cell(section('Fallback trigger verdicts'), 'Trigger one'),
      'VT-04',
      'TBI-001 (d)',
      'is fallback trigger one tripped?'
    );
    expect(['tripped', 'not tripped']).toContain(verdict.toLowerCase());
  });

  // VT-07 — TBI-002 (d)
  it('VT-07: records an explicit verdict for fallback trigger two (engine HTTP surface)', () => {
    const verdict = requireAnswered(
      cell(section('Fallback trigger verdicts'), 'Trigger two'),
      'VT-07',
      'TBI-002 (d)',
      'is fallback trigger two tripped?'
    );
    expect(['tripped', 'not tripped']).toContain(verdict.toLowerCase());
  });
});

describe('Playbook engine conformance — recorded findings', () => {
  // VT-09 — TBI-003 (c), (d)
  it('VT-09: declares a connection budget that stays within max_connections and has an engine line', () => {
    const body = section('TBI-003');

    // Column 1 is "Declared max connections"; column 2 is the source note.
    const appPool = requireAnswered(
      cellAt(body, 'Apex application pool', 1),
      'VT-09',
      'TBI-003 (c)',
      'what is the Apex application pool size?'
    );
    const enginePool = requireAnswered(
      cellAt(body, 'Engine store pool', 1),
      'VT-09',
      'TBI-003 (c)',
      'what is the engine store pool size? (the budget must carry a line for the engine)'
    );
    const limit = requireAnswered(
      cellAt(body, 'max_connections', 1),
      'VT-09',
      'TBI-003 (d)',
      "what is the database's max_connections?"
    );

    const pools = [appPool, enginePool].map((v) => Number(v));
    pools.forEach((n, i) => {
      expect(Number.isFinite(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(i).toBeLessThan(2);
    });

    const total = pools.reduce((a, b) => a + b, 0);
    const max = Number(limit);
    expect(Number.isFinite(max)).toBe(true);
    // Fails here rather than the overage being discovered under load.
    expect(total).toBeLessThan(max);
  });

  // VT-10 — TBI-004 (a), (b), (c)
  it('VT-10: records the commercially licensed key list with a source URL and retrieval date', () => {
    const body = section('TBI-004');

    requireAnswered(
      stripMd((body.match(/\*\*Source URL:\*\*(.*)/) ?? [])[1] ?? ''),
      'VT-10',
      'TBI-004 (c)',
      'what source URL was the entitlement list read from?'
    );
    requireAnswered(
      stripMd((body.match(/\*\*Retrieved on:\*\*(.*)/) ?? [])[1] ?? ''),
      'VT-10',
      'TBI-004 (c)',
      'on what date was the entitlement list retrieved?'
    );

    const keys = fenced('licensed-keys');
    requireAnswered(keys, 'VT-10', 'TBI-004 (a)', 'which feature keys sit behind a commercial licence?');

    // Either a real key list, or an explicit `none`. An empty block is unanswered.
    const lines = keys.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    if (lines.length === 1 && lines[0].toLowerCase() === 'none') return;
    lines.forEach((k) => expect(k).toMatch(/^[\w.@/-]+$/));
  });

  // VT-11 — TBI-005 (a), (b), (c)
  it('VT-11: records both telemetry observations, including the control run', () => {
    const body = section('TBI-005');

    // The control run matters as much as the test run: if no calls are seen with telemetry
    // enabled, the observation method is broken and the test observation proves nothing.
    const control = requireAnswered(
      cellAt(body, 'Control', 2),
      'VT-11',
      'TBI-005 (c)',
      'were outbound calls observed with the kill switch DISENGAGED? (without this control the result proves nothing)'
    );
    const test = requireAnswered(
      cellAt(body, 'Test', 2),
      'VT-11',
      'TBI-005 (a)',
      'were outbound calls observed with the kill switch ENGAGED?'
    );

    const sawControlCalls = control.toLowerCase().startsWith('yes');
    expect(test.toLowerCase()).toMatch(/^no/);

    if (sawControlCalls) return;

    // A silent control run has two very different causes: a broken recorder, or an engine path that
    // genuinely emits nothing. Only the second is an acceptable result, and only when the
    // instrument was validated somewhere other than this run — otherwise "we saw nothing" is
    // indistinguishable from "we were not looking".
    const citesInstrumentValidation =
      /egress-recorder-smoke\.test\.ts/.test(body) && /\brecorder was demonstrably live\b/i.test(body);

    if (!citesInstrumentValidation) {
      throw new Error(
        'VT-11 cannot accept TBI-005: the control run observed no outbound calls.\n' +
          '  That is only a finding if the recorder is known to work. The record must cite the\n' +
          '  independent instrument check (tests/integration/egress-recorder-smoke.test.ts) and state\n' +
          '  that the recorder was demonstrably live during the measurement. Otherwise a recorder that\n' +
          '  silently failed would read exactly the same as an engine that stayed quiet.'
      );
    }

    // The kill switch was never exercised against real traffic, so the record must not imply it was.
    expect(section('TBI-005')).toMatch(/Scope of this result/i);
  });
});

describe('Playbook engine conformance — live engine', () => {
  const PROBE = 'tests/integration/support/engine-probe.ts';

  interface DdlResult {
    createdTables: string[];
    createdInPublic: number;
    apexTablesInPublic: number;
    disableInitCreated: number;
  }
  interface InProcessResult {
    startStatus: string;
    resumeStatus: string;
    resumeResult: unknown;
    cancelStatus: string | null;
    expressLayersBefore: number;
    expressLayersAfter: number;
  }
  interface PoolResult {
    acceptsInjectedPool: boolean;
    defaultPoolMax: number | null;
    explicitMaxHonoured: number | null;
  }

  let scratch: ScratchDatabase;
  let ddl: DdlResult;
  let inProcess: InProcessResult;
  let pool: PoolResult;

  /** Runs one probe mode under ts-node and returns its JSON result. */
  function probe<T>(mode: string, schema: string): T {
    let stdout: string;
    try {
      stdout = execFileSync(
        'npx',
        ['ts-node', '-P', 'tsconfig.e2e.json', '--transpile-only', PROBE, mode, scratch.connectionString, schema],
        { encoding: 'utf8', shell: true, maxBuffer: 32 * 1024 * 1024, cwd: REPO_ROOT }
      );
    } catch (error) {
      const detail = error as { stderr?: string; message?: string };
      throw new Error(
        `Live check cannot evaluate "${mode}": the engine probe failed.\n` +
          `  This is a failure, not a reason to skip — the question stays unanswered either way.\n` +
          `  ${String(detail.stderr ?? detail.message).slice(0, 600)}`
      );
    }
    const line = stdout.split(/\r?\n/).find((l) => l.startsWith('PROBE_RESULT '));
    if (!line) throw new Error(`Engine probe "${mode}" produced no result line. Output tail: ${stdout.slice(-400)}`);
    return JSON.parse(line.slice('PROBE_RESULT '.length));
  }

  beforeAll(async () => {
    scratch = await createScratchDatabase('conformance');
    ddl = probe<DdlResult>('store-ddl', 'pe_ddl');
    inProcess = probe<InProcessResult>('in-process', 'pe_proc');
    pool = probe<PoolResult>('pool', 'pe_pool');
  }, 600_000);

  afterAll(async () => {
    if (scratch) await scratch.drop();
  });

  // VT-01 — TBI-001 (a)
  it('VT-01: enumerates the tables the store creates and matches the record', () => {
    expect(ddl.createdTables.length).toBeGreaterThan(0);
    expect(ddl.apexTablesInPublic).toBeGreaterThan(0); // migrations really were applied

    // Every table observed must appear in the record's list, and vice versa.
    const recorded = fenced('tbi-001-tables')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const observedNames = ddl.createdTables.map((t: string) => t.split('.')[1]).sort();
    const recordedNames = recorded.map((t) => t.split('.')[1]).sort();
    expect(observedNames).toEqual(recordedNames);
  });

  // VT-02 — TBI-001 (b)
  it('VT-02: asserts the outcome of initialising with table creation suppressed', () => {
    // The spec requires the outcome be asserted rather than tolerated: suppression either
    // creates nothing, or it does not work and the recorded answer is wrong.
    expect(ddl.disableInitCreated).toBe(0);
    expect(cellAt(section('TBI-001'), '(b)', 1).toLowerCase()).toMatch(/^yes/);
  });

  // VT-03 — TBI-001 (c)
  it('VT-03: confines the store to its schema and enumerates grants outside it', () => {
    expect(ddl.createdInPublic).toBe(0);

    const grants = fenced('tbi-001-grants').trim();
    expect(grants).toBe('none');
  });

  // VT-05 — TBI-002 (a), (b)
  it('VT-05: drives start, suspend, resume and cancel with no server adapter', () => {
    expect(inProcess.startStatus).toBe('suspended'); // start + suspend, recorded separately below
    expect(inProcess.resumeStatus).toBe('success');
    expect(inProcess.resumeResult).toEqual({ decision: 'approved' });
    expect(inProcess.cancelStatus).toBe('canceled');

    const body = section('TBI-002');
    for (const op of ['start', 'suspend', 'resume', 'cancel']) {
      expect(cellAt(body, op, 1).toLowerCase()).toMatch(/^yes/);
    }
  });

  // VT-06 — TBI-002 (c)
  it('VT-06: finds no engine-contributed layer in the Express router stack', () => {
    expect(inProcess.expressLayersAfter).toBe(inProcess.expressLayersBefore);
    expect(inProcess.expressLayersAfter).toBe(0);
  });

  // VT-08 — TBI-003 (a), (b)
  it('VT-08: asserts pool acceptance and size against the recorded answer', () => {
    expect(pool.acceptsInjectedPool).toBe(true);
    expect(cellAt(section('TBI-003'), '(a)', 1).toLowerCase()).toMatch(/^yes/);

    // The recorded engine pool line must match the size actually observed.
    const budgetLine = cellAt(section('TBI-003'), 'Engine store pool', 1).replace(/`/g, '').trim();
    expect(Number(budgetLine)).toBe(pool.defaultPoolMax);
    expect(pool.explicitMaxHonoured).toBe(3);
  });

  /*
   * The checks above compare the engine against the verification record. That is the right test for
   * "has the recorded answer gone stale", but on its own it has a hole: when a version bump turns a
   * check red, editing the record to describe the new behaviour turns it green again. That is the
   * correct fix when the new behaviour is acceptable and precisely the wrong one when it is not.
   *
   * The checks below therefore assert the ADR's phase-0 exit criteria directly, with no reference to
   * the record. They are the conditions under which the decision to adopt this engine no longer
   * holds, so no edit to a document should be able to satisfy them.
   */

  // ADR: "If it requires application-role DDL in the public schema, phase 0 fails."
  it('INV-01: creates no table in the public schema, under any configuration', () => {
    expect(ddl.createdInPublic).toBe(0);
    expect(ddl.disableInitCreated).toBe(0);

    const strays = ddl.createdTables.filter((t) => !t.startsWith('pe_ddl.'));
    expect(strays).toEqual([]);
  });

  /*
   * There is deliberately no grant-confinement invariant here yet.
   *
   * The ADR's "a role with no rights elsewhere" describes a restricted role that Engine Governance
   * Scaffolding has still to create. Today the engine connects as the same role that ran the
   * migrations, which therefore owns every Apex table and holds every grant on it. Asserting
   * otherwise would only measure that fact and fail.
   *
   * Once the restricted role exists, the invariant to add is: that role holds no privilege on any
   * table outside the engine schema. `grantsOutsideSchema` in support/scratch-db.ts is the query.
   */

  // ADR: "The engine pool size must be declared and checked against the database connection budget."
  it('INV-03: leaves the connection budget intact against the live server', async () => {
    const maxConnections = Number(await serverSetting(scratch.connectionString, 'max_connections'));
    expect(maxConnections).toBeGreaterThan(0);

    const budget = section('TBI-003');
    const apexPool = Number(cellAt(budget, 'Apex application pool', 1).replace(/`/g, '').trim());
    const recordedMax = Number(cellAt(budget, 'Database max_connections', 1).replace(/`/g, '').trim());

    // The denominator in the record must describe a real server, not an aspiration.
    expect(recordedMax).toBe(maxConnections);

    // Superuser-reserved connections mean the whole number is never available to the application.
    const reserved = Number(await serverSetting(scratch.connectionString, 'superuser_reserved_connections'));
    const usable = maxConnections - reserved;
    expect(apexPool + (pool.defaultPoolMax ?? 0)).toBeLessThanOrEqual(usable * 0.8);
  });
});

describe('Playbook engine conformance — suite behaviour', () => {
  // VT-12 — TBI-006 (b)
  it('VT-12: fails an unevaluable question rather than skipping it', () => {
    const source = fs.readFileSync(SUITE_PATH, 'utf8');

    // No skip mechanism anywhere in the suite.
    expect(source).not.toMatch(/\b(?:it|test|describe)\.skip\s*\(/);
    expect(source).not.toMatch(/\bx(?:it|test|describe)\s*\(/);
    expect(source).not.toMatch(/\.todo\s*\(/);

    // The unevaluable path throws, and the reason names the question.
    expect(() => requireAnswered(UNANSWERED, 'VT-XX', 'TBI-000 (a)', 'a question nobody answered')).toThrow(
      /cannot evaluate TBI-000 \(a\): a question nobody answered/
    );
    expect(() => requireAnswered('', 'VT-XX', 'TBI-000 (a)', 'an empty finding')).toThrow(/cannot evaluate/);
    expect(requireAnswered('not tripped', 'VT-XX', 'TBI-000 (a)', 'an answered question')).toBe('not tripped');
  });

  // VT-13 — TBI-006 (a)
  it('VT-13: completes without production access or credentials', () => {
    const source = fs.readFileSync(SUITE_PATH, 'utf8');

    // Importing ./setup would bind the suite to a shared, pre-migrated database.
    expect(source).not.toMatch(/from\s+'\.\/setup'/);
    expect(source).not.toMatch(/require\(['"]\.\/setup['"]\)/);

    // No credential env var is read by this suite.
    expect(source).not.toMatch(/process\.env\.(?:AZURE|OPENAI|ANTHROPIC|CURSOR)_/);

    // The live checks do need a Postgres server, which the NFR permits — "without production
    // access" is not "without a database". What must hold is that the server can never be a
    // shared or production one, and that guarantee lives in the scratch harness.
    const harness = fs.readFileSync(path.join(REPO_ROOT, 'tests/integration/support/scratch-db.ts'), 'utf8');
    expect(harness).toMatch(/Refusing to create a scratch database on non-local host/);
    expect(harness).toMatch(/ALLOW_REMOTE_SCRATCH_DB/);
    expect(harness).toMatch(/only databases created by this harness/);

    // The record is reachable as a plain file read.
    expect(fs.existsSync(RECORD_PATH)).toBe(true);
  });
});
