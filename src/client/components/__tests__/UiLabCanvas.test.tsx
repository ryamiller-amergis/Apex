/**
 * @jest-environment jsdom
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UiLabCanvas } from '../UiLabCanvas';
import {
  capabilitiesForAccess,
  type UiLabCapabilities,
  type UiLabEffectiveAccess,
} from '../../../shared/types/uiLab';

type MockDesign = {
  id: string;
  project: string;
  authorId: string;
  title: string;
  prompt: string;
  status: 'ready';
  html: string;
  version: number;
  history: Array<{ version: number; html: string; createdAt: string }>;
  createdAt: string;
  updatedAt: string;
  effectiveAccess: UiLabEffectiveAccess;
  capabilities: UiLabCapabilities;
};

const mockDesign: MockDesign = {
  id: 'd1',
  project: 'MaxView',
  authorId: 'author-1',
  title: 'Settings',
  prompt: 'A settings page',
  status: 'ready',
  html: '<!DOCTYPE html><html><body><h1>Settings</h1></body></html>',
  version: 2,
  history: [
    {
      version: 1,
      html: '<!DOCTYPE html><html><body><h1>Old</h1></body></html>',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    {
      version: 2,
      html: '<!DOCTYPE html><html><body><h1>Settings</h1></body></html>',
      createdAt: '2026-01-02T00:00:00.000Z',
    },
  ],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  effectiveAccess: 'shared',
  capabilities: capabilitiesForAccess('shared'),
};

jest.mock('../../hooks/useUiLab', () => ({
  useUiLabDesign: () => ({ data: mockDesign, isLoading: false, isError: false, error: null }),
  useUiLabComments: () => ({ data: [] }),
  useDeleteUiLabDesign: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useSaveUiLabHtml: () => ({ mutate: jest.fn(), isPending: false }),
  useAddUiLabComment: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useResolveUiLabComment: () => ({ mutate: jest.fn() }),
  useUiLabStream: () => ({
    phase: 'idle',
    streamedHtml: '',
    error: null,
    startStream: jest.fn(),
    cancelStream: jest.fn(),
  }),
  useUiLabShares: () => ({ data: [], isLoading: false, isError: false }),
  useUiLabShareTargets: () => ({ data: [], isLoading: false }),
  useCreateUiLabShare: () => ({ mutate: jest.fn(), isPending: false }),
  useRevokeUiLabShare: () => ({ mutate: jest.fn(), isPending: false }),
}));

jest.mock('../ApexLoader', () => ({
  ApexLoader: () => <div data-testid="loader" />,
}));

jest.mock('../BoundaryEditor', () => ({
  __esModule: true,
  default: () => <div data-testid="boundary-editor" />,
}));

function renderCanvas(sharedMode = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <UiLabCanvas designId="d1" project="MaxView" sharedMode={sharedMode} />
    </QueryClientProvider>,
  );
}

describe('UiLabCanvas — shared viewer gating', () => {
  it('shows preview/source toggles and hides edit controls for shared viewers', async () => {
    renderCanvas(true);

    expect(screen.getByTestId('ui-lab-view-toggle')).toBeInTheDocument();
    expect(screen.getByTestId('ui-lab-view-source')).toBeInTheDocument();
    expect(screen.getByTestId('ui-lab-shared-badge')).toBeInTheDocument();
    expect(screen.queryByTestId('ui-lab-edit-boundary')).not.toBeInTheDocument();
    expect(screen.queryByTestId('ui-lab-share-btn')).not.toBeInTheDocument();
    expect(screen.queryByText('Delete')).not.toBeInTheDocument();
    expect(screen.queryByText('↑ Apply')).not.toBeInTheDocument();
  });

  it('shows HTML source when View Source is clicked', async () => {
    renderCanvas(true);

    fireEvent.click(screen.getByTestId('ui-lab-view-source'));
    await waitFor(() => {
      expect(screen.getByTestId('ui-lab-source-view')).toBeInTheDocument();
    });
    expect(screen.getByTestId('ui-lab-source-view').textContent).toContain('<h1>Settings</h1>');
  });
});

describe('UiLabCanvas — manager capabilities', () => {
  beforeEach(() => {
    mockDesign.effectiveAccess = 'manage';
    mockDesign.capabilities = capabilitiesForAccess('manage');
  });

  afterEach(() => {
    mockDesign.effectiveAccess = 'shared';
    mockDesign.capabilities = capabilitiesForAccess('shared');
  });

  it('shows share and boundary edit for managers', () => {
    renderCanvas(false);

    expect(screen.getByTestId('ui-lab-share-btn')).toBeInTheDocument();
    expect(screen.getByTestId('ui-lab-edit-boundary')).toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();
  });
});
