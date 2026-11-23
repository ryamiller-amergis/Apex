import {
  HARNESS_AREA_IDS,
  HARNESS_COMPOSER_CAPABILITIES,
} from '../../../shared/types/chatHarness';

describe('HARNESS_COMPOSER_CAPABILITIES', () => {
  it('declares composer capabilities for every harness area', () => {
    expect(Object.keys(HARNESS_COMPOSER_CAPABILITIES).sort()).toEqual(
      [...HARNESS_AREA_IDS].sort(),
    );
  });

  it('shows the model picker on every area', () => {
    for (const area of HARNESS_AREA_IDS) {
      expect(HARNESS_COMPOSER_CAPABILITIES[area].modelPicker).toBe(true);
    }
  });

  it('keeps the per-area mode and linked-context controls where they belong', () => {
    expect(HARNESS_COMPOSER_CAPABILITIES.brainstorm.modeOptions).toBe('artifact-type');
    expect(HARNESS_COMPOSER_CAPABILITIES.interview.linkedContext).toBe('interview-references');
    expect(HARNESS_COMPOSER_CAPABILITIES['agent-home'].modeOptions).toBeNull();
    expect(HARNESS_COMPOSER_CAPABILITIES['agent-home'].linkedContext).toBeNull();
  });
});
