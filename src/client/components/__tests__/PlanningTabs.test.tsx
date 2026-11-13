import { render, screen, fireEvent } from '@testing-library/react';
import { PlanningTabs } from '../PlanningTabs';

const onNavigate = jest.fn();

beforeEach(() => onNavigate.mockReset());

describe('PlanningTabs — user has all planning sub-tab permissions', () => {
  const can = (key: string) =>
    ['planning:roadmap', 'planning:releases', 'planning:qa'].includes(key);

  it('renders only Roadmap and Releases tabs (legacy Developer Stats, QA Metrics, AI Analysis removed)', () => {
    render(<PlanningTabs activeTab="roadmap" can={can} onNavigate={onNavigate} />);
    expect(screen.getByRole('button', { name: 'Roadmap' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Releases' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Developer Stats' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'QA Metrics' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'AI Analysis' })).not.toBeInTheDocument();
  });

  it('marks the active tab with "active" class', () => {
    render(<PlanningTabs activeTab="releases" can={can} onNavigate={onNavigate} />);
    expect(screen.getByRole('button', { name: 'Releases' })).toHaveClass('active');
    expect(screen.getByRole('button', { name: 'Roadmap' })).not.toHaveClass('active');
  });

  it('calls onNavigate with the correct tab id when clicked', () => {
    render(<PlanningTabs activeTab="roadmap" can={can} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Releases' }));
    expect(onNavigate).toHaveBeenCalledWith('releases');
  });
});

describe('PlanningTabs — user has no sub-tab permissions (viewer)', () => {
  const can = (_key: string) => false;

  it('renders no tabs', () => {
    render(<PlanningTabs activeTab="roadmap" can={can} onNavigate={onNavigate} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('PlanningTabs — individual permission gates', () => {
  const makeCanFor = (...keys: string[]) => (key: string) => keys.includes(key);

  it('shows Roadmap only with planning:roadmap', () => {
    render(<PlanningTabs activeTab="roadmap" can={makeCanFor('planning:roadmap')} onNavigate={onNavigate} />);
    expect(screen.getByRole('button', { name: 'Roadmap' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Releases' })).not.toBeInTheDocument();
  });

  it('shows Releases only with planning:releases', () => {
    render(<PlanningTabs activeTab="releases" can={makeCanFor('planning:releases')} onNavigate={onNavigate} />);
    expect(screen.getByRole('button', { name: 'Releases' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Roadmap' })).not.toBeInTheDocument();
  });

  it('does not render any Planning sub-tab when user only holds planning:qa (used by QA Lab)', () => {
    render(<PlanningTabs activeTab="roadmap" can={makeCanFor('planning:qa')} onNavigate={onNavigate} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
