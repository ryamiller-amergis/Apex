/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { UiLabView } from '../UiLabView';
import type { UiLabDesignSummary } from '../../../shared/types/uiLab';

const SIDEBAR_COLLAPSED_KEY = 'apex-ui-lab-sidebar-collapsed';

const designs: UiLabDesignSummary[] = [
  {
    id: 'd1',
    project: 'Apex',
    authorId: 'author-1',
    title: 'to do list',
    prompt: 'to do list on home page',
    targetRoute: null,
    status: 'ready',
    version: 1,
    generationError: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as UiLabDesignSummary,
];

const sharedDesigns: UiLabDesignSummary[] = [
  { ...designs[0], id: 'd2', title: 'shared audit log' } as UiLabDesignSummary,
];

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: () => ({ can: () => true }),
}));

jest.mock('../../hooks/useUiLab', () => ({
  useUiLabDesigns: (project: string | null) => ({
    data: project ? designs : [],
    isLoading: false,
  }),
  useUiLabSharedDesigns: (project: string | null) => ({
    data: project ? sharedDesigns : [],
    isLoading: false,
  }),
  useCreateUiLabDesign: () => ({ mutateAsync: jest.fn(), isPending: false, isError: false, error: null }),
}));

jest.mock('../UiLabCanvas', () => ({
  UiLabCanvas: () => <div data-testid="ui-lab-canvas" />,
}));

describe('UiLabView — collapsible design list', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('collapses the design list to a strip and remembers the choice', () => {
    render(<UiLabView project="Apex" />);

    expect(screen.getByText('to do list')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ui-lab-sidebar-collapse'));

    expect(screen.queryByText('to do list')).not.toBeInTheDocument();
    expect(screen.getByTestId('ui-lab-sidebar-expand')).toBeInTheDocument();
    expect(localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe('true');
  });

  it('starts collapsed when the stored preference says so, and expands again', () => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, 'true');

    render(<UiLabView project="Apex" />);

    expect(screen.queryByText('to do list')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('ui-lab-sidebar-expand'));

    expect(screen.getByText('to do list')).toBeInTheDocument();
    expect(screen.getByTestId('ui-lab-sidebar-collapse')).toBeInTheDocument();
    expect(localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe('false');
  });
});

describe('UiLabView — shared-with-me list', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('lists only shared designs and offers no way to create one', () => {
    render(<UiLabView project="Apex" hasWorkspaceAccess={false} />);

    expect(screen.getByText('Shared with me')).toBeInTheDocument();
    expect(screen.getByText('shared audit log')).toBeInTheDocument();
    expect(screen.queryByText('to do list')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ui-lab-new-design-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ui-lab-create-first-design-btn')).not.toBeInTheDocument();
  });

  it('lists the whole project and allows creating for workspace members', () => {
    render(<UiLabView project="Apex" />);

    expect(screen.getByText('UI Lab')).toBeInTheDocument();
    expect(screen.getByText('to do list')).toBeInTheDocument();
    expect(screen.queryByText('shared audit log')).not.toBeInTheDocument();
    expect(screen.getByTestId('ui-lab-new-design-btn')).toBeInTheDocument();
  });
});
