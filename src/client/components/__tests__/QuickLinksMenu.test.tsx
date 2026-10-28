import { fireEvent, render, screen } from '@testing-library/react';
import type { ProjectQuickLink } from '../../../shared/types/projectQuickLinks';
import { QuickLinksMenu } from '../QuickLinksMenu';
import { useProjectQuickLinks } from '../../hooks/useProjectQuickLinks';

const mockNavigate = jest.fn();

jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

jest.mock('../../hooks/useProjectQuickLinks', () => ({
  useProjectQuickLinks: jest.fn(),
}));

const mockUseProjectQuickLinks = useProjectQuickLinks as jest.Mock;

function makeLink(id: string, label: string, category: string | null): ProjectQuickLink {
  return {
    id,
    project: 'MaxView',
    label,
    url: `https://${id}.example.com/`,
    category,
    sortOrder: 0,
    createdBy: null,
    updatedBy: null,
    createdAt: '2026-10-28T19:00:00.000Z',
    updatedAt: '2026-10-28T19:00:00.000Z',
  };
}

const maxViewLinks = [
  makeLink('prod', 'MaxView Prod', 'Environments'),
  makeLink('test', 'MaxView Test', 'Environments'),
  makeLink('clerk', 'Clerk', 'Tools'),
];

beforeEach(() => {
  jest.clearAllMocks();
  mockUseProjectQuickLinks.mockReturnValue({ data: maxViewLinks });
});

function openMenu() {
  fireEvent.click(screen.getByTestId('quick-links-menu-trigger'));
}

describe('QuickLinksMenu', () => {
  it('renders nothing without a selected project', () => {
    const { container } = render(<QuickLinksMenu project={undefined} />);
    expect(container).toBeEmptyDOMElement();
    expect(mockUseProjectQuickLinks).not.toHaveBeenCalled();
  });

  it('renders nothing when project chrome is hidden', () => {
    const { container } = render(<QuickLinksMenu project="MaxView" hidden />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the project has no links', () => {
    mockUseProjectQuickLinks.mockReturnValue({ data: [] });
    const { container } = render(<QuickLinksMenu project="Amego" />);
    expect(container).toBeEmptyDOMElement();
    expect(mockUseProjectQuickLinks).toHaveBeenCalledWith('Amego');
  });

  it('requests links for the selected project only', () => {
    render(<QuickLinksMenu project="MaxView" />);
    expect(mockUseProjectQuickLinks).toHaveBeenCalledWith('MaxView');
  });

  it('opens a menu grouped by category with links that open in a new tab', () => {
    render(<QuickLinksMenu project="MaxView" />);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    openMenu();

    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Environments' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Tools' })).toBeInTheDocument();

    const prod = screen.getByTestId('quick-links-menu-item-prod');
    expect(prod).toHaveAttribute('href', 'https://prod.example.com/');
    expect(prod).toHaveAttribute('target', '_blank');
    expect(prod).toHaveAttribute('rel', 'noopener noreferrer');
    expect(prod).toHaveFocus();
  });

  it('closes on Escape and returns focus to the trigger', () => {
    render(<QuickLinksMenu project="MaxView" />);
    openMenu();

    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.getByTestId('quick-links-menu-trigger')).toHaveFocus();
  });

  it('closes on an outside click', () => {
    render(
      <div>
        <button type="button">outside</button>
        <QuickLinksMenu project="MaxView" />
      </div>,
    );
    openMenu();

    fireEvent.mouseDown(screen.getByRole('button', { name: 'outside' }));

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('moves focus with the arrow keys', () => {
    render(<QuickLinksMenu project="MaxView" />);
    openMenu();
    const menu = screen.getByRole('menu');

    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(screen.getByTestId('quick-links-menu-item-test')).toHaveFocus();

    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(screen.getByTestId('quick-links-menu-item-clerk')).toHaveFocus();
  });

  it('hides Manage links for users who cannot manage', () => {
    render(<QuickLinksMenu project="MaxView" />);
    openMenu();
    expect(screen.queryByTestId('quick-links-menu-manage')).not.toBeInTheDocument();
  });

  it('shows Manage links for managers and navigates to the settings section', () => {
    render(<QuickLinksMenu project="MaxView" canManage />);
    openMenu();

    fireEvent.click(screen.getByTestId('quick-links-menu-manage'));

    expect(mockNavigate).toHaveBeenCalledWith('/admin/project-settings#quick-links');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});
