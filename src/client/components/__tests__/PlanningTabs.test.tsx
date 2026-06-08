import { render, screen, fireEvent } from '@testing-library/react';
import { PlanningTabs } from '../PlanningTabs';

const onNavigate = jest.fn();

beforeEach(() => onNavigate.mockReset());

// ── Full access (admin/member) ─────────────────────────────────────────────────

describe('PlanningTabs — user has all planning sub-tab permissions', () => {
  const can = (key: string) =>
    ['planning:devstats', 'planning:qa', 'planning:ai-analysis', 'planning:roadmap', 'planning:releases'].includes(key);

  it('renders all five tabs', () => {
    render(<PlanningTabs activeTab="dev-stats" can={can} onNavigate={onNavigate} />);
    expect(screen.getByRole('button', { name: 'Developer Stats' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'QA Metrics' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'AI Analysis' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Roadmap' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Releases' })).toBeInTheDocument();
  });

  it('marks the active tab with "active" class', () => {
    render(<PlanningTabs activeTab="roadmap" can={can} onNavigate={onNavigate} />);
    expect(screen.getByRole('button', { name: 'Roadmap' })).toHaveClass('active');
    expect(screen.getByRole('button', { name: 'Developer Stats' })).not.toHaveClass('active');
  });

  it('calls onNavigate with the correct tab id when clicked', () => {
    render(<PlanningTabs activeTab="dev-stats" can={can} onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('button', { name: 'QA Metrics' }));
    expect(onNavigate).toHaveBeenCalledWith('qa');
  });
});

// ── Viewer role — no sub-tab permissions ──────────────────────────────────────

describe('PlanningTabs — user has no sub-tab permissions (viewer)', () => {
  const can = (_key: string) => false;

  it('renders no tabs', () => {
    render(<PlanningTabs activeTab="dev-stats" can={can} onNavigate={onNavigate} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

// ── Partial access ────────────────────────────────────────────────────────────

describe('PlanningTabs — user has only roadmap and releases', () => {
  const can = (key: string) =>
    ['planning:roadmap', 'planning:releases'].includes(key);

  it('renders only Roadmap and Releases', () => {
    render(<PlanningTabs activeTab="roadmap" can={can} onNavigate={onNavigate} />);
    expect(screen.getByRole('button', { name: 'Roadmap' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Releases' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Developer Stats' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'QA Metrics' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'AI Analysis' })).not.toBeInTheDocument();
  });

  it('does not render a tab the user lacks permission for even if it is the activeTab', () => {
    render(<PlanningTabs activeTab="dev-stats" can={can} onNavigate={onNavigate} />);
    expect(screen.queryByRole('button', { name: 'Developer Stats' })).not.toBeInTheDocument();
  });
});

// ── Individual permission gates ───────────────────────────────────────────────

describe('PlanningTabs — individual permission gates', () => {
  const makeCanFor = (...keys: string[]) => (key: string) => keys.includes(key);

  it('shows Developer Stats only with planning:devstats', () => {
    render(<PlanningTabs activeTab="dev-stats" can={makeCanFor('planning:devstats')} onNavigate={onNavigate} />);
    expect(screen.getByRole('button', { name: 'Developer Stats' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'QA Metrics' })).not.toBeInTheDocument();
  });

  it('shows QA Metrics only with planning:qa', () => {
    render(<PlanningTabs activeTab="dev-stats" can={makeCanFor('planning:qa')} onNavigate={onNavigate} />);
    expect(screen.getByRole('button', { name: 'QA Metrics' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Developer Stats' })).not.toBeInTheDocument();
  });

  it('shows AI Analysis only with planning:ai-analysis', () => {
    render(<PlanningTabs activeTab="dev-stats" can={makeCanFor('planning:ai-analysis')} onNavigate={onNavigate} />);
    expect(screen.getByRole('button', { name: 'AI Analysis' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Roadmap' })).not.toBeInTheDocument();
  });

  it('shows Roadmap only with planning:roadmap', () => {
    render(<PlanningTabs activeTab="dev-stats" can={makeCanFor('planning:roadmap')} onNavigate={onNavigate} />);
    expect(screen.getByRole('button', { name: 'Roadmap' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Releases' })).not.toBeInTheDocument();
  });

  it('shows Releases only with planning:releases', () => {
    render(<PlanningTabs activeTab="dev-stats" can={makeCanFor('planning:releases')} onNavigate={onNavigate} />);
    expect(screen.getByRole('button', { name: 'Releases' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Roadmap' })).not.toBeInTheDocument();
  });
});
