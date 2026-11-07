import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ProjectQuickLink } from '../../../shared/types/projectQuickLinks';
import { ProjectQuickLinksSettings } from '../ProjectQuickLinksSettings';
import { useProjectQuickLinks } from '../../hooks/useProjectQuickLinks';

let mockCan = (_key: string) => true;

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: () => ({ can: (key: string) => mockCan(key) }),
}));

const createMutate = jest.fn();
const updateMutate = jest.fn();
const deleteMutate = jest.fn();
const reorderMutate = jest.fn();

function mutation(mutate: jest.Mock) {
  return { mutate, reset: jest.fn(), isPending: false, error: null };
}

jest.mock('../../hooks/useProjectQuickLinks', () => ({
  ...jest.requireActual('../../hooks/useProjectQuickLinks'),
  useProjectQuickLinks: jest.fn(),
  useCreateProjectQuickLink: () => mutation(createMutate),
  useUpdateProjectQuickLink: () => mutation(updateMutate),
  useDeleteProjectQuickLink: () => mutation(deleteMutate),
  useReorderProjectQuickLinks: () => mutation(reorderMutate),
}));

const mockUseProjectQuickLinks = useProjectQuickLinks as jest.Mock;

function makeLink(id: string, label: string, category: string | null, sortOrder = 0): ProjectQuickLink {
  return {
    id,
    project: 'MaxView',
    label,
    url: `https://${id}.example.com/`,
    category,
    sortOrder,
    createdBy: null,
    updatedBy: null,
    createdAt: '2026-10-28T19:00:00.000Z',
    updatedAt: '2026-10-28T19:00:00.000Z',
  };
}

const links = [
  makeLink('prod', 'MaxView Prod', 'Environments', 0),
  makeLink('test', 'MaxView Test', 'Environments', 1),
  makeLink('clerk', 'Clerk', 'Tools', 0),
];

beforeEach(() => {
  jest.clearAllMocks();
  mockCan = () => true;
  mockUseProjectQuickLinks.mockReturnValue({ data: links, isLoading: false, isError: false });
});

describe('ProjectQuickLinksSettings', () => {
  it('renders nothing without quick-links:manage', () => {
    mockCan = () => false;
    const { container } = render(<ProjectQuickLinksSettings project="MaxView" />);
    expect(container).toBeEmptyDOMElement();
    expect(mockUseProjectQuickLinks).not.toHaveBeenCalled();
  });

  it('lists the project links in a grid', () => {
    render(<ProjectQuickLinksSettings project="MaxView" />);
    expect(screen.getByTestId('quick-links-grid')).toBeInTheDocument();
    expect(screen.getByTestId('quick-link-row-prod')).toBeInTheDocument();
    expect(screen.getByTestId('quick-link-row-clerk')).toBeInTheDocument();
  });

  it('filters by search text', () => {
    render(<ProjectQuickLinksSettings project="MaxView" />);
    fireEvent.change(screen.getByTestId('quick-links-search'), { target: { value: 'clerk' } });
    expect(screen.queryByTestId('quick-link-row-prod')).not.toBeInTheDocument();
    expect(screen.getByTestId('quick-link-row-clerk')).toBeInTheDocument();
  });

  it('filters by category', () => {
    render(<ProjectQuickLinksSettings project="MaxView" />);
    fireEvent.change(screen.getByTestId('quick-links-filter-category'), { target: { value: 'Tools' } });
    expect(screen.queryByTestId('quick-link-row-test')).not.toBeInTheDocument();
    expect(screen.getByTestId('quick-link-row-clerk')).toBeInTheDocument();
  });

  it('reorders within a category', () => {
    render(<ProjectQuickLinksSettings project="MaxView" />);
    expect(screen.getByTestId('quick-link-move-up-prod')).toBeDisabled();
    expect(screen.getByTestId('quick-link-move-down-test')).toBeDisabled();

    fireEvent.click(screen.getByTestId('quick-link-move-down-prod'));

    expect(reorderMutate).toHaveBeenCalledWith({ ids: ['test', 'prod', 'clerk'] }, expect.any(Object));
  });

  it('rejects a javascript: URL in the add form', async () => {
    render(<ProjectQuickLinksSettings project="MaxView" />);
    fireEvent.click(screen.getByTestId('quick-links-add'));
    fireEvent.change(screen.getByTestId('quick-link-form-label'), { target: { value: 'Bad' } });
    fireEvent.change(screen.getByTestId('quick-link-form-url'), { target: { value: 'javascript:alert(1)' } });
    fireEvent.click(screen.getByTestId('quick-link-form-save'));

    expect(await screen.findByText('Enter a full URL starting with http:// or https://')).toBeInTheDocument();
    expect(createMutate).not.toHaveBeenCalled();
  });

  it('creates a link from the add form', async () => {
    render(<ProjectQuickLinksSettings project="MaxView" />);
    fireEvent.click(screen.getByTestId('quick-links-add'));
    fireEvent.change(screen.getByTestId('quick-link-form-label'), { target: { value: ' SendGrid ' } });
    fireEvent.change(screen.getByTestId('quick-link-form-url'), { target: { value: 'https://app.sendgrid.com' } });
    fireEvent.change(screen.getByTestId('quick-link-form-category'), { target: { value: 'Tools' } });
    fireEvent.click(screen.getByTestId('quick-link-form-save'));

    await waitFor(() =>
      expect(createMutate).toHaveBeenCalledWith(
        { label: 'SendGrid', url: 'https://app.sendgrid.com', category: 'Tools', sortOrder: 0 },
        expect.any(Object),
      ),
    );
  });

  it('explains these are shared links and that personal links live in the header', () => {
    mockUseProjectQuickLinks.mockReturnValue({ data: [], isLoading: false, isError: false });
    render(<ProjectQuickLinksSettings project="MaxView" />);
    expect(screen.getByTestId('quick-links-settings')).toHaveTextContent('Shared links that everyone in MaxView sees');
    expect(screen.getByTestId('quick-links-empty')).toHaveTextContent(
      'Links you add under “My links” in the header are private to you and don’t appear here.',
    );
  });

  it('shows each category as a pill', () => {
    render(<ProjectQuickLinksSettings project="MaxView" />);
    expect(screen.getByTestId('quick-link-category-clerk')).toHaveTextContent('Tools');
  });

  it('offers existing project categories in the form, plus a new one', async () => {
    render(<ProjectQuickLinksSettings project="MaxView" />);
    fireEvent.click(screen.getByTestId('quick-links-add'));
    const select = screen.getByTestId('quick-link-form-category') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.text)).toEqual([
      'No category',
      'Environments',
      'Tools',
      '+ New category…',
    ]);

    fireEvent.change(select, { target: { value: '__new_category__' } });
    fireEvent.change(screen.getByTestId('quick-link-form-category-new'), { target: { value: 'Monitoring' } });
    fireEvent.change(screen.getByTestId('quick-link-form-label'), { target: { value: 'Grafana' } });
    fireEvent.change(screen.getByTestId('quick-link-form-url'), { target: { value: 'https://grafana.example.com' } });
    fireEvent.click(screen.getByTestId('quick-link-form-save'));

    await waitFor(() =>
      expect(createMutate).toHaveBeenCalledWith(
        expect.objectContaining({ category: 'Monitoring' }),
        expect.any(Object),
      ),
    );
  });

  it('asks for confirmation before deleting', () => {
    render(<ProjectQuickLinksSettings project="MaxView" />);
    fireEvent.click(screen.getByTestId('quick-link-delete-clerk'));
    expect(deleteMutate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('confirm-delete-confirm-btn'));

    expect(deleteMutate).toHaveBeenCalledWith({ id: 'clerk' }, expect.any(Object));
  });
});
