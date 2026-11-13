import {
  candidateShas,
  POST_RELEASE_MIN_DOCUMENTS,
  postReleaseStatus,
  summarizeArm,
  type LiveDocument,
} from '../services/skillPostRelease';
import { skillContentSha256 } from '../services/skillReplaySpec';

jest.mock('../db/drizzle', () => ({ db: {} }));
jest.mock('../services/notificationService', () => ({ createNotification: jest.fn() }));

function docs(count: number, score: number, status = 'approved'): LiveDocument[] {
  return Array.from({ length: count }, (_, i) => ({ sha: 'x', status, validationScore: score + (i % 2) }));
}

describe('skillPostRelease', () => {
  it('matches the candidate by both LF and CRLF hashes', () => {
    const shas = candidateShas('a\nb\n');
    expect(shas).toContain(skillContentSha256('a\nb\n'));
    expect(shas).toContain(skillContentSha256('a\r\nb\r\n'));
  });

  it('waits until a live document uses the new Skill', () => {
    expect(postReleaseStatus(summarizeArm(docs(20, 80)), summarizeArm([]))).toBe('waiting');
  });

  it('collects until both versions have enough documents', () => {
    expect(postReleaseStatus(summarizeArm(docs(20, 80)), summarizeArm(docs(POST_RELEASE_MIN_DOCUMENTS - 1, 80)))).toBe('collecting');
  });

  it('flags a clear drop in score', () => {
    expect(postReleaseStatus(summarizeArm(docs(20, 85)), summarizeArm(docs(20, 60)))).toBe('regressed');
  });

  it('flags a clear drop in acceptance', () => {
    expect(postReleaseStatus(summarizeArm(docs(30, 80)), summarizeArm(docs(30, 80, 'rejected')))).toBe('regressed');
  });

  it('holds when the versions overlap', () => {
    expect(postReleaseStatus(summarizeArm(docs(20, 80)), summarizeArm(docs(20, 80)))).toBe('holding');
  });
});
