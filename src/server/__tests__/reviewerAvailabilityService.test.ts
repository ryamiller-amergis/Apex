/**
 * Unit tests for reviewerAvailabilityService.
 * projectSettingsService is fully mocked — the resolver reads the live configured
 * pool through getApproverPoolForProject and owns no DB access of its own.
 */

jest.mock('../services/projectSettingsService', () => ({
  getApproverPoolForProject: jest.fn().mockResolvedValue({ individuals: [], groups: [] }),
}));

import { resolveReviewerAvailability } from '../services/reviewerAvailabilityService';
import type { ReviewerDocumentType } from '../../shared/types/approvals';
import type { ApproverPoolResponse } from '../../shared/types/projectSettings';

const { getApproverPoolForProject: mockGetApproverPoolForProject } = jest.requireMock(
  '../services/projectSettingsService',
) as { getApproverPoolForProject: jest.Mock };

// ── Helpers ─────────────────────────────────────────────────────────────────────

function makeIndividual(userId: string, documentType: ReviewerDocumentType) {
  return {
    id: `approver-${userId}-${documentType}`,
    settingsId: 'settings-1',
    userId,
    documentType,
    displayName: `User ${userId}`,
    email: `${userId}@example.com`,
    assignedBy: 'admin-1',
    assignedAt: '2026-01-01T00:00:00Z',
  };
}

function makeGroup(
  groupId: string,
  documentType: ReviewerDocumentType,
  memberUserIds: string[],
) {
  return {
    id: groupId,
    name: `Group ${groupId}`,
    description: null,
    project: 'proj-alpha',
    isDefault: false,
    createdBy: 'admin-1',
    createdAt: '2026-01-01T00:00:00Z',
    documentType,
    members: memberUserIds.map((userId) => ({
      groupId,
      userId,
      displayName: `User ${userId}`,
      email: `${userId}@example.com`,
      addedBy: 'admin-1',
      addedAt: '2026-01-01T00:00:00Z',
    })),
  };
}

function makePool(
  documentType: ReviewerDocumentType,
  individualUserIds: string[],
  groups: Array<{ groupId: string; memberUserIds: string[] }> = [],
): ApproverPoolResponse {
  return {
    individuals: individualUserIds.map((userId) => makeIndividual(userId, documentType)),
    groups: groups.map((g) => makeGroup(g.groupId, documentType, g.memberUserIds)),
  };
}

const emptyPool: ApproverPoolResponse = { individuals: [], groups: [] };

/** Routes each mocked getApproverPoolForProject call to a per-module pool. */
function mockPoolsByModule(pools: Partial<Record<ReviewerDocumentType, ApproverPoolResponse>>) {
  mockGetApproverPoolForProject.mockImplementation(
    async (_project: string, documentType: ReviewerDocumentType) =>
      pools[documentType] ?? emptyPool,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetApproverPoolForProject.mockReset();
  mockGetApproverPoolForProject.mockResolvedValue(emptyPool);
});

// ── Availability signal per module ──────────────────────────────────────────────

describe('resolveReviewerAvailability — availability signal', () => {
  it('TBI-003 DoD-0 / VT-01 / PBI-004 AC-0 reports available=true with candidateCount for a PRD pool of two and available=false/0 for an empty Design Doc pool', async () => {
    // Arrange
    mockPoolsByModule({
      prd: makePool('prd', ['u1', 'u2']),
      design_doc: emptyPool,
    });

    // Act
    const result = await resolveReviewerAvailability('proj-alpha', ['prd', 'design_doc']);

    // Assert
    expect(result).toEqual({
      project: 'proj-alpha',
      modules: [
        { documentType: 'prd', available: true, candidateCount: 2 },
        { documentType: 'design_doc', available: false, candidateCount: 0 },
      ],
    });
  });

  it('TBI-003 DoD-0 resolves the pool for every requested module and preserves the requested order', async () => {
    // Arrange
    mockPoolsByModule({
      adr: makePool('adr', ['a1']),
      test_case: makePool('test_case', ['q1', 'q2']),
      design_prototype: emptyPool,
    });

    // Act
    const result = await resolveReviewerAvailability('proj-alpha', [
      'adr',
      'test_case',
      'design_prototype',
    ]);

    // Assert
    expect(result.modules.map((m) => m.documentType)).toEqual([
      'adr',
      'test_case',
      'design_prototype',
    ]);
    expect(mockGetApproverPoolForProject.mock.calls).toEqual([
      ['proj-alpha', 'adr'],
      ['proj-alpha', 'test_case'],
      ['proj-alpha', 'design_prototype'],
    ]);
  });

  it('PBI-005 AC-0 an ADR pool of three distinct candidates across individuals and group members resolves available=true with candidateCount 3', async () => {
    // Arrange
    mockPoolsByModule({
      adr: makePool('adr', ['arch-1'], [{ groupId: 'g-architects', memberUserIds: ['arch-2', 'arch-3'] }]),
    });

    // Act
    const result = await resolveReviewerAvailability('proj-alpha', ['adr']);

    // Assert
    expect(result.modules[0]).toEqual({
      documentType: 'adr',
      available: true,
      candidateCount: 3,
    });
  });

  it('TBI-003 DoD-3 candidateCount counts unique people when the same user appears as an individual and in multiple groups', async () => {
    // Arrange
    mockPoolsByModule({
      prd: makePool(
        'prd',
        ['dup-1', 'dup-1', 'solo-1'],
        [
          { groupId: 'g1', memberUserIds: ['dup-1', 'group-only-1'] },
          { groupId: 'g2', memberUserIds: ['group-only-1', 'solo-1'] },
        ],
      ),
    });

    // Act
    const result = await resolveReviewerAvailability('proj-alpha', ['prd']);

    // Assert
    expect(result.modules[0]).toEqual({
      documentType: 'prd',
      available: true,
      candidateCount: 3,
    });
  });
});

// ── Unavailable pools ───────────────────────────────────────────────────────────

describe('resolveReviewerAvailability — unavailable pools', () => {
  it('TBI-003 DoD-1 / VT-02 an empty configured pool resolves available=false with candidateCount 0', async () => {
    // Arrange
    mockPoolsByModule({ design_doc: emptyPool });

    // Act
    const result = await resolveReviewerAvailability('proj-alpha', ['design_doc']);

    // Assert
    expect(result.modules[0]).toEqual({
      documentType: 'design_doc',
      available: false,
      candidateCount: 0,
    });
  });

  it('TBI-003 DoD-1 / VT-08 / PBI-005 AC-2 a configured group whose membership was emptied resolves available=false with candidateCount 0 and does not throw', async () => {
    // Arrange
    mockPoolsByModule({
      adr: makePool('adr', [], [{ groupId: 'g-emptied', memberUserIds: [] }]),
    });

    // Act
    const result = await resolveReviewerAvailability('proj-alpha', ['adr']);

    // Assert
    expect(result.modules[0]).toEqual({
      documentType: 'adr',
      available: false,
      candidateCount: 0,
    });
  });

  it('PBI-004 AC-2 every requested module can resolve unavailable so callers can recognize a full-step skip', async () => {
    // Arrange
    mockPoolsByModule({});

    // Act
    const result = await resolveReviewerAvailability('proj-alpha', [
      'prd',
      'design_doc',
      'design_prototype',
      'test_case',
      'adr',
    ]);

    // Assert
    expect(result.modules).toHaveLength(5);
    expect(result.modules.every((m) => m.available === false && m.candidateCount === 0)).toBe(true);
  });
});

// ── No caching (assumption U1) ───────────────────────────────────────────────────

describe('resolveReviewerAvailability — recomputation', () => {
  it('assumption U1 recomputes from the live configured pool on every call rather than caching', async () => {
    // Arrange
    mockGetApproverPoolForProject
      .mockResolvedValueOnce(makePool('prd', ['u1', 'u2']))
      .mockResolvedValueOnce(emptyPool);

    // Act
    const first = await resolveReviewerAvailability('proj-alpha', ['prd']);
    const second = await resolveReviewerAvailability('proj-alpha', ['prd']);

    // Assert
    expect(first.modules[0]).toEqual({ documentType: 'prd', available: true, candidateCount: 2 });
    expect(second.modules[0]).toEqual({ documentType: 'prd', available: false, candidateCount: 0 });
    expect(mockGetApproverPoolForProject).toHaveBeenCalledTimes(2);
  });

  it('returns an empty module list when no modules are requested', async () => {
    // Arrange / Act
    const result = await resolveReviewerAvailability('proj-alpha', []);

    // Assert
    expect(result).toEqual({ project: 'proj-alpha', modules: [] });
    expect(mockGetApproverPoolForProject).not.toHaveBeenCalled();
  });
});
