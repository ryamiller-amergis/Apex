import { render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom';
import { PreflightRefusalPanel } from '../PreflightRefusalPanel';
import { preflightRefusalFixture } from '../../../shared/fixtures/preflightRefusalFixture';
import { isPreflightRefusalResponse } from '../../../shared/types/buildPreflight';

describe('PreflightRefusalPanel', () => {
  it('PBI-005 AC-1 / AC-2 (VT-31): shows every refusal item, message and fixer as text in one alert that takes focus', () => {
    render(<PreflightRefusalPanel response={preflightRefusalFixture} />);

    const panel = screen.getByTestId('preflight-refusal-panel');
    expect(panel).toHaveAttribute('role', 'alert');
    expect(panel).toHaveFocus();
    expect(panel).toHaveTextContent(preflightRefusalFixture.summary);

    for (const refusal of preflightRefusalFixture.refusals) {
      const item = within(panel).getByTestId(`preflight-refusal-item-${refusal.code}`);
      expect(item).toHaveTextContent(`Missing: ${refusal.item}`);
      expect(item).toHaveTextContent(refusal.message);
      expect(item).toHaveTextContent(`Who can fix it: ${refusal.fixerLabel}`);
    }
  });

  it('PBI-005 AC-1: names the code map and the Project Admin', () => {
    render(<PreflightRefusalPanel response={preflightRefusalFixture} />);
    const item = screen.getByTestId('preflight-refusal-item-code_map_missing');
    expect(item).toHaveTextContent('Missing: code map');
    expect(item).toHaveTextContent(/Project Admin/);
  });

  it('renders nothing when there are no refusals', () => {
    const { container } = render(
      <PreflightRefusalPanel response={{ ...preflightRefusalFixture, refusals: [] }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  describe('VT-32 contract fixture', () => {
    it('VT-32: the shared type guard accepts the fixture', () => {
      expect(isPreflightRefusalResponse(preflightRefusalFixture)).toBe(true);
    });

    it('VT-32: the shared type guard rejects an unknown code', () => {
      const unknownCode = {
        ...preflightRefusalFixture,
        refusals: [{ ...preflightRefusalFixture.refusals[0], code: 'not_a_real_code' }],
      };
      expect(isPreflightRefusalResponse(unknownCode)).toBe(false);
    });

    it('VT-32: the panel renders the fixture', () => {
      render(<PreflightRefusalPanel response={preflightRefusalFixture} />);
      expect(screen.getAllByTestId(/^preflight-refusal-item-/)).toHaveLength(preflightRefusalFixture.refusals.length);
    });
  });
});
