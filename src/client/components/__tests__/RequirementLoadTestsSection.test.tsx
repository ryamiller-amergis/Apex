/**
 * FEAT-010 / PBI-012 — RequirementLoadTestsSection
 *
 * AC-0: lists definitions with status + run deep-link
 * AC-1: query failure → isolated error state
 * AC-2: never-run shows Never run (not false pass)
 * AC-3: without load-test:view returns null (no disclosure)
 * VT-09: definition/run hrefs match /load-tests/:id and /load-tests/runs/:runId
 */
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { RequirementLoadTestsSection } from '../RequirementLoadTestsSection';

const mockCan = jest.fn();
const mockUseRequirementLoadTests = jest.fn();

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: () => ({
    can: mockCan,
    isSuperAdmin: false,
  }),
}));

jest.mock('../../hooks/useRequirementLoadTests', () => ({
  useRequirementLoadTests: (...args: unknown[]) => mockUseRequirementLoadTests(...args),
}));

function renderSection() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <RequirementLoadTestsSection projectId="project-a" workItemId={100} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('RequirementLoadTestsSection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCan.mockImplementation((key: string) => key === 'load-test:view');
  });

  it('AC-3: returns null when user lacks load-test:view (no disclosure)', () => {
    mockCan.mockReturnValue(false);
    mockUseRequirementLoadTests.mockReturnValue({
      isLoading: false,
      isError: false,
      isSuccess: false,
      data: undefined,
      refetch: jest.fn(),
    });

    const { container } = renderSection();
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('requirement-load-tests-section')).toBeNull();
  });

  it('AC-0 / VT-09: lists status badge and deep-links to definition and run', () => {
    mockUseRequirementLoadTests.mockReturnValue({
      isLoading: false,
      isError: false,
      isSuccess: true,
      data: [
        {
          definitionId: 'def-1',
          name: 'Checkout API',
          requirementRef: { kind: 'ado_work_item', id: '100' },
          latestRun: {
            runId: 'run-9',
            status: 'passed',
            overallResult: 'passed',
            completedAt: '2026-07-25T12:00:00.000Z',
            updatedAt: '2026-07-25T12:00:00.000Z',
          },
        },
      ],
      refetch: jest.fn(),
    });

    renderSection();

    expect(screen.getByTestId('requirement-load-tests-section')).toBeInTheDocument();
    expect(screen.getByTestId('requirement-load-test-row')).toBeInTheDocument();
    expect(screen.getByTestId('requirement-load-test-status')).toHaveTextContent(/Passed/i);
    expect(screen.getByTestId('requirement-load-test-definition-link')).toHaveAttribute(
      'href',
      '/load-tests/def-1',
    );
    expect(screen.getByTestId('requirement-load-test-run-link')).toHaveAttribute(
      'href',
      '/load-tests/runs/run-9',
    );
  });

  it('AC-1: shows isolated error state with retry', () => {
    const refetch = jest.fn();
    mockUseRequirementLoadTests.mockReturnValue({
      isLoading: false,
      isError: true,
      isSuccess: false,
      data: undefined,
      refetch,
      error: new Error('boom'),
    });

    renderSection();

    expect(screen.getByTestId('requirement-load-tests-error')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('AC-2: never-run shows Never run and omits run link', () => {
    mockUseRequirementLoadTests.mockReturnValue({
      isLoading: false,
      isError: false,
      isSuccess: true,
      data: [
        {
          definitionId: 'def-2',
          name: 'Unrun test',
          requirementRef: { kind: 'ado_work_item', id: '100' },
          latestRun: null,
        },
      ],
      refetch: jest.fn(),
    });

    renderSection();

    expect(screen.getByTestId('requirement-load-test-status')).toHaveTextContent(/Never run/i);
    expect(screen.queryByTestId('requirement-load-test-run-link')).toBeNull();
    expect(screen.queryByText(/Passed/i)).toBeNull();
  });

  it('shows empty state when API returns []', () => {
    mockUseRequirementLoadTests.mockReturnValue({
      isLoading: false,
      isError: false,
      isSuccess: true,
      data: [],
      refetch: jest.fn(),
    });

    renderSection();
    expect(screen.getByTestId('requirement-load-tests-empty')).toBeInTheDocument();
  });
});
