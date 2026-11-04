/**
 * S2 — Pure requirement amendment, classification, and verification carry-over tests (TBI-026 DoD-0, PBI-030 AC-0..1, PBI-031 AC-0, AC-2, AC-3 / VT-01..VT-08, VT-35, VT-36).
 */
import type {
  BuildRequirement,
  BuildRiskDecision,
  BuildVerificationRow,
} from '../../shared/types/build';
import {
  applyRequirementAmendment,
  classifyRevisionChange,
  planVerificationRows,
} from '../services/buildRequirementAmendment';

describe('buildRequirementAmendment (TBI-026 DoD-0, PBI-030, PBI-031 / VT-01..VT-08, VT-35, VT-36)', () => {
  const baseRequirements: BuildRequirement[] = [
    { id: 'AC-1', kind: 'ac', text: 'First criterion', retired: false },
    { id: 'AC-2', kind: 'ac', text: 'Second criterion', retired: false },
    { id: 'BR-1', kind: 'br', text: 'First business rule', retired: false },
  ];

  it('VT-01 TBI-026 DoD-0 / PBI-030 AC-0 keeps ID of changed requirement and leaves untouched items unchanged', () => {
    const result = applyRequirementAmendment(
      baseRequirements,
      [],
      {
        changed: [{ id: 'AC-2', text: 'Updated second criterion' }],
        added: [],
        dropped: [],
        assumptions: ['A1'],
        exclusions: ['E1'],
        riskDecisionChanges: [],
        classification: 'small',
        touchesMigration: false,
      },
      2,
    );

    expect(result.requirements).toEqual([
      { id: 'AC-1', kind: 'ac', text: 'First criterion', retired: false },
      { id: 'AC-2', kind: 'ac', text: 'Updated second criterion', retired: false },
      { id: 'BR-1', kind: 'br', text: 'First business rule', retired: false },
    ]);
    expect(result.changedIds).toEqual(['AC-2']);
    expect(result.addedIds).toEqual([]);
    expect(result.droppedIds).toEqual([]);
  });

  it('VT-02 TBI-026 DoD-0 / PBI-030 AC-0 assigns next ID counting retired items so retired IDs are never reused', () => {
    const reqsWithRetired: BuildRequirement[] = [
      { id: 'AC-1', kind: 'ac', text: 'First', retired: false },
      { id: 'AC-2', kind: 'ac', text: 'Second', retired: false },
      { id: 'AC-3', kind: 'ac', text: 'Third retired', retired: true },
    ];

    const result = applyRequirementAmendment(
      reqsWithRetired,
      [],
      {
        changed: [],
        added: [{ kind: 'ac', text: 'Fourth criterion' }],
        dropped: [],
        assumptions: [],
        exclusions: [],
        riskDecisionChanges: [],
        classification: 'small',
        touchesMigration: false,
      },
      2,
    );

    expect(result.addedIds).toEqual(['AC-4']);
    expect(result.requirements.find((r) => r.id === 'AC-4')).toEqual({
      id: 'AC-4',
      kind: 'ac',
      text: 'Fourth criterion',
      retired: false,
    });
  });

  it('VT-03 TBI-026 NFR / PBI-030 AC-0 marks dropped item retired with revision number and reason and never deletes it', () => {
    const result = applyRequirementAmendment(
      baseRequirements,
      [],
      {
        changed: [],
        added: [],
        dropped: [{ id: 'AC-2', reason: 'No longer needed' }],
        assumptions: [],
        exclusions: [],
        riskDecisionChanges: [],
        classification: 'small',
        touchesMigration: false,
      },
      3,
    );

    expect(result.requirements).toHaveLength(baseRequirements.length);
    const ac2 = result.requirements.find((r) => r.id === 'AC-2');
    expect(ac2?.retired).toBe(true);
    expect(ac2?.retiredInRevision).toBe(3);
    expect(ac2?.retiredReason).toBe('No longer needed');
  });

  it('VT-04, VT-05, VT-06 throws UNKNOWN_REQUIREMENT_ID, RETIRED_REQUIREMENT_EDIT, or EMPTY_AMENDMENT without mutating input', () => {
    const snapshot = JSON.stringify(baseRequirements);

    expect(() =>
      applyRequirementAmendment(
        baseRequirements,
        [],
        {
          changed: [{ id: 'AC-9', text: 'Does not exist' }],
          added: [],
          dropped: [],
          assumptions: [],
          exclusions: [],
          riskDecisionChanges: [],
          classification: 'small',
          touchesMigration: false,
        },
        2,
      ),
    ).toThrow(/UNKNOWN_REQUIREMENT_ID/);
    expect(JSON.stringify(baseRequirements)).toBe(snapshot);

    const withRetired: BuildRequirement[] = [
      ...baseRequirements,
      { id: 'AC-3', kind: 'ac', text: 'Retired item', retired: true },
    ];
    expect(() =>
      applyRequirementAmendment(
        withRetired,
        [],
        {
          changed: [{ id: 'AC-3', text: 'Try editing retired' }],
          added: [],
          dropped: [],
          assumptions: [],
          exclusions: [],
          riskDecisionChanges: [],
          classification: 'small',
          touchesMigration: false,
        },
        2,
      ),
    ).toThrow(/RETIRED_REQUIREMENT_EDIT/);

    expect(() =>
      applyRequirementAmendment(
        baseRequirements,
        [],
        {
          changed: [],
          added: [],
          dropped: [],
          assumptions: [],
          exclusions: [],
          riskDecisionChanges: [],
          classification: 'small',
          touchesMigration: false,
        },
        2,
      ),
    ).toThrow(/EMPTY_AMENDMENT/);
  });

  it('VT-07, VT-08 PBI-031 AC-0, AC-2 classifies as full only when revision adds/changes high-risk decision or touchesMigration, and small when high-risk decision is carried over unchanged', () => {
    expect(
      classifyRevisionChange({
        agentClassification: 'small',
        touchesMigration: false,
        newOrChangedRiskDecisions: [],
      }),
    ).toBe('small');

    expect(
      classifyRevisionChange({
        agentClassification: 'small',
        touchesMigration: true,
        newOrChangedRiskDecisions: [],
      }),
    ).toBe('full');

    expect(
      classifyRevisionChange({
        agentClassification: 'small',
        touchesMigration: false,
        newOrChangedRiskDecisions: [
          {
            id: 'RD-2',
            category: 'data',
            rating: 'high',
            decision: 'Soft delete',
            rationale: 'Reversible',
          },
        ],
      }),
    ).toBe('full');

    // VT-08: carried-over high risk decision not in newOrChangedRiskDecisions -> stays small
    expect(
      classifyRevisionChange({
        agentClassification: 'small',
        touchesMigration: false,
        newOrChangedRiskDecisions: [],
      }),
    ).toBe('small');
  });

  it('VT-35, VT-36 PBI-031 AC-3 / TBI-026 NFR plans verification carry-over: copies untouched with evidence, creates pending for changed/added, and closes dropped as retired', () => {
    const previousRows: Array<
      Pick<
        BuildVerificationRow,
        | 'requirementId'
        | 'kind'
        | 'testTier'
        | 'testRefs'
        | 'redEvidence'
        | 'greenEvidence'
        | 'evidenceBlobRef'
        | 'status'
        | 'deferralReason'
        | 'carriedFromRevisionNumber'
      >
    > = [
      {
        requirementId: 'AC-1',
        kind: 'ac',
        testTier: 'unit',
        testRefs: [{ path: 'src/a.test.ts', name: 'AC-1 test' }],
        redEvidence: {
          commit: 'r1',
          recordedAt: '2026-11-01T10:00:00.000Z',
          command: 'jest',
          exitCode: 1,
          passed: 0,
          failed: 1,
          summary: 'fail',
        },
        greenEvidence: {
          commit: 'g1',
          recordedAt: '2026-11-01T10:05:00.000Z',
          command: 'jest',
          exitCode: 0,
          passed: 1,
          failed: 0,
          summary: 'pass',
        },
        evidenceBlobRef: null,
        status: 'pass',
        deferralReason: null,
        carriedFromRevisionNumber: null,
      },
      {
        requirementId: 'AC-2',
        kind: 'ac',
        testTier: 'unit',
        testRefs: [{ path: 'src/b.test.ts', name: 'AC-2 test' }],
        redEvidence: null,
        greenEvidence: null,
        evidenceBlobRef: null,
        status: 'pass',
        deferralReason: null,
        carriedFromRevisionNumber: null,
      },
      {
        requirementId: 'AC-3',
        kind: 'ac',
        testTier: 'unit',
        testRefs: [{ path: 'src/c.test.ts', name: 'AC-3 test' }],
        redEvidence: null,
        greenEvidence: null,
        evidenceBlobRef: null,
        status: 'pass',
        deferralReason: null,
        carriedFromRevisionNumber: null,
      },
    ];

    const nextRequirements: BuildRequirement[] = [
      { id: 'AC-1', kind: 'ac', text: 'Untouched', retired: false },
      { id: 'AC-2', kind: 'ac', text: 'Changed', retired: false },
      { id: 'AC-3', kind: 'ac', text: 'Dropped', retired: true },
      { id: 'AC-4', kind: 'ac', text: 'Added', retired: false },
    ];
    const nextRiskDecisions: BuildRiskDecision[] = [];

    const plan = planVerificationRows({
      previousRevisionNumber: 1,
      previousRows,
      changedIds: ['AC-2'],
      addedIds: ['AC-4'],
      droppedIds: ['AC-3'],
      nextRequirements,
      nextRiskDecisions,
    });

    expect(plan.copy.map((r) => r.requirementId)).toEqual(['AC-1']);
    expect(plan.copy[0].carriedFromRevisionNumber).toBe(1);
    expect(plan.copy[0].status).toBe('pass');
    expect(plan.createPending.map((r) => r.requirementId)).toEqual(['AC-2', 'AC-4']);
    expect(plan.createPending.every((r) => r.status === 'pending')).toBe(true);
    expect(plan.closeRetired.map((r) => r.requirementId)).toEqual(['AC-3']);
    expect(plan.closeRetired[0].status).toBe('retired');
  });
});
