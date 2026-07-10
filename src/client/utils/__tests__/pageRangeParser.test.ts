/**
 * Unit tests for pageRangeParser
 * Covers: PBI-010 AC-0, AC-1, AC-2, AC-3 (VT-05, VT-06, VT-07, VT-08, VT-13)
 */
import { parseRange, selectionToRangeString } from '../pageRangeParser';

describe('parseRange', () => {
  // VT-05 / AC-0: Valid range produces correct 0-based indices
  it('AC-0/VT-05: parses "1-5, 10, 20-25" on 50-page session', () => {
    const result = parseRange('1-5, 10, 20-25', 50);
    expect(result.error).toBeNull();
    expect(result.pages).toEqual([0, 1, 2, 3, 4, 9, 19, 20, 21, 22, 23, 24]);
    expect(result.hasDuplicates).toBe(false);
  });

  // VT-06 / AC-1: Out-of-bounds range returns error
  it('AC-1/VT-06: returns error for "1-999" on 50-page session', () => {
    const result = parseRange('1-999', 50);
    expect(result.error).toContain('1');
    expect(result.error).toContain('50');
    expect(result.pages).toEqual([]);
  });

  // VT-07 / AC-3: Reverse range returns validation error
  it('AC-3/VT-07: returns error for reverse range "5-2"', () => {
    const result = parseRange('5-2', 50);
    expect(result.error).toContain('start must be less than or equal to end');
    expect(result.pages).toEqual([]);
  });

  // VT-08 / AC-2: Duplicates are de-duplicated with flag
  it('AC-2/VT-08: deduplicates "1-5, 3-7" and sets hasDuplicates', () => {
    const result = parseRange('1-5, 3-7', 10);
    expect(result.error).toBeNull();
    expect(result.pages).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(result.hasDuplicates).toBe(true);
  });

  // VT-13 / AC-3: Invalid format "abc"
  it('AC-3/VT-13: returns error for non-numeric "abc"', () => {
    const result = parseRange('abc', 50);
    expect(result.error).toContain('Invalid format');
    expect(result.pages).toEqual([]);
  });

  it('AC-3: returns error for mixed invalid "1-3, xyz"', () => {
    const result = parseRange('1-3, xyz', 50);
    expect(result.error).toContain('Invalid format');
    expect(result.pages).toEqual([]);
  });

  it('returns empty pages for empty input', () => {
    const result = parseRange('', 50);
    expect(result.error).toBeNull();
    expect(result.pages).toEqual([]);
    expect(result.hasDuplicates).toBe(false);
  });

  it('returns empty pages for whitespace-only input', () => {
    const result = parseRange('   ', 50);
    expect(result.error).toBeNull();
    expect(result.pages).toEqual([]);
  });

  it('handles single page number', () => {
    const result = parseRange('5', 10);
    expect(result.error).toBeNull();
    expect(result.pages).toEqual([4]);
  });

  it('AC-1: rejects page number below 1', () => {
    const result = parseRange('0', 10);
    expect(result.error).toContain('1');
    expect(result.error).toContain('10');
  });

  it('AC-1: rejects single page exceeding max', () => {
    const result = parseRange('51', 50);
    expect(result.error).toContain('50');
  });

  it('handles spaces around ranges gracefully', () => {
    const result = parseRange(' 1 - 3 , 5 ', 10);
    expect(result.error).toBeNull();
    expect(result.pages).toEqual([0, 1, 2, 4]);
  });
});

describe('selectionToRangeString', () => {
  it('converts consecutive indices to range string', () => {
    expect(selectionToRangeString([0, 1, 2, 3, 4])).toBe('1-5');
  });

  it('converts non-consecutive indices to separate entries', () => {
    expect(selectionToRangeString([0, 2, 4])).toBe('1, 3, 5');
  });

  it('handles mixed consecutive and standalone', () => {
    expect(selectionToRangeString([0, 1, 2, 3, 4, 9, 19, 20, 21, 22, 23, 24])).toBe(
      '1-5, 10, 20-25',
    );
  });

  it('returns empty string for empty array', () => {
    expect(selectionToRangeString([])).toBe('');
  });

  it('handles single index', () => {
    expect(selectionToRangeString([7])).toBe('8');
  });

  it('handles unsorted input', () => {
    expect(selectionToRangeString([4, 2, 0, 1, 3])).toBe('1-5');
  });
});
