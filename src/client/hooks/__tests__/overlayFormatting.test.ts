import {
  OVERLAY_FONT_FAMILIES,
  OVERLAY_FONT_LABELS,
  OVERLAY_FONT_STACKS,
} from '../overlayFormatting';

describe('overlay font formatting catalog', () => {
  it('exposes all nine families with a CSS stack and label each', () => {
    expect(OVERLAY_FONT_FAMILIES).toHaveLength(9);
    for (const family of OVERLAY_FONT_FAMILIES) {
      expect(OVERLAY_FONT_STACKS[family]).toBeTruthy();
      expect(OVERLAY_FONT_LABELS[family]).toBeTruthy();
    }
  });

  it('maps the legacy Times-Roman family to a serif stack and readable label', () => {
    expect(OVERLAY_FONT_STACKS['Times-Roman']).toContain('serif');
    expect(OVERLAY_FONT_LABELS['Times-Roman']).toBe('Times New Roman');
  });

  it('maps Roboto to its own CSS family', () => {
    expect(OVERLAY_FONT_STACKS['Roboto']).toContain('Roboto');
  });

  it('includes Montserrat and Noto Sans in the label map', () => {
    expect(OVERLAY_FONT_LABELS['Montserrat']).toBe('Montserrat');
    expect(OVERLAY_FONT_LABELS['Noto Sans']).toBe('Noto Sans');
  });
});
