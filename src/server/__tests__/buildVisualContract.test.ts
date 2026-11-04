import { describe, expect, it } from '@jest/globals';
import { classifyBuildTaskDomain } from '../../shared/buildUiClassifier';
import { injectVisualRequirements } from '../../shared/buildVisualBrief';

describe('buildUiClassifier', () => {
  it('classifies calendar home page work as UI', () => {
    expect(
      classifyBuildTaskDomain('add a calendar on the home page', [
        { id: 'AC-1', kind: 'ac', text: 'Home renders a month calendar.', retired: false },
      ]),
    ).toBe('ui');
  });
});

describe('buildVisualBrief', () => {
  it('injects visual requirements when missing', () => {
    const next = injectVisualRequirements([
      { id: 'AC-1', kind: 'ac', text: 'Home renders.', retired: false },
      { id: 'NFR-1', kind: 'nfr', text: 'Uses tokens.', retired: false },
    ]);
    expect(next.some((row) => /enterprise-ready/i.test(row.text))).toBe(true);
    expect(next.some((row) => /Playwright visual snapshot/i.test(row.text))).toBe(true);
    expect(next.some((row) => /project-name/i.test(row.text))).toBe(true);
  });
});
