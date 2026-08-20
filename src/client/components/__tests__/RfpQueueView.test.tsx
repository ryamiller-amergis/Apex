import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RfpQueueView } from '../RfpQueueView';
import { useAppShell } from '../../hooks/useAppShell';
import { useFeatureFlag } from '../../hooks/useFeatureFlags';
import { useRfpQueue } from '../../hooks/useRfpTriage';

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: jest.fn(),
}));

jest.mock('../../hooks/useFeatureFlags', () => ({
  useFeatureFlag: jest.fn(),
}));

jest.mock('../../hooks/useRfpTriage', () => ({
  useRfpQueue: jest.fn(),
  useRfpTriageDetail: jest.fn(() => ({ data: undefined, isLoading: false, isError: false })),
  useRfpStatusTransition: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false, isError: false })),
  useRfpReopen: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false, isError: false })),
  useRfpAttachmentUpload: jest.fn(() => ({ mutateAsync: jest.fn(), isPending: false, isError: false })),
  useRfpMentionCandidates: jest.fn(() => ({ data: [] })),
}));

const mockedShell = useAppShell as jest.MockedFunction<typeof useAppShell>;
const mockedFlag = useFeatureFlag as jest.MockedFunction<typeof useFeatureFlag>;
const mockedQueue = useRfpQueue as jest.MockedFunction<typeof useRfpQueue>;

function renderQueue() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/rfp-intake']}>
        <RfpQueueView />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('RfpQueueView', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedFlag.mockReturnValue(true);
    mockedShell.mockReturnValue({
      can: (key: string) => key === 'rfp-intake:view' || key === 'rfp-intake:manage',
      selectedProject: 'Apex',
    } as never);
    mockedQueue.mockReturnValue({
      data: {
        total: 1,
        items: [{
          id: 'rfp-1',
          ownerId: 'owner-1',
          title: 'Internal tracker',
          stakeholder: 'BA team',
          status: 'evaluated',
          aiStatus: 'complete',
          currentVerdict: 'build',
          clarificationUsed: false,
          createdAt: '2026-08-19T12:00:00.000Z',
          updatedAt: '2026-08-19T12:00:00.000Z',
        }],
      },
      isLoading: false,
      isError: false,
      refetch: jest.fn(),
    } as never);
  });

  it('PBI-005 AC-0 renders searchable queue rows for an authorized Apex participant', () => {
    renderQueue();
    expect(screen.getByTestId('rfp-queue-view')).toBeInTheDocument();
    expect(screen.getByTestId('rfp-queue-search')).toBeInTheDocument();
    expect(screen.getByTestId('rfp-queue-row-rfp-1')).toBeInTheDocument();
    expect(screen.getByText('Internal tracker')).toBeInTheDocument();
    expect(screen.getByLabelText('Status Evaluated')).toBeInTheDocument();
  });

  it('PBI-005 AC-3 hides the queue outside Apex', () => {
    mockedShell.mockReturnValue({
      can: () => true,
      selectedProject: 'MaxView',
    } as never);
    renderQueue();
    expect(screen.queryByTestId('rfp-queue-view')).not.toBeInTheDocument();
  });
});
