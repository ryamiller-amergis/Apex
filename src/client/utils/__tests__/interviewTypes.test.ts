import {
  prdStatusLabel,
  prdBadgeClass,
  designDocStatusLabel,
  designDocBadgeClass,
} from '../../../shared/types/interview';

describe('prdStatusLabel', () => {
  it.each([
    ['generating', 'Generating'],
    ['draft', 'Draft'],
    ['pending_review', 'Pending Review'],
    ['approved', 'Approved'],
    ['revision_requested', 'Revision Requested'],
  ] as const)('returns "%s" → "%s"', (status, expected) => {
    expect(prdStatusLabel(status)).toBe(expected);
  });
});

describe('prdBadgeClass', () => {
  it.each([
    ['generating', 'generating'],
    ['draft', 'draft'],
    ['pending_review', 'pending-review'],
    ['approved', 'approved'],
    ['revision_requested', 'revision-requested'],
  ] as const)('returns "%s" → "%s"', (status, expected) => {
    expect(prdBadgeClass(status)).toBe(expected);
  });
});

describe('designDocStatusLabel', () => {
  it.each([
    ['generating', 'Generating'],
    ['validating', 'Validating'],
    ['draft', 'Draft'],
    ['pending_review', 'Pending Review'],
    ['approved', 'Approved'],
    ['revision_requested', 'Revision Requested'],
  ] as const)('returns "%s" → "%s"', (status, expected) => {
    expect(designDocStatusLabel(status)).toBe(expected);
  });
});

describe('designDocBadgeClass', () => {
  it.each([
    ['generating', 'generating'],
    ['validating', 'validating'],
    ['draft', 'draft'],
    ['pending_review', 'pending-review'],
    ['approved', 'approved'],
    ['revision_requested', 'revision-requested'],
  ] as const)('returns "%s" → "%s"', (status, expected) => {
    expect(designDocBadgeClass(status)).toBe(expected);
  });
});
