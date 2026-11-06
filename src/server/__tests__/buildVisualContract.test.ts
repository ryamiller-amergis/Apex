import { describe, expect, it } from '@jest/globals';
import { classifyBuildTaskDomain } from '../../shared/buildUiClassifier';
import {
  buildVisualBrief,
  formatVisualBriefForPrompt,
  injectVisualRequirements,
  synthesizeExperienceConcept,
} from '../../shared/buildVisualBrief';
import type { DesignPreferenceProfile } from '../../shared/types/designPreferenceProfile';

const RESTAURANT_PROMPT =
  'I want to build a modern looking site that looks like an industry stnadard look and feel. and within tha tsite i was to create a shift tracking website that allows a user to keep track of their shift and look for new shifts tha are avaiable to get picked up. this is going to be used for resturaunts to help mange their working schedules so the manager could create shifts and the workers could pick them up when they want';

describe('buildUiClassifier', () => {
  it('classifies calendar home page work as UI', () => {
    expect(
      classifyBuildTaskDomain('add a calendar on the home page', [
        { id: 'AC-1', kind: 'ac', text: 'Home renders a month calendar.', retired: false },
      ]),
    ).toBe('ui');
  });

  it('classifies a full-stack website request with roles as mixed', () => {
    expect(classifyBuildTaskDomain(RESTAURANT_PROMPT, [])).toBe('mixed');
  });

  it('keeps pure backend work non-UI', () => {
    expect(
      classifyBuildTaskDomain('add a migration that indexes the orders table', []),
    ).toBe('non_ui');
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

  it('synthesizes a scheduling concept for the restaurant shift request', () => {
    const concept = synthesizeExperienceConcept(RESTAURANT_PROMPT);
    expect(concept.domain).toBe('restaurant shift scheduling');
    expect(concept.roles).toEqual(expect.arrayContaining(['manager', 'worker']));
    expect(concept.signatureInteraction).toMatch(/Pick up/);
  });

  it('writes the concept and self-review into the prompt section', () => {
    const brief = buildVisualBrief({
      buildRunId: 'run-1',
      taskDomain: 'mixed',
      prompt: RESTAURANT_PROMPT,
      profile: {
        appName: 'ATS',
        preferredPatterns: [],
        avoidedPatterns: [],
      } as unknown as DesignPreferenceProfile,
    });
    const section = formatVisualBriefForPrompt(brief);
    expect(section).toContain('## Experience Concept');
    expect(section).toContain('2–3 distinct layout concepts');
    expect(section).toContain('## Visual Self-Review');
  });
});
