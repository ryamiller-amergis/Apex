/**
 * TBI-009 — no commercially licensed engine feature may be switched on, and the engine's telemetry
 * must be off.
 *
 * The key list is read from `design-docs/playbook-engine-verification.md` rather than copied here.
 * That record is where FEAT-001's entitlement diff lives, so re-running the diff after a version
 * bump updates this assertion automatically. A copied list would drift and still pass, which is the
 * failure mode the definition of done exists to prevent.
 */
import fs from 'fs';
import path from 'path';
import { buildEngineConfig, ENGINE_POOL_MAX, ENGINE_SCHEMA } from '../services/playbookEngine/engineConfig';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const VERIFICATION_RECORD = path.join(REPO_ROOT, 'design-docs/playbook-engine-verification.md');

/** Reads the fenced ```licensed-keys block FEAT-001 writes into the verification record. */
function licensedKeys(): string[] {
  const record = fs.readFileSync(VERIFICATION_RECORD, 'utf8');
  const block = record.match(/```licensed-keys\r?\n([\s\S]*?)```/);
  if (!block) {
    throw new Error(
      `No \`licensed-keys\` block in ${VERIFICATION_RECORD}. TBI-004 records the entitlement diff ` +
        'there; without it this test has nothing to assert and must fail rather than pass vacuously.'
    );
  }
  return block[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== 'none');
}

/**
 * Judges a key *active*, not merely present.
 *
 * A configuration can name a licensed feature while explicitly switching it off, and calling that a
 * violation would push people toward deleting the evidence that it was considered. The rule applied
 * is written out here so a reviewer can see the judgment rather than infer it: a key counts as
 * active when it appears and its value is not `false`, `null`, `undefined` or an empty string.
 */
function activeKeys(config: unknown, keys: string[]): string[] {
  const serialized = JSON.stringify(config, (_k, value) => (value === undefined ? null : value));
  const flattened: string[] = [];

  const walk = (node: unknown, trail: string): void => {
    if (node === null || typeof node !== 'object') {
      const inactive = node === false || node === null || node === '';
      if (!inactive) flattened.push(trail);
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      walk(value, trail ? `${trail}.${key}` : key);
    }
  };
  walk(JSON.parse(serialized), '');

  return keys.filter((key) => flattened.some((trail) => trail.includes(key)));
}

describe('TBI-009 — no commercially licensed feature is configured', () => {
  // DoD-0, VT-07
  it('reads a non-empty key list from the verification record', () => {
    const keys = licensedKeys();
    expect(keys.length).toBeGreaterThan(0);
    expect(keys).toContain('@mastra/core/auth/ee');
  });

  // DoD-1, VT-07
  it('finds no licensed key active in the engine configuration', () => {
    expect(activeKeys(buildEngineConfig(), licensedKeys())).toEqual([]);
  });

  // DoD-1 — the detector works, so the clean result above means something
  it('detects a licensed key that has been switched on', () => {
    const keys = licensedKeys();
    const offending = { features: { [keys[0]]: true } };
    expect(activeKeys(offending, keys)).toEqual([keys[0]]);
  });

  // DoD-1, VT-08 — presence is judged on being active, not merely mentioned
  it('treats an explicitly disabled key as inactive', () => {
    const keys = licensedKeys();
    for (const disabledValue of [false, null, '']) {
      expect(activeKeys({ features: { [keys[0]]: disabledValue } }, keys)).toEqual([]);
    }
  });
});

describe('TBI-009 — the engine telemetry kill switch is engaged', () => {
  // VT-09
  it('builds a configuration with telemetry disabled', () => {
    expect(buildEngineConfig().telemetry.enabled).toBe(false);
  });

  /*
   * The FEAT-001 findings this configuration is built from.
   *
   * Confinement is the guarantee, not the absence of DDL. The migration creates the schema and the
   * role and grants `CREATE` inside it; the engine's own 43 tables are the engine's to make, and a
   * store suppressed with no tables behind it is one that cannot read or write. What must stay true
   * is that nothing lands outside the engine's schema, which the conformance suite asserts against
   * a live database (INV-01).
   */
  it('confines the engine to its own schema and lets it create its tables only there', () => {
    const config = buildEngineConfig();
    expect(config.schemaName).toBe(ENGINE_SCHEMA);
    expect(config.schemaName).not.toBe('public');
    expect(config.disableInit).toBe(false);
  });

  // TBI-003's connection budget: the engine's default of 20 is not what Apex activates
  it('declares a pool smaller than the engine default', () => {
    expect(buildEngineConfig().pool.max).toBe(ENGINE_POOL_MAX);
    expect(ENGINE_POOL_MAX).toBeLessThan(20);
  });
});
