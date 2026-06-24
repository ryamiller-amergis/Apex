/**
 * Unit tests for AnnotationLayer's pure anchoring helper `anchorSelector`.
 *
 * Issue #3: a resolved / non-unique selection (e.g. "External User" appearing
 * multiple times) must re-anchor to the originally selected span via
 * prefix+suffix context, NOT latch onto the first occurrence found by a bare
 * `containerText.indexOf(exact)`.
 */

import { anchorSelector } from '../AnnotationLayer';
import type { TextSelector } from '../../../shared/types/reviewComments';

describe('anchorSelector', () => {
  it('prefers prefix+suffix context over first-occurrence indexOf for a non-unique selection', () => {
    // Arrange: "External User" appears twice; the selection targets the SECOND.
    const containerText =
      'Section one describes the system admin role in detail. ' +
      'Section two describes the External User who can browse items. ' +
      'Section three notes that the External User receives notifications.';
    const exact = 'External User';
    const firstIdx = containerText.indexOf(exact);
    const secondIdx = containerText.lastIndexOf(exact);
    expect(secondIdx).toBeGreaterThan(firstIdx);

    const selector: TextSelector = {
      exact,
      prefix: containerText.slice(secondIdx - 30, secondIdx),
      suffix: containerText.slice(secondIdx + exact.length, secondIdx + exact.length + 30),
      // Stale hint (text shifted after an AI edit) so step 1 must fail.
      start: 9999,
      end: 9999 + exact.length,
    };

    // Act
    const result = anchorSelector(containerText, selector);

    // Assert: anchors to the originally selected (second) span, not the first.
    expect(result).toEqual({ start: secondIdx, end: secondIdx + exact.length });
  });

  it('anchors at the hinted offset when it still matches exactly', () => {
    const containerText = 'Alpha External User beta External User gamma';
    const exact = 'External User';
    const firstIdx = containerText.indexOf(exact);
    const selector: TextSelector = {
      exact,
      prefix: '',
      suffix: '',
      start: firstIdx,
      end: firstIdx + exact.length,
    };

    expect(anchorSelector(containerText, selector)).toEqual({
      start: firstIdx,
      end: firstIdx + exact.length,
    });
  });

  it('falls back to bare indexOf when there is no usable context', () => {
    const containerText = 'Lorem ipsum External User dolor sit amet.';
    const exact = 'External User';
    const idx = containerText.indexOf(exact);
    const selector: TextSelector = {
      exact,
      prefix: '',
      suffix: '',
      start: 9999,
      end: 9999 + exact.length,
    };

    expect(anchorSelector(containerText, selector)).toEqual({
      start: idx,
      end: idx + exact.length,
    });
  });

  it('returns null when the exact text is absent', () => {
    const selector: TextSelector = {
      exact: 'Nonexistent phrase',
      prefix: '',
      suffix: '',
      start: 0,
      end: 18,
    };
    expect(anchorSelector('Some unrelated content.', selector)).toBeNull();
  });
});
