/**
 * Unit tests for diff utilities.
 *
 * Coverage:
 *  1. normalizeLine — trims and collapses whitespace
 *  2. computeWordLevelDiff — LCS-based word diff returning WordSpan[]
 *  3. computeUnifiedDiff — line-level unified diff returning DiffLine[]
 *  4. annotateAdjacentPairs — adjacent removed+added pairs get word-level spans
 */

import {
  normalizeLine,
  computeWordLevelDiff,
  computeUnifiedDiff,
  annotateAdjacentPairs,
} from '../diff';
import type { WordSpan, DiffLine } from '../diff';

// ── normalizeLine ──────────────────────────────────────────────────────────────

describe('normalizeLine', () => {
  it('trims leading and trailing whitespace', () => {
    expect(normalizeLine('  hello  ')).toBe('hello');
  });

  it('collapses internal runs of whitespace into a single space', () => {
    expect(normalizeLine('foo   bar\tbaz')).toBe('foo bar baz');
  });

  it('returns empty string for an all-whitespace line', () => {
    expect(normalizeLine('   ')).toBe('');
  });

  it('leaves a clean line unchanged', () => {
    expect(normalizeLine('clean line')).toBe('clean line');
  });
});

// ── computeWordLevelDiff ───────────────────────────────────────────────────────

describe('computeWordLevelDiff', () => {
  it('returns only unchanged spans when texts are identical', () => {
    const spans = computeWordLevelDiff('hello world', 'hello world');
    expect(spans.every((s) => s.type === 'unchanged')).toBe(true);
  });

  it('marks added tokens when text is inserted', () => {
    const spans = computeWordLevelDiff('hello', 'hello world');
    const types = spans.map((s) => s.type);
    expect(types).toContain('added');
    expect(types).not.toContain('removed');
  });

  it('marks removed tokens when text is deleted', () => {
    const spans = computeWordLevelDiff('hello world', 'hello');
    const types = spans.map((s) => s.type);
    expect(types).toContain('removed');
    expect(types).not.toContain('added');
  });

  it('reconstructs the old text from unchanged + removed spans', () => {
    const spans = computeWordLevelDiff('foo bar baz', 'foo qux baz');
    const oldText = spans
      .filter((s) => s.type !== 'added')
      .map((s) => s.text)
      .join('');
    expect(oldText.replace(/\s+/g, ' ').trim()).toBe('foo bar baz');
  });

  it('reconstructs the new text from unchanged + added spans', () => {
    const spans = computeWordLevelDiff('foo bar baz', 'foo qux baz');
    const newText = spans
      .filter((s) => s.type !== 'removed')
      .map((s) => s.text)
      .join('');
    expect(newText.replace(/\s+/g, ' ').trim()).toBe('foo qux baz');
  });

  it('treats whitespace-only differences as unchanged', () => {
    const spans = computeWordLevelDiff('foo  bar', 'foo bar');
    expect(spans.every((s) => s.type === 'unchanged')).toBe(true);
  });
});

// ── computeUnifiedDiff ────────────────────────────────────────────────────────

describe('computeUnifiedDiff', () => {
  it('returns empty array when texts are identical', () => {
    expect(computeUnifiedDiff('same\ntext', 'same\ntext')).toHaveLength(0);
  });

  it('returns DiffLine[] with added lines when lines are inserted', () => {
    const lines = computeUnifiedDiff('line1', 'line1\nline2');
    expect(lines.some((l) => l.type === 'added')).toBe(true);
  });

  it('returns DiffLine[] with removed lines when lines are deleted', () => {
    const lines = computeUnifiedDiff('line1\nline2', 'line1');
    expect(lines.some((l) => l.type === 'removed')).toBe(true);
  });

  it('includes context lines near changes', () => {
    const old = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n');
    const updated = old.replace('line5', 'CHANGED');
    const lines = computeUnifiedDiff(old, updated);
    expect(lines.some((l) => l.type === 'context')).toBe(true);
  });

  it('line objects have the expected shape', () => {
    const lines = computeUnifiedDiff('old', 'new');
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(['added', 'removed', 'context']).toContain(l.type);
      expect(typeof l.text).toBe('string');
    }
  });
});

// ── annotateAdjacentPairs ─────────────────────────────────────────────────────

describe('annotateAdjacentPairs', () => {
  it('does not modify lines when there are no adjacent pairs', () => {
    const lines: DiffLine[] = [
      { type: 'context', lineNum: 1, text: 'ctx' },
      { type: 'added', lineNum: 2, text: 'new' },
    ];
    const result = annotateAdjacentPairs(lines);
    expect(result).toHaveLength(2);
    expect(result[1].spans).toBeUndefined();
  });

  it('annotates adjacent removed+added pairs with word spans', () => {
    const lines: DiffLine[] = [
      { type: 'removed', lineNum: 1, text: 'foo bar' },
      { type: 'added', lineNum: 1, text: 'foo baz' },
    ];
    const result = annotateAdjacentPairs(lines);
    expect(result).toHaveLength(2);
    expect(result[0].spans).toBeDefined();
    expect(result[1].spans).toBeDefined();
  });

  it('removed line spans contain only unchanged and removed types', () => {
    const lines: DiffLine[] = [
      { type: 'removed', lineNum: 1, text: 'foo bar' },
      { type: 'added', lineNum: 1, text: 'foo baz' },
    ];
    const result = annotateAdjacentPairs(lines);
    const removedSpans = result[0].spans as WordSpan[];
    expect(removedSpans.every((s) => s.type !== 'added')).toBe(true);
  });

  it('added line spans contain only unchanged and added types', () => {
    const lines: DiffLine[] = [
      { type: 'removed', lineNum: 1, text: 'foo bar' },
      { type: 'added', lineNum: 1, text: 'foo baz' },
    ];
    const result = annotateAdjacentPairs(lines);
    const addedSpans = result[1].spans as WordSpan[];
    expect(addedSpans.every((s) => s.type !== 'removed')).toBe(true);
  });

  it('passes through unpaired removed lines without spans', () => {
    const lines: DiffLine[] = [
      { type: 'removed', lineNum: 1, text: 'only removed' },
    ];
    const result = annotateAdjacentPairs(lines);
    expect(result[0].spans).toBeUndefined();
  });
});
