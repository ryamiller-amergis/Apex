/**
 * S3 — Pull request body composer tests (TBI-027 DoD-0..1, PBI-034 AC-0, AC-2 / VT-12..VT-15).
 */
import { composePullRequestBody } from '../services/build/buildPullRequestBody';

describe('composePullRequestBody (TBI-027, PBI-034 AC-0, AC-2 / VT-12..VT-15)', () => {
  it('VT-12 PBI-034 AC-0 lists all risk decisions with rating and rationale, verified requirements with pass/deferred/retired, and support contacts using plain headings and lists (no tables)', () => {
    const composed = composePullRequestBody({
      buildId: 'run-123',
      briefTitle: 'Add Export CSV Action',
      revisionNumber: 2,
      requesterDisplayName: 'Dana Lee',
      acceptedAtIso: '2026-11-01T12:00:00.000Z',
      riskDecisions: [
        {
          id: 'RD-1',
          category: 'data',
          rating: 'low',
          decision: 'Stream rows in memory',
          rationale: 'Capped at 500 rows',
        },
        {
          id: 'RD-2',
          category: 'access',
          rating: 'medium',
          decision: 'Require builds:view',
          rationale: 'Project-scoped read',
        },
        {
          id: 'RD-3',
          category: 'destructive',
          rating: 'high',
          decision: 'Soft-delete exports',
          rationale: 'Reversible option selected',
        },
      ],
      requirements: [
        {
          id: 'AC-1',
          kind: 'ac',
          text: 'User can export CSV',
          retired: false,
          verificationStatus: 'pass',
        },
        {
          id: 'AC-2',
          kind: 'ac',
          text: 'Large export streams',
          retired: false,
          verificationStatus: 'deferred',
          deferralReason: 'Playwright env unavailable',
        },
        {
          id: 'AC-3',
          kind: 'ac',
          text: 'Old PDF button',
          retired: true,
          verificationStatus: 'retired',
        },
      ],
      supportContacts: [
        { userId: 'u1', displayName: 'Alice Reviewer', email: 'alice@example.com' },
      ],
      syncCommitSha: null,
    });

    expect(composed.title).toContain('Add Export CSV Action');
    expect(composed.description).toContain('RD-1 [low] Stream rows in memory — Capped at 500 rows');
    expect(composed.description).toContain('RD-2 [medium] Require builds:view — Project-scoped read');
    expect(composed.description).toContain('RD-3 [high] Soft-delete exports — Reversible option selected');
    expect(composed.description).toContain('AC-1: User can export CSV — pass');
    expect(composed.description).toContain('AC-2: Large export streams — deferred: Playwright env unavailable');
    expect(composed.description).toContain('AC-3: Old PDF button (retired)');
    expect(composed.description).toContain('Alice Reviewer');
    expect(composed.description).not.toContain('|---');
    expect(composed.overflowComment).toBeNull();
  });

  it('VT-13 TBI-027 / PBI-034 AC-0 redacts secrets before composing and never includes Blob storage links', () => {
    const composed = composePullRequestBody({
      buildId: 'run-123',
      briefTitle: 'Feature with Bearer secretBearerToken999',
      revisionNumber: 1,
      requesterDisplayName: 'Dana Lee',
      acceptedAtIso: '2026-11-01T12:00:00.000Z',
      riskDecisions: [
        {
          id: 'RD-1',
          category: 'integration',
          rating: 'low',
          decision: 'Connect to DB',
          rationale: 'Uses postgres://admin:secretPass123@db.internal:5432/app',
        },
      ],
      requirements: [
        {
          id: 'AC-1',
          kind: 'ac',
          text: 'Token Bearer secretBearerToken999',
          retired: false,
          verificationStatus: 'pass',
        },
      ],
      supportContacts: [{ userId: 'u1', displayName: 'Alice', email: 'alice@example.com' }],
      syncCommitSha: null,
    });

    expect(composed.title).not.toContain('secretBearerToken999');
    expect(composed.description).not.toContain('secretBearerToken999');
    expect(composed.description).not.toContain('secretPass123');
    expect(composed.description).toContain('/builds/run-123');
    expect(composed.description).not.toMatch(/blob\.core\.windows\.net/i);
  });

  it('VT-14 PBI-034 AC-0 fits 40 risk decisions with 300-char rationales within 4,000 characters while keeping every decision ID and rating, and populates overflowComment', () => {
    const fortyDecisions = Array.from({ length: 40 }, (_, i) => ({
      id: `RD-${i + 1}`,
      category: 'data' as const,
      rating: 'medium' as const,
      decision: `Decision summary number ${i + 1}`,
      rationale: 'R'.repeat(300),
    }));

    const composed = composePullRequestBody({
      buildId: 'run-123',
      briefTitle: 'Large Feature',
      revisionNumber: 1,
      requesterDisplayName: 'Dana Lee',
      acceptedAtIso: '2026-11-01T12:00:00.000Z',
      riskDecisions: fortyDecisions,
      requirements: Array.from({ length: 20 }, (_, i) => ({
        id: `AC-${i + 1}`,
        kind: 'ac' as const,
        text: 'Requirement description '.repeat(5),
        retired: false,
        verificationStatus: 'pass' as const,
      })),
      supportContacts: [{ userId: 'u1', displayName: 'Alice', email: 'alice@example.com' }],
      syncCommitSha: 'abcdef1234567890abcdef1234567890abcdef12',
    });

    expect(composed.description.length).toBeLessThanOrEqual(4000);
    for (let i = 1; i <= 40; i += 1) {
      expect(composed.description).toContain(`RD-${i} [medium]`);
    }
    expect(composed.overflowComment).not.toBeNull();
    expect(composed.overflowComment!.length).toBeGreaterThan(composed.description.length);
  });

  it('VT-15 PBI-034 AC-2 includes sync commit section only when syncCommitSha is present', () => {
    const withSync = composePullRequestBody({
      buildId: 'run-123',
      briefTitle: 'Synced Feature',
      revisionNumber: 2,
      requesterDisplayName: 'Dana Lee',
      acceptedAtIso: '2026-11-01T12:00:00.000Z',
      riskDecisions: [],
      requirements: [],
      supportContacts: [{ userId: 'u1', displayName: 'Alice', email: 'alice@example.com' }],
      syncCommitSha: '1234567890abcdef1234567890abcdef12345678',
    });

    expect(withSync.description).toContain('1234567');
    expect(withSync.description).toMatch(/sync commit was added after the accepted preview/i);
    expect(withSync.description).toMatch(/no new preview was made/i);

    const withoutSync = composePullRequestBody({
      buildId: 'run-123',
      briefTitle: 'Clean Feature',
      revisionNumber: 2,
      requesterDisplayName: 'Dana Lee',
      acceptedAtIso: '2026-11-01T12:00:00.000Z',
      riskDecisions: [],
      requirements: [],
      supportContacts: [{ userId: 'u1', displayName: 'Alice', email: 'alice@example.com' }],
      syncCommitSha: null,
    });

    expect(withoutSync.description).not.toMatch(/sync commit was added/i);
  });
});
