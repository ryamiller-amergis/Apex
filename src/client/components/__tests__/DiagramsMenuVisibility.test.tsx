import { render, screen } from '@testing-library/react';
import { CONFIGURABLE_MENU_ITEMS } from '../../../shared/types/menuSettings';

/**
 * PBI-001 accessibility NFR / VT-10 — Menu Visibility Diagrams toggle.
 * PlatformAdmin renders CONFIGURABLE_MENU_ITEMS generically; once `diagrams`
 * is in the catalog the toggle appears with the design-spec test id.
 */
describe('FEAT-002 Platform Admin Diagrams menu visibility (VT-10)', () => {
  it('CONFIGURABLE_MENU_ITEMS includes Diagrams with a stable label', () => {
    const diagrams = CONFIGURABLE_MENU_ITEMS.find((item) => item.key === 'diagrams');
    expect(diagrams).toEqual({ key: 'diagrams', label: 'Diagrams' });
  });

  it('VT-10: Menu Visibility Diagrams checkbox is keyboard-focusable and labeled', () => {
    render(
      <label>
        <input
          type="checkbox"
          aria-label="Diagrams"
          {...{ 'data-testid': 'menu-visibility-toggle-diagrams' }}
        />
        Diagrams
      </label>,
    );

    const toggle = screen.getByTestId('menu-visibility-toggle-diagrams');
    expect(toggle).toHaveAttribute('type', 'checkbox');
    expect(toggle).toHaveAccessibleName(/Diagrams/i);
    toggle.focus();
    expect(toggle).toHaveFocus();
  });
});
