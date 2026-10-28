import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ProjectQuickLink, UserQuickLink } from '../../../shared/types/projectQuickLinks';
import { QuickLinksMenu, describeImportResult } from '../QuickLinksMenu';
import { useMyQuickLinks, useProjectQuickLinks } from '../../hooks/useProjectQuickLinks';

const mockNavigate = jest.fn();

jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

const createMutate = jest.fn();
const updateMutate = jest.fn();
const deleteMutate = jest.fn();

function mutation(mutate: jest.Mock) {
  return { mutate, reset: jest.fn(), isPending: false, error: null };
}

jest.mock('../../hooks/useProjectQuickLinks', () => ({
  useProjectQuickLinks: jest.fn(),
  useMyQuickLinks: jest.fn(),
  useCreateMyQuickLink: () => mutation(createMutate),
  useUpdateMyQuickLink: () => mutation(updateMutate),
  useDeleteMyQuickLink: () => mutation(deleteMutate),
}));

jest.mock('../BookmarkImportModal', () => ({
  BookmarkImportModal: ({ onImported }: { onImported: (r: unknown) => void }) => (
    <div data-testid="bookmark-import-stub">
      <button
        type="button"
        data-testid="bookmark-import-stub-finish"
        onClick={() => onImported({ created: 3, skippedDuplicates: 2, rejected: [{ index: 0, label: '', url: '', reason: 'x' }] })}
      >
        finish
      </button>
    </div>
  ),
}));

const mockUseProjectQuickLinks = useProjectQuickLinks as jest.Mock;
const mockUseMyQuickLinks = useMyQuickLinks as jest.Mock;

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

function makeMyLink(id: string, label: string, category: string | null): UserQuickLink {
  return {
    id,
    project: 'MaxView',
    label,
    url: `https://${id}.example.com/`,
    category,
    sortOrder: 0,
    createdAt: '2026-10-28T19:00:00.000Z',
    updatedAt: '2026-10-28T19:00:00.000Z',
  };
}

const maxViewLinks = [
  makeLink('prod', 'MaxView Prod', 'Environments'),
  makeLink('test', 'MaxView Test', 'Environments'),
  makeLink('clerk', 'Clerk', 'Tools'),
];

const myLinks = [
  makeMyLink('jira', 'My Jira board', 'Work'),
  makeMyLink('notes', 'My notes', null),
];

beforeEach(() => {
  jest.clearAllMocks();
  mockUseProjectQuickLinks.mockReturnValue({ data: maxViewLinks });
  mockUseMyQuickLinks.mockReturnValue({ data: [] });
});

function openMenu() {
  fireEvent.click(screen.getByTestId('quick-links-menu-trigger'));
}

describe('QuickLinksMenu — visibility', () => {
  it('renders nothing without a selected project', () => {
    const { container } = render(<QuickLinksMenu project={undefined} canAddPersonal />);
    expect(container).toBeEmptyDOMElement();
    expect(mockUseProjectQuickLinks).not.toHaveBeenCalled();
  });

  it('renders nothing when project chrome is hidden', () => {
    const { container } = render(<QuickLinksMenu project="MaxView" hidden canAddPersonal />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing with no links and no quick-links:personal', () => {
    mockUseProjectQuickLinks.mockReturnValue({ data: [] });
    const { container } = render(<QuickLinksMenu project="Amego" />);
    expect(container).toBeEmptyDOMElement();
    expect(mockUseMyQuickLinks).toHaveBeenCalledWith('Amego', false);
  });

  it('shows the button with zero links when the user can add personal links', () => {
    mockUseProjectQuickLinks.mockReturnValue({ data: [] });
    render(<QuickLinksMenu project="Amego" canAddPersonal />);
    openMenu();
    expect(screen.getByTestId('quick-links-menu-add')).toHaveFocus();
    expect(screen.getByTestId('quick-links-menu-import')).toBeInTheDocument();
  });

  it('requests links for the selected project only', () => {
    render(<QuickLinksMenu project="MaxView" canAddPersonal />);
    expect(mockUseProjectQuickLinks).toHaveBeenCalledWith('MaxView');
    expect(mockUseMyQuickLinks).toHaveBeenCalledWith('MaxView', true);
  });
});

describe('QuickLinksMenu — project links', () => {
  it('opens a menu grouped by category with links that open in a new tab', () => {
    render(<QuickLinksMenu project="MaxView" />);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    openMenu();

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

  it('hides Manage links, Add link and Import for users without the permissions', () => {
    render(<QuickLinksMenu project="MaxView" />);
    openMenu();
    expect(screen.queryByTestId('quick-links-menu-manage')).not.toBeInTheDocument();
    expect(screen.queryByTestId('quick-links-menu-add')).not.toBeInTheDocument();
    expect(screen.queryByTestId('quick-links-menu-import')).not.toBeInTheDocument();
  });

  it('shows Manage links for managers and navigates to the settings section', () => {
    render(<QuickLinksMenu project="MaxView" canManage />);
    openMenu();

    fireEvent.click(screen.getByTestId('quick-links-menu-manage'));

    expect(mockNavigate).toHaveBeenCalledWith('/admin/project-settings#quick-links');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
});

describe('QuickLinksMenu — my links', () => {
  beforeEach(() => {
    mockUseMyQuickLinks.mockReturnValue({ data: myLinks });
  });

  it('lists personal links after project links, grouped by category', () => {
    render(<QuickLinksMenu project="MaxView" canAddPersonal />);
    openMenu();

    const mine = screen.getByTestId('quick-links-menu-mine');
    expect(within(mine).getByRole('group', { name: 'Work' })).toBeInTheDocument();
    const jira = screen.getByTestId('quick-links-menu-my-item-jira');
    expect(jira).toHaveAttribute('target', '_blank');
    expect(jira).toHaveAttribute('rel', 'noopener noreferrer');

    const items = screen.getAllByRole('menuitem').map((el) => el.getAttribute('data-testid'));
    expect(items.indexOf('quick-links-menu-item-clerk')).toBeLessThan(items.indexOf('quick-links-menu-my-item-jira'));
    expect(items.indexOf('quick-links-menu-my-item-notes')).toBeLessThan(items.indexOf('quick-links-menu-add'));
  });

  it('adds a personal link through the modal', async () => {
    render(<QuickLinksMenu project="MaxView" canAddPersonal />);
    openMenu();
    fireEvent.click(screen.getByTestId('quick-links-menu-add'));

    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId('personal-quick-link-label'), { target: { value: 'Grafana' } });
    fireEvent.change(screen.getByTestId('personal-quick-link-url'), { target: { value: 'https://grafana.example.com' } });
    fireEvent.click(screen.getByTestId('personal-quick-link-save'));

    await waitFor(() =>
      expect(createMutate).toHaveBeenCalledWith(
        { label: 'Grafana', url: 'https://grafana.example.com', category: null },
        expect.any(Object),
      ),
    );
  });

  it('rejects a javascript: URL in the modal', async () => {
    render(<QuickLinksMenu project="MaxView" canAddPersonal />);
    openMenu();
    fireEvent.click(screen.getByTestId('quick-links-menu-add'));
    fireEvent.change(screen.getByTestId('personal-quick-link-label'), { target: { value: 'Bad' } });
    fireEvent.change(screen.getByTestId('personal-quick-link-url'), { target: { value: 'javascript:alert(1)' } });
    fireEvent.click(screen.getByTestId('personal-quick-link-save'));

    expect(await screen.findByText('Enter a full URL starting with http:// or https://')).toBeInTheDocument();
    expect(createMutate).not.toHaveBeenCalled();
  });

  it('edits a personal link with its current values', async () => {
    render(<QuickLinksMenu project="MaxView" canAddPersonal />);
    openMenu();
    fireEvent.click(screen.getByTestId('quick-links-menu-my-edit-jira'));

    const label = screen.getByTestId('personal-quick-link-label');
    expect(label).toHaveValue('My Jira board');
    expect(screen.getByTestId('personal-quick-link-category')).toHaveValue('Work');
    fireEvent.change(label, { target: { value: 'Team board' } });
    fireEvent.click(screen.getByTestId('personal-quick-link-save'));

    await waitFor(() =>
      expect(updateMutate).toHaveBeenCalledWith(
        { id: 'jira', input: { label: 'Team board', url: 'https://jira.example.com/', category: 'Work' } },
        expect.any(Object),
      ),
    );
  });

  it('confirms before deleting a personal link', () => {
    render(<QuickLinksMenu project="MaxView" canAddPersonal />);
    openMenu();
    fireEvent.click(screen.getByTestId('quick-links-menu-my-delete-notes'));
    expect(deleteMutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('confirm-delete-confirm-btn'));

    expect(deleteMutate).toHaveBeenCalledWith({ id: 'notes' }, expect.any(Object));
  });

  it('shows the import result as a toast', () => {
    render(<QuickLinksMenu project="MaxView" canAddPersonal />);
    openMenu();
    fireEvent.click(screen.getByTestId('quick-links-menu-import'));
    fireEvent.click(screen.getByTestId('bookmark-import-stub-finish'));

    expect(screen.queryByTestId('bookmark-import-stub')).not.toBeInTheDocument();
    expect(screen.getByTestId('quick-links-toast')).toHaveTextContent(
      'Imported 3 links · 2 already saved · 1 not imported',
    );
  });
});

describe('describeImportResult', () => {
  it('omits empty counts', () => {
    expect(describeImportResult({ created: 1, skippedDuplicates: 0, rejected: [] })).toBe('Imported 1 link');
  });
});
