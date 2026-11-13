jest.mock('../db/drizzle', () => ({ db: {} }));

import {
  MessageRatingSummaryRequestError,
  messageExcerpt,
  parseSummaryDays,
} from '../services/workflowMessageFeedbackAdminService';

describe('parseSummaryDays', () => {
  it('defaults to 30 when missing or empty', () => {
    expect(parseSummaryDays(undefined)).toBe(30);
    expect(parseSummaryDays('')).toBe(30);
  });

  it.each(['7', '30', '90'])('accepts %s', (value) => {
    expect(parseSummaryDays(value)).toBe(Number(value));
  });

  it.each(['14', 'abc', '0', ['7', '30']])('rejects %j', (value) => {
    expect(() => parseSummaryDays(value)).toThrow(MessageRatingSummaryRequestError);
  });
});

describe('messageExcerpt', () => {
  it('drops interview phase markers and collapses whitespace', () => {
    expect(messageExcerpt('[[interview-phase:discovery:started]]\n\nWho   uses\tthis?')).toBe('Who uses this?');
  });

  it('cuts long text to 160 characters with an ellipsis', () => {
    const excerpt = messageExcerpt('a'.repeat(400));
    expect(excerpt).toHaveLength(160);
    expect(excerpt.endsWith('…')).toBe(true);
  });

  it('leaves short text alone', () => {
    expect(messageExcerpt('Short question?')).toBe('Short question?');
  });
});
