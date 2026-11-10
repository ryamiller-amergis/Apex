/**
 * Pure verification evidence checker unit tests (VT-06..VT-16, VT-19).
 * Owning items: TBI-021, PBI-022, PBI-023.
 */
import type {
  EvidenceBlock,
  EvidenceChecks,
  EvidenceEntry,
} from '../services/builds/evidenceBlockParser';
import {
  decideTaskDone,
  type DecideTaskDoneInput,
  type OwnedRequirementSpec,
} from '../services/builds/verificationEvidenceChecker';

const DEFAULT_MANIFEST = {
  typeCheck: 'npx tsc -p tsconfig.server.json --noEmit',
  lint: 'npx eslint src --ext .ts,.tsx',
  relatedTests: 'npx jest --findRelatedTests {files}',
};

function makePassingChecks(overrides: Partial<EvidenceChecks> = {}): EvidenceChecks {
  return {
    typeCheck: { command: DEFAULT_MANIFEST.typeCheck, exitCode: 0 },
    lint: { command: DEFAULT_MANIFEST.lint, exitCode: 0 },
    relatedTests: {
      command: 'npx jest --findRelatedTests src/server/services/widget.ts',
      exitCode: 0,
    },
    ...overrides,
  };
}

function makePassingEntry(
  requirementId: string,
  overrides: Partial<EvidenceEntry> = {},
): EvidenceEntry {
  const testName = `${requirementId}: meets the requirement`;
  const testFile = `src/server/__tests__/${requirementId.toLowerCase()}.test.ts`;
  return {
    requirementId,
    tier: 'unit',
    testReferences: [{ file: testFile, name: testName }],
    red: {
      commit: `red-${requirementId.toLowerCase()}`,
      command: `npx jest ${testFile}`,
      exitCode: 1,
      failedTests: [testName],
      output: `FAIL ${testFile}`,
    },
    green: {
      commit: `green-${requirementId.toLowerCase()}`,
      command: `npx jest ${testFile}`,
      exitCode: 0,
      passedTests: [testName],
      output: `PASS ${testFile}`,
    },
    deferral: null,
    ...overrides,
  };
}

function makeBlock(overrides: Partial<EvidenceBlock> = {}): EvidenceBlock {
  return {
    version: 1,
    taskKey: 't-impl-1',
    attemptNumber: 1,
    entries: [makePassingEntry('AC-1'), makePassingEntry('AC-2')],
    checks: makePassingChecks(),
    standardsReview: { completed: true, findings: [] },
    escalation: null,
    ...overrides,
    visualReview: overrides.visualReview ?? null,
  };
}

function makeOwnedSpecs(
  ids: Array<string | OwnedRequirementSpec> = ['AC-1', 'AC-2'],
): OwnedRequirementSpec[] {
  return ids.map((item) => {
    if (typeof item !== 'string') return item;
    if (item.startsWith('RD-')) {
      return { id: item, kind: 'risk_decision', retired: false };
    }
    if (item.startsWith('DOD-')) {
      return { id: item, kind: 'dod', retired: false };
    }
    if (item.startsWith('BR-')) {
      return { id: item, kind: 'br', retired: false };
    }
    if (item.startsWith('NFR-')) {
      return { id: item, kind: 'nfr', retired: false };
    }
    return { id: item, kind: 'ac', retired: false };
  });
}

function makeInput(overrides: Partial<DecideTaskDoneInput> = {}): DecideTaskDoneInput {
  return {
    ownedIds: makeOwnedSpecs(['AC-1', 'AC-2']),
    block: makeBlock(),
    manifest: DEFAULT_MANIFEST,
    ownedFiles: null,
    ...overrides,
  };
}

describe('verificationEvidenceChecker.decideTaskDone', () => {
  describe('VT-06: full red and green evidence with passing manifest checks', () => {
    it('VT-06: returns done, marks both rows pass, and reports no violations when AC-1 and AC-2 have complete evidence and passing checks', () => {
      const result = decideTaskDone(makeInput());

      expect(result.outcome).toBe('done');
      expect(result.mayReportDone).toBe(true);
      expect(result.violations).toEqual([]);
      expect(result.unknownRequirementIds).toEqual([]);
      expect(result.escalation).toBeNull();
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0]).toMatchObject({
        requirementId: 'AC-1',
        kind: 'ac',
        tier: 'unit',
        status: 'pass',
        deferralReason: null,
      });
      expect(result.rows[0].red?.commit).toBe('red-ac-1');
      expect(result.rows[0].green?.commit).toBe('green-ac-1');
      expect(result.rows[1]).toMatchObject({
        requirementId: 'AC-2',
        kind: 'ac',
        tier: 'unit',
        status: 'pass',
        deferralReason: null,
      });
    });
  });

  describe('VT-07: missing red evidence is a note when the final run passed', () => {
    it('VT-07: returns done, records a missing_red_evidence note, and marks AC-2 deferred with a reason', () => {
      const block = makeBlock({
        entries: [makePassingEntry('AC-1'), makePassingEntry('AC-2', { red: null })],
      });

      const result = decideTaskDone(makeInput({ block }));

      expect(result.outcome).toBe('done');
      expect(result.mayReportDone).toBe(true);
      expect(result.violations).toEqual([]);
      expect(result.notes).toEqual([{ code: 'missing_red_evidence', requirementId: 'AC-2' }]);
      const ac1Row = result.rows.find((r) => r.requirementId === 'AC-1');
      const ac2Row = result.rows.find((r) => r.requirementId === 'AC-2');
      expect(ac1Row?.status).toBe('pass');
      expect(ac2Row?.status).toBe('deferred');
      expect(ac2Row?.deferralReason).toMatch(/final test run passed/i);
      expect(ac2Row?.red).toBeNull();
      expect(ac2Row?.green).not.toBeNull();
    });
  });

  describe('VT-08: missing green evidence or missing test reference refuses the task', () => {
    it('VT-08: returns refused with missing_green_evidence when green is null', () => {
      const block = makeBlock({
        entries: [makePassingEntry('AC-1', { green: null }), makePassingEntry('AC-2')],
      });

      const result = decideTaskDone(makeInput({ block }));

      expect(result.outcome).toBe('refused');
      expect(result.mayReportDone).toBe(false);
      expect(result.violations).toEqual([
        { code: 'missing_green_evidence', requirementId: 'AC-1' },
      ]);
      expect(result.rows.find((r) => r.requirementId === 'AC-1')?.status).toBe('fail');
      expect(result.rows.find((r) => r.requirementId === 'AC-2')?.status).toBe('pass');
    });

    it('VT-08: returns refused with missing_test_reference when testReferences is empty', () => {
      const block = makeBlock({
        entries: [makePassingEntry('AC-1', { testReferences: [] }), makePassingEntry('AC-2')],
      });

      const result = decideTaskDone(makeInput({ block }));

      expect(result.outcome).toBe('refused');
      expect(result.mayReportDone).toBe(false);
      expect(result.violations).toEqual([
        { code: 'missing_test_reference', requirementId: 'AC-1' },
      ]);
      expect(result.rows.find((r) => r.requirementId === 'AC-1')?.status).toBe('fail');
    });
  });

  describe('VT-09: exit codes, distinct commits, and test execution membership', () => {
    it('VT-09: records red_not_failing as a note when red run exits with 0', () => {
      const ac1 = makePassingEntry('AC-1');
      const block = makeBlock({
        entries: [
          { ...ac1, red: { ...ac1.red!, exitCode: 0 } },
          makePassingEntry('AC-2'),
        ],
      });

      const result = decideTaskDone(makeInput({ block }));

      expect(result.outcome).toBe('done');
      expect(result.violations).toEqual([]);
      expect(result.notes).toEqual([{ code: 'red_not_failing', requirementId: 'AC-1' }]);
      expect(result.rows.find((r) => r.requirementId === 'AC-1')?.status).toBe('pass');
    });

    it('VT-09: returns green_not_passing when green run exits with non-zero', () => {
      const ac1 = makePassingEntry('AC-1');
      const block = makeBlock({
        entries: [
          { ...ac1, green: { ...ac1.green!, exitCode: 1 } },
          makePassingEntry('AC-2'),
        ],
      });

      const result = decideTaskDone(makeInput({ block }));

      expect(result.outcome).toBe('refused');
      expect(result.violations).toEqual([{ code: 'green_not_passing', requirementId: 'AC-1' }]);
      expect(result.rows.find((r) => r.requirementId === 'AC-1')?.status).toBe('fail');
    });

    it('VT-09: records red_green_same_commit as a note when red and green commits are identical', () => {
      const ac1 = makePassingEntry('AC-1');
      const block = makeBlock({
        entries: [
          {
            ...ac1,
            red: { ...ac1.red!, commit: 'same-sha-123' },
            green: { ...ac1.green!, commit: 'same-sha-123' },
          },
          makePassingEntry('AC-2'),
        ],
      });

      const result = decideTaskDone(makeInput({ block }));

      expect(result.outcome).toBe('done');
      expect(result.violations).toEqual([]);
      expect(result.notes).toEqual([
        { code: 'red_green_same_commit', requirementId: 'AC-1' },
      ]);
      expect(result.rows.find((r) => r.requirementId === 'AC-1')?.status).toBe('pass');
    });

    it('VT-09: notes a red-side name mismatch, but refuses when the test is absent from the passing run', () => {
      const ac1 = makePassingEntry('AC-1');
      const ac2 = makePassingEntry('AC-2');
      const block = makeBlock({
        entries: [
          { ...ac1, red: { ...ac1.red!, failedTests: ['unrelated test'] } },
          { ...ac2, green: { ...ac2.green!, passedTests: ['unrelated test'] } },
        ],
      });

      const result = decideTaskDone(makeInput({ block }));

      expect(result.outcome).toBe('refused');
      expect(result.violations).toEqual([
        { code: 'test_not_in_run', requirementId: 'AC-2' },
      ]);
      expect(result.notes).toEqual([{ code: 'test_not_in_run', requirementId: 'AC-1' }]);
      expect(result.rows.find((r) => r.requirementId === 'AC-1')?.status).toBe('pass');
      expect(result.rows.find((r) => r.requirementId === 'AC-2')?.status).toBe('fail');
    });

    it('VT-09: matches test names across spacing, case, and a describe-block prefix', () => {
      const ac1 = makePassingEntry('AC-1');
      const block = makeBlock({
        entries: [
          {
            ...ac1,
            green: { ...ac1.green!, passedTests: ['Shifts API > ac-1:  Meets the requirement.'] },
          },
          makePassingEntry('AC-2'),
        ],
      });

      const result = decideTaskDone(makeInput({ block }));

      expect(result.outcome).toBe('done');
      expect(result.violations).toEqual([]);
    });
  });

  describe('VT-10: quality manifest check presence, exit code, and command matching', () => {
    it('VT-10: returns check_missing when typeCheck is missing', () => {
      const block = makeBlock({
        checks: makePassingChecks({ typeCheck: null }),
      });

      const result = decideTaskDone(makeInput({ block }));

      expect(result.outcome).toBe('refused');
      expect(result.mayReportDone).toBe(false);
      expect(result.violations).toEqual([{ code: 'check_missing', requirementId: null }]);
    });

    it('VT-10: returns check_failed when lint exits with code 2', () => {
      const block = makeBlock({
        checks: makePassingChecks({
          lint: { command: DEFAULT_MANIFEST.lint, exitCode: 2 },
        }),
      });

      const result = decideTaskDone(makeInput({ block }));

      expect(result.outcome).toBe('refused');
      expect(result.mayReportDone).toBe(false);
      expect(result.violations).toEqual([{ code: 'check_failed', requirementId: null }]);
    });

    it('VT-10: returns command_mismatch when relatedTests uses a command not matching the manifest', () => {
      const block = makeBlock({
        checks: makePassingChecks({
          relatedTests: { command: 'npm run some-other-test', exitCode: 0 },
        }),
      });

      const result = decideTaskDone(makeInput({ block }));

      expect(result.outcome).toBe('refused');
      expect(result.mayReportDone).toBe(false);
      expect(result.violations).toEqual([{ code: 'command_mismatch', requirementId: null }]);
    });

    it('VT-10: accepts the same tool phrased differently (the c62bff41 pnpm/vitest report)', () => {
      const manifest = {
        typeCheck: 'corepack pnpm typecheck',
        lint: 'corepack pnpm lint',
        relatedTests: 'corepack pnpm vitest related --run {files}',
      };
      const block = makeBlock({
        checks: {
          typeCheck: { command: 'corepack pnpm run typecheck', exitCode: 0 },
          lint: { command: 'pnpm lint', exitCode: 0 },
          relatedTests: {
            command:
              'corepack pnpm exec vitest run --project api apps/api/test/api/shifts.api.test.ts',
            exitCode: 0,
          },
        },
      });

      const result = decideTaskDone(makeInput({ block, manifest }));

      expect(result.outcome).toBe('done');
      expect(result.violations).toEqual([]);
    });

    it('VT-10: still refuses a related-tests run with a different test runner', () => {
      const block = makeBlock({
        checks: makePassingChecks({
          relatedTests: { command: 'npx vitest run src/server/services/widget.ts', exitCode: 0 },
        }),
      });

      const result = decideTaskDone(makeInput({ block }));

      expect(result.violations).toEqual([{ code: 'command_mismatch', requirementId: null }]);
    });
  });

  describe('VT-11: owned requirement omitted from block', () => {
    it('VT-11: emits missing_evidence_entry and seeds a fail row with no evidence when AC-3 is omitted', () => {
      const result = decideTaskDone(
        makeInput({
          ownedIds: makeOwnedSpecs(['AC-1', 'AC-2', 'AC-3']),
          block: makeBlock(),
        }),
      );

      expect(result.outcome).toBe('refused');
      expect(result.mayReportDone).toBe(false);
      expect(result.violations).toEqual([
        { code: 'missing_evidence_entry', requirementId: 'AC-3' },
      ]);
      const ac3Row = result.rows.find((r) => r.requirementId === 'AC-3');
      expect(ac3Row).toEqual({
        requirementId: 'AC-3',
        kind: 'ac',
        tier: null,
        status: 'fail',
        testReferences: [],
        red: null,
        green: null,
        deferralReason: null,
      });
    });
  });

  describe('VT-12: risk decision row of its own', () => {
    it('VT-12: emits a separate risk_decision row with status pass when RD-1 has valid red and green evidence', () => {
      const block = makeBlock({
        entries: [
          makePassingEntry('AC-1'),
          makePassingEntry('RD-1', {
            testReferences: [
              {
                file: 'src/server/__tests__/rd1.test.ts',
                name: 'RD-1: enforces soft-delete instead of hard delete',
              },
            ],
            red: {
              commit: 'red-rd-1',
              command: 'npx jest src/server/__tests__/rd1.test.ts',
              exitCode: 1,
              failedTests: ['RD-1: enforces soft-delete instead of hard delete'],
              output: 'FAIL',
            },
            green: {
              commit: 'green-rd-1',
              command: 'npx jest src/server/__tests__/rd1.test.ts',
              exitCode: 0,
              passedTests: ['RD-1: enforces soft-delete instead of hard delete'],
              output: 'PASS',
            },
          }),
        ],
      });

      const result = decideTaskDone(
        makeInput({
          ownedIds: makeOwnedSpecs(['AC-1', 'RD-1']),
          block,
        }),
      );

      expect(result.outcome).toBe('done');
      expect(result.mayReportDone).toBe(true);
      expect(result.violations).toEqual([]);
      expect(result.rows).toHaveLength(2);
      const rdRow = result.rows.find((r) => r.requirementId === 'RD-1');
      expect(rdRow).toBeDefined();
      expect(rdRow?.kind).toBe('risk_decision');
      expect(rdRow?.status).toBe('pass');
      expect(rdRow?.testReferences).toEqual([
        {
          file: 'src/server/__tests__/rd1.test.ts',
          name: 'RD-1: enforces soft-delete instead of hard delete',
        },
      ]);
    });
  });

  describe('VT-13: deferral rules', () => {
    it('VT-13: allows deferral for an e2e tier entry with a non-empty reason and test reference, returning deferred row and done', () => {
      const block = makeBlock({
        entries: [
          makePassingEntry('AC-1'),
          {
            requirementId: 'AC-2',
            tier: 'e2e',
            testReferences: [
              { file: 'tests/e2e/specs/ac2.spec.ts', name: 'AC-2: renders full flow' },
            ],
            red: null,
            green: null,
            deferral: { reason: 'Playwright browser binaries are not installed in this worker' },
          },
        ],
      });

      const result = decideTaskDone(makeInput({ block }));

      expect(result.outcome).toBe('done');
      expect(result.mayReportDone).toBe(true);
      expect(result.violations).toEqual([]);
      const ac2Row = result.rows.find((r) => r.requirementId === 'AC-2');
      expect(ac2Row).toEqual({
        requirementId: 'AC-2',
        kind: 'ac',
        tier: 'e2e',
        status: 'deferred',
        testReferences: [{ file: 'tests/e2e/specs/ac2.spec.ts', name: 'AC-2: renders full flow' }],
        red: null,
        green: null,
        deferralReason: 'Playwright browser binaries are not installed in this worker',
      });
    });

    it('VT-13: refuses deferral on a unit tier AC entry with deferral_not_allowed', () => {
      const block = makeBlock({
        entries: [
          makePassingEntry('AC-1'),
          {
            requirementId: 'AC-2',
            tier: 'unit',
            testReferences: [
              { file: 'src/server/__tests__/ac2.test.ts', name: 'AC-2: unit test' },
            ],
            red: null,
            green: null,
            deferral: { reason: 'Skipped unit test' },
          },
        ],
      });

      const result = decideTaskDone(makeInput({ block }));

      expect(result.outcome).toBe('refused');
      expect(result.mayReportDone).toBe(false);
      expect(result.violations).toEqual([
        { code: 'deferral_not_allowed', requirementId: 'AC-2' },
      ]);
      expect(result.rows.find((r) => r.requirementId === 'AC-2')).toMatchObject({
        status: 'fail',
        deferralReason: null,
      });
    });

    it('VT-13: refuses an e2e deferral when the reason is empty or whitespace', () => {
      const block = makeBlock({
        entries: [
          makePassingEntry('AC-1'),
          {
            requirementId: 'AC-2',
            tier: 'e2e',
            testReferences: [
              { file: 'tests/e2e/specs/ac2.spec.ts', name: 'AC-2: renders full flow' },
            ],
            red: null,
            green: null,
            deferral: { reason: '   ' },
          },
        ],
      });

      const result = decideTaskDone(makeInput({ block }));

      expect(result.outcome).toBe('refused');
      expect(result.mayReportDone).toBe(false);
      expect(result.violations).toEqual([
        { code: 'deferral_not_allowed', requirementId: 'AC-2' },
      ]);
      expect(result.rows.find((r) => r.requirementId === 'AC-2')).toMatchObject({
        status: 'fail',
        deferralReason: null,
      });
    });
  });

  describe('VT-14: retired requirements are neither required nor updated', () => {
    it('VT-14: skips retired owned IDs whether or not the block contains an entry for them', () => {
      const ownedIds: OwnedRequirementSpec[] = [
        { id: 'AC-1', kind: 'ac', retired: false },
        { id: 'AC-2', kind: 'ac', retired: true },
        { id: 'AC-3', kind: 'ac', retired: true },
      ];
      // AC-2 is present in block.entries; AC-3 is absent from block.entries
      const block = makeBlock({
        entries: [makePassingEntry('AC-1'), makePassingEntry('AC-2', { red: null, green: null })],
      });

      const result = decideTaskDone(makeInput({ ownedIds, block }));

      expect(result.outcome).toBe('done');
      expect(result.mayReportDone).toBe(true);
      expect(result.violations).toEqual([]);
      expect(result.unknownRequirementIds).toEqual([]);
      expect(result.rows.map((r) => r.requirementId)).toEqual(['AC-1']);
    });
  });

  describe('VT-15: unknown requirement IDs are dropped and recorded without refusing', () => {
    it('VT-15: drops entries for IDs not in ownedIds, records them in unknownRequirementIds, and still returns done', () => {
      const block = makeBlock({
        entries: [
          makePassingEntry('AC-1'),
          makePassingEntry('AC-2'),
          makePassingEntry('AC-99', { red: null, green: null }),
        ],
      });

      const result = decideTaskDone(makeInput({ block }));

      expect(result.outcome).toBe('done');
      expect(result.mayReportDone).toBe(true);
      expect(result.violations).toEqual([]);
      expect(result.unknownRequirementIds).toEqual(['AC-99']);
      expect(result.rows.map((r) => r.requirementId)).toEqual(['AC-1', 'AC-2']);
    });
  });

  describe('VT-16: escalation preserves committed red evidence rows', () => {
    it('VT-16: returns escalate with mayReportDone false and keeps fail rows with red evidence for two committed red tests', () => {
      const ac1 = makePassingEntry('AC-1', { green: null });
      const ac2 = makePassingEntry('AC-2', { green: null });
      const block = makeBlock({
        entries: [ac1, ac2],
        checks: { typeCheck: null, lint: null, relatedTests: null },
        escalation: {
          reason: 'Feature requires a new database table and three separate tasks',
          planPath: '.apex/build/run-1/plan.json',
        },
      });

      const result = decideTaskDone(makeInput({ block }));

      expect(result.outcome).toBe('escalate');
      expect(result.mayReportDone).toBe(false);
      expect(result.escalation).toEqual({
        reason: 'Feature requires a new database table and three separate tasks',
        planPath: '.apex/build/run-1/plan.json',
      });
      expect(result.rows).toHaveLength(2);
      expect(result.rows[0]).toMatchObject({
        requirementId: 'AC-1',
        status: 'fail',
        green: null,
        deferralReason: null,
      });
      expect(result.rows[0].red?.commit).toBe('red-ac-1');
      expect(result.rows[1]).toMatchObject({
        requirementId: 'AC-2',
        status: 'fail',
        green: null,
        deferralReason: null,
      });
      expect(result.rows[1].red?.commit).toBe('red-ac-2');
    });
  });

  describe('VT-19: test reference path validation against traversal, absolute paths, and ownedFiles', () => {
    it('VT-19: emits invalid_test_reference for ../x.test, /abs/x.test, and a file outside ownedFiles', () => {
      const ownedIds = makeOwnedSpecs(['AC-1', 'AC-2', 'AC-3']);
      const block = makeBlock({
        entries: [
          makePassingEntry('AC-1', {
            testReferences: [{ file: '../x.test.ts', name: 'AC-1: meets the requirement' }],
          }),
          makePassingEntry('AC-2', {
            testReferences: [{ file: '/abs/x.test.ts', name: 'AC-2: meets the requirement' }],
          }),
          makePassingEntry('AC-3', {
            testReferences: [
              {
                file: 'src/server/__tests__/unowned.test.ts',
                name: 'AC-3: meets the requirement',
              },
            ],
          }),
        ],
      });

      const result = decideTaskDone(
        makeInput({
          ownedIds,
          block,
          ownedFiles: ['src/server/__tests__/owned.test.ts', 'src/server/services/owned.ts'],
        }),
      );

      expect(result.outcome).toBe('refused');
      expect(result.mayReportDone).toBe(false);
      expect(result.violations).toEqual([
        { code: 'invalid_test_reference', requirementId: 'AC-1' },
        { code: 'invalid_test_reference', requirementId: 'AC-2' },
        { code: 'invalid_test_reference', requirementId: 'AC-3' },
      ]);
      expect(result.rows.every((r) => r.status === 'fail')).toBe(true);
    });
  });
});
