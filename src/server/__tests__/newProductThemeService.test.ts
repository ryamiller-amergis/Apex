import {
  renderNewProductTheme,
  selectNewProductTheme,
} from '../services/newProductThemeService';

describe('new product theme selection', () => {
  it('selects a task-first theme for a to-do application', () => {
    const theme = selectNewProductTheme(
      'A simple to-do checklist where people create tasks and mark them complete.',
    );
    expect(theme.id).toBe('focus');
    expect(theme.name).toBe('Focus');
  });

  it('selects an analytics theme for a reporting application', () => {
    expect(
      selectNewProductTheme('A dashboard for finance metrics, reports, and cost trends').id,
    ).toBe('insight');
  });

  it('uses the neutral theme when scope has no strong match', () => {
    expect(selectNewProductTheme('A useful application for a specialist process').id).toBe(
      'calm',
    );
  });

  it('renders reusable tokens and tailoring guidance', () => {
    const rendered = renderNewProductTheme(selectNewProductTheme('task checklist'));
    expect(rendered).toContain('Suggested starting theme — Focus');
    expect(rendered).toContain('primary: #4F46E5');
    expect(rendered).toContain('Tailor the hierarchy and components');
  });
});
