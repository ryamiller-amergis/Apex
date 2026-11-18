import { reviewDecisionSignal } from '../services/reviewDecisionSignals';
import { db } from '../db/drizzle';

jest.mock('../db/drizzle', () => ({
  db: {
    query: {
      prds: { findFirst: jest.fn() },
      designDocs: { findFirst: jest.fn() },
      adrs: { findFirst: jest.fn() },
    },
  },
}));
jest.mock('../services/skillSignalService', () => ({ emitSkillSignalLater: jest.fn() }));

const query = db.query as unknown as Record<'prds' | 'designDocs' | 'adrs', { findFirst: jest.Mock }>;
const base = { documentId: 'doc-1', actorId: 'user-1', respondedAt: '2026-11-09T10:00:00.000Z' };

describe('reviewDecisionSignal', () => {
  beforeEach(() => jest.clearAllMocks());

  it('records a revision request on a PRD as a rejection with its Skill version, one per round', async () => {
    query.prds.findFirst.mockResolvedValue({ project: 'Apex', chatThreadId: 'thread-1', skillSha256: 'abc' });

    const signal = await reviewDecisionSignal({ ...base, documentType: 'prd', role: 'approver', status: 'revision_requested', comment: 'Missing NFRs' });

    expect(signal).toEqual(expect.objectContaining({
      project: 'Apex',
      surface: 'prd',
      kind: 'rejected',
      threadId: 'thread-1',
      comment: 'Missing NFRs',
      metadata: { source: 'review', role: 'approver' },
      provenance: { skillSha256: 'abc' },
      idempotencyKey: 'review:approver:prd:doc-1:user-1:2026-11-09T10:00:00.000Z',
    }));
  });

  it('records test case approvals against the PRD project on the test case surface', async () => {
    query.prds.findFirst.mockResolvedValue({ project: 'Apex', chatThreadId: 'thread-1', skillSha256: 'abc' });
    const signal = await reviewDecisionSignal({ ...base, documentType: 'test_case', role: 'owner', status: 'approved' });
    expect(signal).toEqual(expect.objectContaining({ surface: 'test_cases', kind: 'accepted', threadId: null, provenance: undefined }));
  });

  it('uses the ADR generation thread', async () => {
    query.adrs.findFirst.mockResolvedValue({ project: 'Apex', generationThreadId: 'gen-1' });
    const signal = await reviewDecisionSignal({ ...base, documentType: 'adr', role: 'owner', status: 'approved' });
    expect(signal).toEqual(expect.objectContaining({ surface: 'adr', threadId: 'gen-1' }));
  });

  it('skips prototypes and missing documents', async () => {
    await expect(reviewDecisionSignal({ ...base, documentType: 'design_prototype', role: 'owner', status: 'approved' })).resolves.toBeNull();
    query.designDocs.findFirst.mockResolvedValue(undefined);
    await expect(reviewDecisionSignal({ ...base, documentType: 'design_doc', role: 'owner', status: 'approved' })).resolves.toBeNull();
  });
});
