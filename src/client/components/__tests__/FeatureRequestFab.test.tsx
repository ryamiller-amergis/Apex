import { render, screen, fireEvent } from '@testing-library/react';
import { FeatureRequestFab } from '../FeatureRequestFab';

jest.mock('../AskApexChat', () => ({
  AskApexChat: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="ask-apex-chat">
      <button type="button" onClick={onClose}>Close chat</button>
    </div>
  ),
}));

jest.mock('../BrandLogo', () => ({
  BrandLogo: () => <span data-testid="apex-brand-mark" />,
}));

describe('FeatureRequestFab', () => {
  const onRequestFeature = jest.fn();

  beforeEach(() => {
    onRequestFeature.mockReset();
    localStorage.clear();
    Object.defineProperty(window, 'innerWidth', { value: 1200, writable: true });
    Object.defineProperty(window, 'innerHeight', { value: 800, writable: true });
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

  it('renders the Apex brand mark on the FAB', () => {
    render(<FeatureRequestFab onRequestFeature={onRequestFeature} />);
    expect(screen.getByTestId('apex-brand-mark')).toBeInTheDocument();
  });

  it('opens the menu on click but not after a drag gesture', () => {
    render(<FeatureRequestFab onRequestFeature={onRequestFeature} />);
    const fab = screen.getByRole('button', { name: 'Open Apex menu' });

    fireEvent.pointerDown(fab, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(fab, { clientX: 140, clientY: 140, pointerId: 1 });
    fireEvent.pointerUp(fab, { clientX: 140, clientY: 140, pointerId: 1 });

    expect(screen.queryByRole('menuitem', { name: /Ask Apex/i })).not.toBeInTheDocument();

    fireEvent.click(fab);
    expect(screen.getByRole('menuitem', { name: /Ask Apex/i })).toBeInTheDocument();
  });

  it('preserves its viewport-edge offset while the window resizes', () => {
    render(<FeatureRequestFab onRequestFeature={onRequestFeature} />);
    const fabContainer = screen.getByRole('button', { name: 'Open Apex menu' }).parentElement!;

    expect(fabContainer).toHaveStyle({ left: '1128px', top: '728px' });

    window.innerWidth = 900;
    window.innerHeight = 600;
    fireEvent(window, new Event('resize'));
    expect(fabContainer).toHaveStyle({ left: '828px', top: '528px' });

    window.innerWidth = 1200;
    window.innerHeight = 800;
    fireEvent(window, new Event('resize'));
    expect(fabContainer).toHaveStyle({ left: '1128px', top: '728px' });
  });
});
