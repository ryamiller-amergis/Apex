/**
 * DesignModuleFormModal — AI scoping UX
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { UseDesignModuleScopingResult } from '../../hooks/useDesignModuleScoping';
import { DesignModuleFormModal } from '../DesignModuleFormModal';

const mockStart = jest.fn();
const mockCancel = jest.fn();
const mockReset = jest.fn();
const mockCreate = jest.fn();
const mockUpdate = jest.fn();
const mockPreviewMutate = jest.fn();

let mockHookState: UseDesignModuleScopingResult;
let mockConnected = true;

function baseHookState(): UseDesignModuleScopingResult {
  return {
    start: mockStart,
    cancel: mockCancel,
    reset: mockReset,
    status: 'idle',
    threadId: null,
    streamingText: '',
    progressLabel: null,
    result: null,
    error: null,
    isScoping: false,
  };
}

jest.mock('../../hooks/useDesignModuleScoping', () => ({
  useDesignModuleScoping: () => mockHookState,
}));

jest.mock('../../hooks/useGlobPreview', () => ({
  useGlobPreview: () => ({
    mutate: mockPreviewMutate,
    isPending: false,
  }),
}));

jest.mock('../../hooks/useProjectRepoConfigs', () => ({
  useProjectRepoConfigs: () => ({
    data: mockConnected
      ? [{ id: '1', skillRepo: 'org/repo', skillBranch: 'main' }]
      : [{ id: '1', skillRepo: '', skillBranch: '' }],
  }),
}));

jest.mock('../../hooks/useDesignModules', () => ({
  useCreateDesignModule: () => ({
    mutateAsync: mockCreate,
    isPending: false,
    error: null,
  }),
  useUpdateDesignModule: () => ({
    mutateAsync: mockUpdate,
    isPending: false,
    error: null,
  }),
}));

function renderModal(
  overrides: Partial<Parameters<typeof DesignModuleFormModal>[0]> = {}
) {
  const onClose = jest.fn();
  const onSaved = jest.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <DesignModuleFormModal
        project="Apex"
        onClose={onClose}
        onSaved={onSaved}
        {...overrides}
      />
    </QueryClientProvider>
  );
  return { onClose, onSaved };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockConnected = true;
  mockHookState = baseHookState();
  mockPreviewMutate.mockImplementation(
    (
      _body: unknown,
      options?: {
        onSuccess?: (data: {
          matches: { pattern: string; files: string[] }[];
        }) => void;
      }
    ) => {
      options?.onSuccess?.({
        matches: [
          {
            pattern: 'src/server/services/loadTest*.ts',
            files: ['src/server/services/loadTestService.ts'],
          },
        ],
      });
    }
  );
});

describe('DesignModuleFormModal AI scoping', () => {
  it('shows unavailable state when no skill repo is connected', () => {
    mockConnected = false;
    renderModal();
    expect(
      screen.getByTestId('design-module-scoping-unavailable')
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('design-module-suggest-ai')
    ).not.toBeInTheDocument();
  });

  it('shows AI proposals and updates preview when toggled/removed', async () => {
    const user = userEvent.setup();
    mockHookState = {
      ...baseHookState(),
      status: 'ready',
      result: {
        globs: [
          {
            pattern: 'src/server/services/loadTest*.ts',
            confidence: 'high',
            rationale: 'Primary services',
          },
          {
            pattern: 'src/client/hooks/useLoadTest*.ts',
            confidence: 'medium',
            rationale: 'Client hooks',
          },
        ],
        notes: 'Scoped load testing',
      },
    };

    renderModal();

    expect(
      await screen.findByTestId('design-module-proposal-list')
    ).toBeInTheDocument();
    expect(screen.getByText('src/server/services/loadTest*.ts')).toBeInTheDocument();
    expect(screen.getByText('Scoped load testing')).toBeInTheDocument();

    await waitFor(() =>
      expect(screen.getByText('loadTestService.ts')).toBeInTheDocument()
    );

    const toggles = screen.getAllByRole('checkbox');
    await user.click(toggles[0]);
    await waitFor(() => expect(mockPreviewMutate).toHaveBeenCalled());

    await user.click(
      screen.getByRole('button', {
        name: 'Remove src/client/hooks/useLoadTest*.ts',
      })
    );
    expect(
      screen.queryByText('src/client/hooks/useLoadTest*.ts')
    ).not.toBeInTheDocument();
  });

  it('sends refine instruction through the scoping hook', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText('Name'), 'Load Testing');
    await user.type(
      screen.getByTestId('design-module-refine-input'),
      'Exclude test files'
    );
    await user.click(screen.getByTestId('design-module-refine-send'));

    expect(mockStart).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Load Testing',
        instruction: 'Exclude test files',
      })
    );
    expect(screen.getByTestId('design-module-refine-chat')).toHaveTextContent(
      'Exclude test files'
    );
  });

  it('auto-derives a URL id from the module name', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText('Name'), 'Load Testing');
    expect(screen.getByTestId('design-module-slug-preview')).toHaveTextContent(
      'Saves as load-testing'
    );
  });

  it('shows search hints when a skill repo is connected', () => {
    renderModal();
    expect(screen.getByTestId('design-module-search-hints')).toBeInTheDocument();
    expect(screen.getByLabelText(/What should AI look for/i)).toBeInTheDocument();
  });

  it('hides search hints when no skill repo is connected', () => {
    mockConnected = false;
    renderModal();
    expect(
      screen.queryByTestId('design-module-search-hints')
    ).not.toBeInTheDocument();
  });

  it('passes searchHints on Suggest files with AI', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText('Name'), 'Load Testing');
    await user.type(
      screen.getByTestId('design-module-search-hints'),
      'LoadTest* hooks; exclude e2e specs'
    );
    await user.click(screen.getByTestId('design-module-suggest-ai'));

    expect(mockStart).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Load Testing',
        searchHints: 'LoadTest* hooks; exclude e2e specs',
      })
    );
    expect(mockStart.mock.calls[0][0].threadId).toBeUndefined();
    expect(mockStart.mock.calls[0][0].instruction).toBeUndefined();
  });

  it('passes searchHints with refine instruction', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText('Name'), 'Load Testing');
    await user.type(
      screen.getByTestId('design-module-search-hints'),
      'prefer runners/load-test-k6'
    );
    await user.type(
      screen.getByTestId('design-module-refine-input'),
      'Add the k6 runner'
    );
    await user.click(screen.getByTestId('design-module-refine-send'));

    expect(mockStart).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Load Testing',
        searchHints: 'prefer runners/load-test-k6',
        instruction: 'Add the k6 runner',
      })
    );
  });
});
