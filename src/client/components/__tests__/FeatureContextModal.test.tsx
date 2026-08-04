import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { FeatureContextModal } from '../FeatureContextModal';
import type { ApexFeatureContextResponse, BacklogFeatureItem } from '../../../shared/types/devWorkbench';

const mockRefetch = jest.fn();

jest.mock('../../hooks/useApexBacklog', () => ({
  useApexFeatureContext: jest.fn(),
}));

jest.mock('../../hooks/useDevWorkbench', () => ({
  useActiveSessions: jest.fn(() => ({ data: [] })),
}));

jest.mock('../MarkdownWithMermaid', () => ({
  MarkdownWithMermaid: ({ content }: { content: string }) => (
    <div data-testid="markdown-content">{content}</div>
  ),
}));

jest.mock('../UiMockPreview', () => ({
  UiMockPreview: ({ mock }: { mock: { mockHtml?: string } }) => (
    <div data-testid="ui-mock-preview">
      <iframe title="UI mock v1" sandbox="allow-scripts" srcDoc={mock.mockHtml} />
    </div>
  ),
}));

import { useApexFeatureContext } from '../../hooks/useApexBacklog';

const feature: BacklogFeatureItem = {
  featureId: 'FEAT-001',
  featureTitle: 'Preference controls',
  featurePriority: 'Must',
  epicTitle: 'User preferences',
  prdId: 'prd-1',
  prdTitle: 'Notification Preferences',
  dependsOn: [],
  itemCount: 2,
  pbiCount: 1,
  tbiCount: 1,
};

const fullContext: ApexFeatureContextResponse = {
  prdId: 'prd-1',
  prdTitle: 'Notification Preferences',
  prdContent: '# PRD Body',
  epicTitle: 'User preferences',
  featureId: 'FEAT-001',
  featureTitle: 'Preference controls',
  featurePriority: 'Must',
  backlogItems: [
    {
      id: 'PBI-001',
      type: 'PBI',
      title: 'Toggle preferences',
      description: 'Users can toggle types',
      acceptanceCriteria: ['Given prefs, When toggle, Then saved'],
    },
    {
      id: 'TBI-001',
      type: 'TBI',
      title: 'Preferences API',
      definitionOfDone: ['Endpoints exist'],
    },
  ],
  designDocument: {
    id: 'doc-1',
    title: 'Prefs design',
    status: 'approved',
    designContent: '# Design Doc',
    techSpecContent: '# Tech Spec',
    assumptionsContent: '# Assumptions',
  },
  prototype: {
    id: 'proto-1',
    featureName: 'Preference controls',
    status: 'approved',
    mockHtml: '<html><body><p>Hello</p></body></html>',
    mockVersion: 1,
    history: [
      {
        version: 1,
        html: '<html><body><p>Hello</p></body></html>',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ],
  },
};

function mockHook(value: Partial<ReturnType<typeof useApexFeatureContext>>) {
  (useApexFeatureContext as jest.Mock).mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    error: null,
    refetch: mockRefetch,
    isFetching: false,
    ...value,
  });
}

function renderModal(onClose = jest.fn()) {
  return render(
    <FeatureContextModal project="Apex" feature={feature} onClose={onClose} />,
  );
}

describe('FeatureContextModal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHook({ data: fullContext });
  });

  it('shows a loading state while the query is pending', () => {
    mockHook({ isLoading: true, data: undefined });
    renderModal();
    expect(screen.getByText(/Loading feature context/i)).toBeInTheDocument();
  });

  it('shows an error with retry', () => {
    mockHook({
      isError: true,
      error: new Error('Approved PRD feature context not found'),
      data: undefined,
    });
    renderModal();
    expect(screen.getByRole('alert')).toHaveTextContent(/not found/i);
    fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
    expect(mockRefetch).toHaveBeenCalled();
  });

  it('renders accessible dialog roles and tabs', () => {
    renderModal();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    expect(screen.getAllByRole('tab')).toHaveLength(6);
    expect(screen.getByRole('tabpanel')).toBeInTheDocument();
  });

  it('renders PRD markdown by default', () => {
    renderModal();
    expect(screen.getByTestId('markdown-content')).toHaveTextContent('# PRD Body');
  });

  it('switches to the backlog tab and shows only feature items', () => {
    renderModal();
    fireEvent.click(screen.getByRole('tab', { name: /Backlog/i }));
    expect(screen.getByText('PBI-001')).toBeInTheDocument();
    expect(screen.getByText('TBI-001')).toBeInTheDocument();
    expect(screen.getByText(/Only work items associated with FEAT-001/i)).toBeInTheDocument();
  });

  it('expands backlog item details', () => {
    renderModal();
    fireEvent.click(screen.getByRole('tab', { name: /Backlog/i }));
    fireEvent.click(screen.getByRole('button', { name: /PBI-001/i }));
    expect(screen.getByText('Users can toggle types')).toBeInTheDocument();
    expect(screen.getByText(/Given prefs/i)).toBeInTheDocument();
  });

  it('shows missing-artifact states for design and prototype', () => {
    mockHook({
      data: {
        ...fullContext,
        designDocument: null,
        prototype: null,
      },
    });
    renderModal();

    fireEvent.click(screen.getByRole('tab', { name: /Design Doc/i }));
    expect(screen.getByText(/Design document has not been generated/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /Prototype/i }));
    expect(screen.getByText(/Prototype has not been generated/i)).toBeInTheDocument();
  });

  it('renders sandboxed prototype preview', () => {
    renderModal();
    fireEvent.click(screen.getByRole('tab', { name: /Prototype/i }));
    const preview = screen.getByTestId('ui-mock-preview');
    const iframe = within(preview).getByTitle(/UI mock/i);
    expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
  });

  it('renders design / tech / assumptions markdown tabs', () => {
    renderModal();
    fireEvent.click(screen.getByRole('tab', { name: /Design Doc/i }));
    expect(screen.getByTestId('markdown-content')).toHaveTextContent('# Design Doc');

    fireEvent.click(screen.getByRole('tab', { name: /Tech Spec/i }));
    expect(screen.getByTestId('markdown-content')).toHaveTextContent('# Tech Spec');

    fireEvent.click(screen.getByRole('tab', { name: /Assumptions/i }));
    expect(screen.getByTestId('markdown-content')).toHaveTextContent('# Assumptions');
  });

  it('closes on Escape', () => {
    const onClose = jest.fn();
    renderModal(onClose);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes when the backdrop is clicked', () => {
    const onClose = jest.fn();
    renderModal(onClose);
    fireEvent.click(screen.getByTestId('feature-context-modal-overlay'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close when the dialog content is clicked', () => {
    const onClose = jest.fn();
    renderModal(onClose);
    fireEvent.click(screen.getByTestId('feature-context-modal'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('supports arrow-key tab navigation', async () => {
    renderModal();
    const prdTab = screen.getByRole('tab', { name: /PRD/i });
    prdTab.focus();
    fireEvent.keyDown(prdTab, { key: 'ArrowDown' });
    await waitFor(() => {
      expect(screen.getByRole('tab', { name: /Backlog/i })).toHaveAttribute('aria-selected', 'true');
    });
  });
});
