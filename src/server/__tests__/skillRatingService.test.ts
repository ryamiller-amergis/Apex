import {
  SkillRatingError,
  listMySkillRatings,
  parsePutSkillRating,
  putSkillRating,
} from '../services/skillRatingService';
import { db } from '../db/drizzle';
import { threadProvenance } from '../services/skillSignalService';

const mockTx = {
  delete: jest.fn(() => ({ where: jest.fn().mockResolvedValue(undefined) })),
  insert: jest.fn(() => ({ values: jest.fn().mockResolvedValue(undefined) })),
};

jest.mock('../db/drizzle', () => ({
  db: {
    delete: jest.fn(() => ({ where: jest.fn().mockResolvedValue(undefined) })),
    transaction: jest.fn(async (fn: (tx: unknown) => Promise<void>) => fn(mockTx)),
    select: jest.fn(),
  },
}));
jest.mock('../services/skillSignalService', () => ({ threadProvenance: jest.fn() }));

const THREAD = '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f';

describe('parsePutSkillRating', () => {
  const valid = { surface: 'brainstorm', subjectType: 'brainstorm_artifact_version', subjectId: 's1:3', rating: 'good' };

  it('accepts a rating without a comment when none is needed', () => {
    expect(parsePutSkillRating(valid)).toEqual({ ...valid, threadId: null, comment: null });
  });

  it('requires a comment for a poor rating', () => {
    expect(() => parsePutSkillRating({ ...valid, rating: 'bad' })).toThrow(SkillRatingError);
    expect(parsePutSkillRating({ ...valid, rating: 'bad', comment: ' Missed the goal ' }).comment).toBe('Missed the goal');
  });

  it.each([
    ['an unrated surface', { surface: 'home_chat' }],
    ['a bad thread id', { threadId: 'not-a-uuid' }],
    ['an unknown rating', { rating: 'great' }],
    ['a missing subject', { subjectId: '' }],
  ])('refuses %s', (_label, change) => {
    expect(() => parsePutSkillRating({ ...valid, ...change })).toThrow(SkillRatingError);
  });

  it('allows clearing with null', () => {
    expect(parsePutSkillRating({ ...valid, rating: null }).rating).toBeNull();
  });
});

describe('putSkillRating', () => {
  beforeEach(() => jest.clearAllMocks());

  it('replaces the earlier rating in one transaction and records thread provenance', async () => {
    jest.mocked(threadProvenance).mockResolvedValue({ skillPath: 'p', skillSha256: 'a'.repeat(64), model: 'm', effort: null });
    const values = jest.fn().mockResolvedValue(undefined);
    mockTx.insert.mockReturnValueOnce({ values });

    const entry = await putSkillRating('Apex', 'user-1', {
      surface: 'prd_assistant', subjectType: 'assistant_reply', subjectId: 'msg-1', threadId: THREAD, rating: 'bad', comment: 'Wrong section',
    });

    expect(entry).toEqual({ subjectId: 'msg-1', rating: 'bad', comment: 'Wrong section' });
    expect(mockTx.delete).toHaveBeenCalled();
    expect(values).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'rating', value: -1, skillSha256: 'a'.repeat(64), idempotencyKey: 'rating:Apex:prd_assistant:msg-1:user-1',
    }));
  });

  it('deletes the rating when cleared', async () => {
    await expect(putSkillRating('Apex', 'user-1', {
      surface: 'playbook', subjectType: 'playbook_run', subjectId: 'r1', threadId: null, rating: null, comment: null,
    })).resolves.toBeNull();
    expect(db.delete).toHaveBeenCalled();
    expect(db.transaction).not.toHaveBeenCalled();
  });
});

describe('listMySkillRatings', () => {
  it('maps stored values back to ratings', async () => {
    const where = jest.fn().mockResolvedValue([
      { subjectId: 'a', value: 1, comment: null },
      { subjectId: 'b', value: 0, comment: 'meh' },
    ]);
    jest.mocked(db.select).mockReturnValue({ from: () => ({ where }) } as never);
    await expect(listMySkillRatings('Apex', 'u', 'qa_lab', ['a', 'b'])).resolves.toEqual([
      { subjectId: 'a', rating: 'good', comment: null },
      { subjectId: 'b', rating: 'needs_improvement', comment: 'meh' },
    ]);
  });

  it('returns nothing without subjects', async () => {
    await expect(listMySkillRatings('Apex', 'u', 'qa_lab', [])).resolves.toEqual([]);
  });
});
