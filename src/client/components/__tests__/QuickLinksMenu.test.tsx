import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ProjectQuickLink, UserQuickLink } from '../../../shared/types/projectQuickLinks';
import { QuickLinksMenu, describeImportResult } from '../QuickLinksMenu';
import { useMyQuickLinks, useProjectQuickLinks } from '../../hooks/useProjectQuickLinks';

const mockNavigate = jest.fn();

jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
}));

const createMy = jest.fn();
const updateMy = jest.fn();
const deleteMy = jest.fn();
const createShared = jest.fn();
const updateShared = jest.fn();
const deleteShared = jest.fn();

function mutation(mutateAsync: jest.Mock) {
  return { mutateAsync, mutate: jest.fn(), reset: jest.fn(), isPending: false, error: null };
}

jest.mock('../../hooks/useProjectQuickLinks', () => ({
  ...jest.requireActual('../../hooks/useProjectQuickLinks'),
  useProjectQuickLinks: jest.fn(),
  useMyQuickLinks: jest.fn(),
  useCreateMyQuickLink: () => mutation(createMy),
  useUpdateMyQuickLink: () => mutation(updateMy),
  useDeleteMyQuickLink: () => mutation(deleteMy),
  useCreateProjectQuickLink: () => mutation(createShared),
  useUpdateProjectQuickLink: () => mutation(updateShared),
  useDeleteProjectQuickLink: () => mutation(deleteShared),
}));

jest.mock('../BookmarkImportModal', () => ({
  BookmarkImportModal: ({ canShare, onImported }: { canShare: boolean; onImported: (r: unknown, s: string) => void }) => (
    <div data-testid="bookmark-import-stub" data-can-share={String(canShare)}>
      <button
        type="button"
        data-testid="bookmark-import-stub-finish"
        onClick={() =>
          onImported(
            { created: 3, skippedDuplicates: 2, rejected: [{ index: 0, label: '', url: '', reason: 'x' }] },
            'personal',
          )
        }
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

const sharedLinks = [
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
  [createMy, updateMy, deleteMy, createShared, updateShared, deleteShared].forEach((fn) => fn.mockResolvedValue({}));
  mockUseProjectQuickLinks.mockReturnValue({ data: sharedLinks });
  mockUseMyQuickLinks.mockReturnValue({ data: [] });
});

function openMenu() {
  fireEvent.click(screen.getByTestId('quick-links-menu-trigger'));
}

describe('visibility', () => {
  it('renders nothing without a selected project', () => {
    const { container } = render(<QuickLinksMenu project={undefined} canAddPersonal />);
    expect(container).toBeEmptyDOMElement();
    expect(mockUseProjectQuickLinks).not.toHaveBeenCalled();
  });

  it('renders nothing when project chrome is hidden', () => {
    const { container } = render(<QuickLinksMenu project="MaxView" hidden canAddPersonal />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a viewer when the project has no links', () => {
    mockUseProjectQuickLinks.mockReturnValue({ data: [] });
    const { container } = render(<QuickLinksMenu project="Amego" />);
    expect(container).toBeEmptyDOMElement();
    expect(mockUseMyQuickLinks).toHaveBeenCalledWith('Amego', false);
  });

  it('shows the button with zero links when the user can add personal links', () => {
    mockUseProjectQuickLinks.mockReturnValue({ data: [] });
    render(<QuickLinksMenu project="Amego" canAddPersonal />);
    openMenu();
    expect(screen.getByTestId('quick-links-menu-mine-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('quick-links-menu-project')).not.toBeInTheDocument();
    expect(screen.getByTestId('quick-links-menu-add')).toHaveFocus();
  });

  it('requests links for the selected project only', () => {
    render(<QuickLinksMenu project="MaxView" canAddPersonal />);
    expect(mockUseProjectQuickLinks).toHaveBeenCalledWith('MaxView');
    expect(mockUseMyQuickLinks).toHaveBeenCalledWith('MaxView', true);
  });
});

describe('sections', () => {
  it('labels Project links and My links with who can see them', () => {
    mockUseMyQuickLinks.mockReturnValue({ data: myLinks });
    render(<QuickLinksMenu project="MaxView" canAddPersonal />);
    openMenu();

    const shared = screen.getByRole('group', { name: 'Project links' });
    expect(shared).toHaveTextContent('Shared with everyone in MaxView');
    const mine = screen.getByRole('group', { name: 'My links' });
    expect(mine).toHaveTextContent('Only visible to you');

    expect(within(shared).getByRole('group', { name: 'Environments' })).toBeInTheDocument();
    expect(within(mine).getByRole('group', { name: 'Work' })).toBeInTheDocument();
    expect(within(mine).getByRole('group', { name: 'Other' })).toBeInTheDocument();
  });

  it('shows each link with its hostname and opens it in a new tab', () => {
    render(<QuickLinksMenu project="MaxView" />);
    openMenu();

    const prod = screen.getByTestId('quick-links-menu-item-prod');
    expect(prod).toHaveTextContent('MaxView Prod');
    expect(prod).toHaveTextContent('prod.example.com');
    expect(prod).toHaveAttribute('href', 'https://prod.example.com/');
    expect(prod).toHaveAttribute('target', '_blank');
    expect(prod).toHaveAttribute('rel', 'noopener noreferrer');
    expect(prod).toHaveFocus();
  });

  it('tells managers the shared section is empty and links to settings', () => {
    mockUseProjectQuickLinks.mockReturnValue({ data: [] });
    render(<QuickLinksMenu project="MaxView" canManage canOpenSettings canAddPersonal />);
    openMenu();

    expect(screen.getByTestId('quick-links-menu-project-empty')).toHaveTextContent('No shared links yet');
    fireEvent.click(screen.getByTestId('quick-links-menu-project-empty-manage'));
    expect(mockNavigate).toHaveBeenCalledWith('/admin/project-settings#quick-links');
  });

  it('hides the empty shared section from people who cannot manage it', () => {
    mockUseProjectQuickLinks.mockReturnValue({ data: [] });
    render(<QuickLinksMenu project="MaxView" canAddPersonal />);
    openMenu();
    expect(screen.queryByTestId('quick-links-menu-project')).not.toBeInTheDocument();
  });

  it('only shows edit and delete on shared links to managers', () => {
    const { unmount } = render(<QuickLinksMenu project="MaxView" canAddPersonal />);
    openMenu();
    expect(screen.queryByTestId('quick-links-menu-edit-prod')).not.toBeInTheDocument();
    unmount();

    render(<QuickLinksMenu project="MaxView" canManage canAddPersonal />);
    openMenu();
    expect(screen.getByTestId('quick-links-menu-edit-prod')).toHaveAttribute('aria-label', 'Edit MaxView Prod');
    expect(screen.getByTestId('quick-links-menu-delete-prod')).toHaveAttribute('title', 'Delete link');
  });

  it('puts Add link, Import bookmarks, and Manage links in the footer', () => {
    render(<QuickLinksMenu project="MaxView" canManage canOpenSettings canAddPersonal />);
    openMenu();
    const footer = screen.getByTestId('quick-links-menu-footer');
    expect(within(footer).getAllByRole('menuitem').map((el) => el.textContent)).toEqual([
      'Add link',
      'Import bookmarks',
      'Manage links…',
    ]);
  });

  it('hides footer actions without the permissions', () => {
    render(<QuickLinksMenu project="MaxView" />);
    openMenu();
    expect(screen.queryByTestId('quick-links-menu-footer')).not.toBeInTheDocument();
  });
});

describe('keyboard and dismissal', () => {
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
});

describe('Save to', () => {
  function fillAndSave(label: string, url: string) {
    fireEvent.change(screen.getByTestId('quick-link-edit-label'), { target: { value: label } });
    fireEvent.change(screen.getByTestId('quick-link-edit-url'), { target: { value: url } });
    fireEvent.click(screen.getByTestId('quick-link-edit-save'));
  }

  it('is hidden without quick-links:manage; links are saved as personal', async () => {
    render(<QuickLinksMenu project="MaxView" canAddPersonal />);
    openMenu();
    fireEvent.click(screen.getByTestId('quick-links-menu-add'));

    expect(screen.queryByTestId('quick-link-edit-scope')).not.toBeInTheDocument();
    fillAndSave('Grafana', 'https://grafana.example.com');

    await waitFor(() =>
      expect(createMy).toHaveBeenCalledWith({ label: 'Grafana', url: 'https://grafana.example.com', category: null }),
    );
    expect(createShared).not.toHaveBeenCalled();
  });

  it('defaults to Only me for managers', async () => {
    render(<QuickLinksMenu project="MaxView" canManage canAddPersonal />);
    openMenu();
    fireEvent.click(screen.getByTestId('quick-links-menu-add'));

    expect(screen.getByTestId('quick-link-edit-scope-personal')).toBeChecked();
    expect(screen.getByTestId('quick-link-edit-scope')).toHaveTextContent('Everyone in MaxView');
    fillAndSave('Grafana', 'https://grafana.example.com');

    await waitFor(() => expect(createMy).toHaveBeenCalled());
    expect(createShared).not.toHaveBeenCalled();
  });

  it('saves a shared project link when a manager picks Everyone', async () => {
    render(<QuickLinksMenu project="MaxView" canManage canAddPersonal />);
    openMenu();
    fireEvent.click(screen.getByTestId('quick-links-menu-add'));
    fireEvent.click(screen.getByTestId('quick-link-edit-scope-project'));
    fireEvent.change(screen.getByTestId('quick-link-edit-category'), { target: { value: 'Tools' } });
    fillAndSave('SendGrid', 'https://app.sendgrid.com');

    await waitFor(() =>
      expect(createShared).toHaveBeenCalledWith({ label: 'SendGrid', url: 'https://app.sendgrid.com', category: 'Tools' }),
    );
    expect(createMy).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId('quick-links-edit-modal')).not.toBeInTheDocument());
  });

  it('offers project categories for shared links and the union for personal links', () => {
    mockUseMyQuickLinks.mockReturnValue({ data: myLinks });
    render(<QuickLinksMenu project="MaxView" canManage canAddPersonal />);
    openMenu();
    fireEvent.click(screen.getByTestId('quick-links-menu-add'));

    const optionTexts = () =>
      Array.from((screen.getByTestId('quick-link-edit-category') as HTMLSelectElement).options).map((o) => o.text);
    expect(optionTexts()).toEqual(['No category', 'Environments', 'Tools', 'Work', '+ New category…']);

    fireEvent.click(screen.getByTestId('quick-link-edit-scope-project'));
    expect(optionTexts()).toEqual(['No category', 'Environments', 'Tools', '+ New category…']);
  });

  it('moves a personal link to the shared links when its scope changes on edit', async () => {
    mockUseMyQuickLinks.mockReturnValue({ data: myLinks });
    render(<QuickLinksMenu project="MaxView" canManage canAddPersonal />);
    openMenu();
    fireEvent.click(screen.getByTestId('quick-links-menu-my-edit-jira'));

    expect(screen.getByTestId('quick-link-edit-label')).toHaveValue('My Jira board');
    fireEvent.click(screen.getByTestId('quick-link-edit-scope-project'));
    fireEvent.click(screen.getByTestId('quick-link-edit-save'));

    await waitFor(() =>
      expect(createShared).toHaveBeenCalledWith({ label: 'My Jira board', url: 'https://jira.example.com/', category: null }),
    );
    expect(deleteMy).toHaveBeenCalledWith({ id: 'jira' });
    expect(updateMy).not.toHaveBeenCalled();
  });

  it('shows a server error and keeps the modal open', async () => {
    createMy.mockRejectedValue(new Error('You already have a link to this URL'));
    render(<QuickLinksMenu project="MaxView" canAddPersonal />);
    openMenu();
    fireEvent.click(screen.getByTestId('quick-links-menu-add'));
    fillAndSave('Dup', 'https://dup.example.com');

    expect(await screen.findByTestId('quick-link-edit-error')).toHaveTextContent('already have a link');
    expect(screen.getByTestId('quick-links-edit-modal')).toBeInTheDocument();
  });
});

describe('editing and deleting', () => {
  beforeEach(() => {
    mockUseMyQuickLinks.mockReturnValue({ data: myLinks });
  });

  it('updates a personal link in place', async () => {
    render(<QuickLinksMenu project="MaxView" canAddPersonal />);
    openMenu();
    fireEvent.click(screen.getByTestId('quick-links-menu-my-edit-jira'));

    expect(screen.getByTestId('quick-link-edit-category')).toHaveValue('Work');
    fireEvent.change(screen.getByTestId('quick-link-edit-label'), { target: { value: 'Team board' } });
    fireEvent.click(screen.getByTestId('quick-link-edit-save'));

    await waitFor(() =>
      expect(updateMy).toHaveBeenCalledWith({
        id: 'jira',
        input: { label: 'Team board', url: 'https://jira.example.com/', category: 'Work' },
      }),
    );
  });

  it('lets a manager edit a shared link', async () => {
    render(<QuickLinksMenu project="MaxView" canManage canAddPersonal />);
    openMenu();
    fireEvent.click(screen.getByTestId('quick-links-menu-edit-clerk'));

    expect(screen.getByTestId('quick-link-edit-scope-project')).toBeChecked();
    fireEvent.change(screen.getByTestId('quick-link-edit-label'), { target: { value: 'Clerk dashboard' } });
    fireEvent.click(screen.getByTestId('quick-link-edit-save'));

    await waitFor(() =>
      expect(updateShared).toHaveBeenCalledWith({
        id: 'clerk',
        input: { label: 'Clerk dashboard', url: 'https://clerk.example.com/', category: 'Tools' },
      }),
    );
  });

  it('confirms before deleting a personal link', async () => {
    render(<QuickLinksMenu project="MaxView" canAddPersonal />);
    openMenu();
    fireEvent.click(screen.getByTestId('quick-links-menu-my-delete-notes'));
    expect(deleteMy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('confirm-delete-confirm-btn'));

    await waitFor(() => expect(deleteMy).toHaveBeenCalledWith({ id: 'notes' }));
  });

  it('warns that deleting a shared link affects everyone', () => {
    render(<QuickLinksMenu project="MaxView" canManage canAddPersonal />);
    openMenu();
    fireEvent.click(screen.getByTestId('quick-links-menu-delete-prod'));
    expect(screen.getByTestId('quick-links-delete-modal')).toHaveTextContent('removes it for everyone in MaxView');
  });
});

describe('import', () => {
  it('passes the manager permission and shows the result as a toast', () => {
    render(<QuickLinksMenu project="MaxView" canManage canAddPersonal />);
    openMenu();
    fireEvent.click(screen.getByTestId('quick-links-menu-import'));

    expect(screen.getByTestId('bookmark-import-stub')).toHaveAttribute('data-can-share', 'true');
    fireEvent.click(screen.getByTestId('bookmark-import-stub-finish'));

    expect(screen.queryByTestId('bookmark-import-stub')).not.toBeInTheDocument();
    expect(screen.getByTestId('quick-links-toast')).toHaveTextContent(
      'Imported 3 links to My links · 2 already saved · 1 not imported',
    );
  });

  it('describes a shared import', () => {
    expect(describeImportResult({ created: 1, skippedDuplicates: 0, rejected: [] }, 'project')).toBe(
      'Imported 1 link to Project links',
    );
  });
});
