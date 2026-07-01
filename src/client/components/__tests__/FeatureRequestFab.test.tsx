import { render, screen, fireEvent } from '@testing-library/react';
import { FeatureRequestFab } from '../FeatureRequestFab';

jest.mock('../AskApexChat', () => ({
  AskApexChat: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="ask-apex-chat">
      <button type="button" onClick={onClose}>Close chat</button>
    </div>
  ),
}));

describe('FeatureRequestFab', () => {
  const onRequestFeature = jest.fn();

  beforeEach(() => {
    onRequestFeature.mockReset();
  });

  it('opens the menu when the FAB is clicked', () => {
    render(<FeatureRequestFab onRequestFeature={onRequestFeature} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Apex menu' }));
    expect(screen.getByRole('menuitem', { name: /Request New Apex Feature/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /Ask Apex/i })).toBeInTheDocument();
  });

  it('calls onRequestFeature when Request New Apex Feature is clicked', () => {
    render(<FeatureRequestFab onRequestFeature={onRequestFeature} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Apex menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Request New Apex Feature/i }));
    expect(onRequestFeature).toHaveBeenCalledTimes(1);
  });

  it('opens Ask Apex chat when Ask Apex is clicked', () => {
    render(<FeatureRequestFab onRequestFeature={onRequestFeature} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Apex menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Ask Apex/i }));
    expect(screen.getByTestId('ask-apex-chat')).toBeInTheDocument();
  });

  it('closes the menu on Escape', () => {
    render(<FeatureRequestFab onRequestFeature={onRequestFeature} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open Apex menu' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menuitem', { name: /Ask Apex/i })).not.toBeInTheDocument();
  });
});
