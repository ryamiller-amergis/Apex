/**
 * PBI-007 AC-0..AC-3 / TBI-006 DoD-1, DoD-3 — LoadTestDefinitionBuilderView
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { LoadTestDefinitionBuilderView } from '../LoadTestDefinitionBuilderView';

const mockCan = jest.fn(
  (key: string) =>
    key === 'load-test:manage' || key === 'load-test:view' || key === 'load-test:run',
);
const mockNavigate = jest.fn();

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: () => ({ can: mockCan }),
}));

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));

const target = {
  id: 'target-1',
  projectId: 'project-a',
  baseUrl: 'https://api.staging.example.internal',
  environmentLabel: 'staging',
  isReachable: true,
  isActive: true,
  createdAt: '2026-07-24T00:00:00.000Z',
  updatedAt: '2026-07-24T00:00:00.000Z',
  createdBy: 'u',
  updatedBy: 'u',
};

function renderBuilder(definitionId?: string, section?: 'definition' | 'runs') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <LoadTestDefinitionBuilderView
          project="project-a"
          definitionId={definitionId}
          section={section}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('LoadTestDefinitionBuilderView (PBI-007)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCan.mockImplementation(
      (key: string) =>
        key === 'load-test:manage' || key === 'load-test:view' || key === 'load-test:run',
    );
  });

  it('AC-0 / DoD-1: guided multi-step save POSTs compiled script and thresholds', async () => {
    const user = userEvent.setup();
    let posted: unknown;
    global.fetch = jest.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/api/skill-configs')) {
        return { ok: true, status: 200, json: async () => [] };
      }
      if (typeof url === 'string' && url.includes('/load-test-targets')) {
        return { ok: true, status: 200, json: async () => ({ items: [target] }) };
      }
      if (init?.method === 'POST' && typeof url === 'string' && url.endsWith('/load-tests')) {
        posted = JSON.parse(String(init.body));
        return {
          ok: true,
          status: 201,
          json: async () => ({
            id: 'def-new',
            projectId: 'project-a',
            ...(posted as object),
            createdAt: '2026-07-24T00:00:00.000Z',
            updatedAt: '2026-07-24T00:00:00.000Z',
            createdBy: 'u',
            updatedBy: 'u',
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ items: [] }) };
    }) as unknown as typeof fetch;

    renderBuilder();

    await waitFor(() => {
      expect(screen.getByTestId('load-test-guided-form')).toBeInTheDocument();
    });

    await user.type(screen.getByLabelText(/^Name$/i), 'Multi-step checkout');
    await user.selectOptions(screen.getByLabelText(/Allowlisted target/i), 'target-1');
    await user.selectOptions(screen.getByLabelText(/Flow type/i), 'multi_step');
    await user.click(screen.getByRole('button', { name: /Add step/i }));

    const paths = screen.getAllByLabelText(/^Path$/i);
    await user.clear(paths[0]);
    await user.type(paths[0], '/api/login');
    await user.clear(paths[1]);
    await user.type(paths[1], '/api/orders');

    await user.click(screen.getByTestId('load-test-save-btn'));

    await waitFor(() => {
      expect(posted).toBeTruthy();
    });

    const body = posted as {
      script: string;
      clientThresholds: Array<{ metric: string; expression: string }>;
      scriptSource: string;
      flowType: string;
      flowSteps: Array<{ method: string; path: string }>;
    };
    expect(body.script).toContain('/api/login');
    expect(body.script).toContain('/api/orders');
    expect(body.flowSteps.map((s) => s.path)).toEqual(['/api/login', '/api/orders']);
    expect(body.clientThresholds.length).toBeGreaterThan(0);
    expect(body.scriptSource).toBe('form_builder');
    expect(body.flowType).toBe('multi_step');
    expect(mockNavigate).toHaveBeenCalledWith('/load-tests/def-new');
  });

  it('restores saved path from flowSteps when reopening a definition', async () => {
    const hrefOf = (url: RequestInfo | URL) =>
      typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

    global.fetch = jest.fn().mockImplementation(async (url: RequestInfo | URL) => {
      const href = hrefOf(url);
      if (href.includes('/api/skill-configs')) {
        return { ok: true, status: 200, json: async () => [] };
      }
      if (href.includes('/load-test-targets')) {
        return { ok: true, status: 200, json: async () => ({ items: [target] }) };
      }
      if (href.includes('/load-tests/def-1')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'def-1',
            projectId: 'project-a',
            name: 'Persisted path',
            description: null,
            targetUrl: target.baseUrl,
            environment: target.environmentLabel,
            engine: 'k6',
            flowType: 'single',
            scriptSource: 'form_builder',
            script: 'export default function () {}',
            loadProfile: { vus: 5, durationMinutes: 2 },
            clientThresholds: [{ metric: 'http_req_failed', expression: 'rate<0.01' }],
            flowSteps: [{ method: 'GET', path: '/api/health/db', tag: 'step_1' }],
            secretRefs: null,
            createdAt: '2026-07-24T00:00:00.000Z',
            updatedAt: '2026-07-24T00:00:00.000Z',
            createdBy: 'u',
            updatedBy: 'u',
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ items: [] }) };
    }) as unknown as typeof fetch;

    renderBuilder('def-1');

    await waitFor(() => {
      expect(screen.getByLabelText(/^Path$/i)).toHaveValue('/api/health/db');
    });
  });

  it('AC-1: save API error shows toast and keeps edits editable', async () => {
    const user = userEvent.setup();
    global.fetch = jest.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.includes('/api/skill-configs')) {
        return { ok: true, status: 200, json: async () => [] };
      }
      if (typeof url === 'string' && url.includes('/load-test-targets')) {
        return { ok: true, status: 200, json: async () => ({ items: [target] }) };
      }
      if (init?.method === 'POST') {
        return {
          ok: false,
          status: 500,
          json: async () => ({ error: 'Server blew up' }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ items: [] }) };
    }) as unknown as typeof fetch;

    renderBuilder();
    await waitFor(() => expect(screen.getByTestId('load-test-guided-form')).toBeInTheDocument());

    await user.type(screen.getByLabelText(/^Name$/i), 'Keep me');
    await user.selectOptions(screen.getByLabelText(/Allowlisted target/i), 'target-1');
    await user.click(screen.getByTestId('load-test-save-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('load-test-builder-error-toast')).toHaveTextContent('Server blew up');
    });
    expect(screen.getByLabelText(/^Name$/i)).toHaveValue('Keep me');
    expect(screen.getByLabelText(/^Name$/i)).not.toBeDisabled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('AC-2 / DoD-3: regenerating after raw edit requires confirm', async () => {
    const user = userEvent.setup();
    const hrefOf = (url: RequestInfo | URL) =>
      typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

    global.fetch = jest.fn().mockImplementation(async (url: RequestInfo | URL) => {
      const href = hrefOf(url);
      if (href.includes('/api/skill-configs')) {
        return { ok: true, status: 200, json: async () => [] };
      }
      if (href.includes('/load-test-targets')) {
        return { ok: true, status: 200, json: async () => ({ items: [target] }) };
      }
      if (href.includes('/load-tests/def-raw')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'def-raw',
            projectId: 'project-a',
            name: 'Raw edited',
            description: null,
            targetUrl: target.baseUrl,
            environment: target.environmentLabel,
            engine: 'k6',
            flowType: 'single',
            scriptSource: 'raw',
            script: 'export default function () { /* hand edited */ }',
            loadProfile: { vus: 5, durationMinutes: 2 },
            clientThresholds: [{ metric: 'http_req_failed', expression: 'rate<0.01' }],
            secretRefs: null,
            createdAt: '2026-07-24T00:00:00.000Z',
            updatedAt: '2026-07-24T00:00:00.000Z',
            createdBy: 'u',
            updatedBy: 'u',
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ items: [] }) };
    }) as unknown as typeof fetch;

    renderBuilder('def-raw');

    await waitFor(() => {
      expect(screen.getByTestId('load-test-raw-editor')).toBeInTheDocument();
    });

    // Switch to guided while script_source=raw should prompt confirm
    await user.click(screen.getByTestId('load-test-mode-guided'));

    await waitFor(() => {
      expect(screen.getByTestId('confirm-regenerate-script-modal')).toBeInTheDocument();
    });
    expect((screen.getByTestId('load-test-raw-editor') as HTMLTextAreaElement).value).toContain(
      'hand edited',
    );

    await user.click(screen.getByRole('button', { name: /Cancel/i }));
    await waitFor(() => {
      expect(screen.queryByTestId('confirm-regenerate-script-modal')).not.toBeInTheDocument();
    });
    expect((screen.getByTestId('load-test-raw-editor') as HTMLTextAreaElement).value).toContain(
      'hand edited',
    );
  });

  it('AC-3: view-only shows readonly banner and hides save/delete', async () => {
    mockCan.mockImplementation((key: string) => key === 'load-test:view');
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (typeof url === 'string' && url.includes('/api/skill-configs')) {
        return { ok: true, status: 200, json: async () => [] };
      }
      if (typeof url === 'string' && url.includes('/load-test-targets')) {
        return { ok: true, status: 200, json: async () => ({ items: [target] }) };
      }
      if (typeof url === 'string' && url.includes('/load-tests/def-1')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'def-1',
            projectId: 'project-a',
            name: 'Visible',
            description: null,
            targetUrl: target.baseUrl,
            environment: target.environmentLabel,
            engine: 'k6',
            flowType: 'single',
            scriptSource: 'form_builder',
            script: 'export default function () {}',
            loadProfile: { vus: 5, durationMinutes: 2 },
            clientThresholds: [{ metric: 'http_req_failed', expression: 'rate<0.01' }],
            secretRefs: null,
            createdAt: '2026-07-24T00:00:00.000Z',
            updatedAt: '2026-07-24T00:00:00.000Z',
            createdBy: 'u',
            updatedBy: 'u',
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ items: [] }) };
    }) as unknown as typeof fetch;

    renderBuilder('def-1');

    await waitFor(() => {
      expect(screen.getByTestId('load-test-builder-readonly-banner')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('load-test-save-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('load-test-delete-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('load-test-run-btn')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^Name$/i)).toBeDisabled();
    expect(screen.queryByText(/Secret references/i)).not.toBeInTheDocument();
  });

  it('Run enqueues saved definition and navigates to run detail', async () => {
    const user = userEvent.setup();
    const hrefOf = (url: RequestInfo | URL) =>
      typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

    global.fetch = jest.fn().mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = hrefOf(url);
      if (href.includes('/api/skill-configs')) {
        return { ok: true, status: 200, json: async () => [] };
      }
      if (href.includes('/load-test-targets')) {
        return { ok: true, status: 200, json: async () => ({ items: [target] }) };
      }
      if (href.includes('/load-tests/def-1') && !href.includes('/runs')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'def-1',
            projectId: 'project-a',
            name: 'Runnable',
            description: null,
            targetUrl: target.baseUrl,
            environment: target.environmentLabel,
            engine: 'k6',
            flowType: 'single',
            scriptSource: 'form_builder',
            script: 'export default function () {}',
            loadProfile: { vus: 5, durationMinutes: 2 },
            clientThresholds: [{ metric: 'http_req_failed', expression: 'rate<0.01' }],
            secretRefs: null,
            createdAt: '2026-07-24T00:00:00.000Z',
            updatedAt: '2026-07-24T00:00:00.000Z',
            createdBy: 'u',
            updatedBy: 'u',
          }),
        };
      }
      if (init?.method === 'POST' && href.endsWith('/load-tests/def-1/runs')) {
        return {
          ok: true,
          status: 201,
          json: async () => ({
            run: {
              id: 'run-new',
              projectId: 'project-a',
              loadTestId: 'def-1',
              status: 'dispatched',
              runSource: 'app',
              queuedAt: '2026-07-25T00:00:00.000Z',
              cancelRequested: false,
              createdAt: '2026-07-25T00:00:00.000Z',
              updatedAt: '2026-07-25T00:00:00.000Z',
            },
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ items: [] }) };
    }) as unknown as typeof fetch;

    renderBuilder('def-1');

    await waitFor(() => {
      expect(screen.getByTestId('load-test-run-btn')).toBeInTheDocument();
    });
    expect(screen.getByTestId('load-test-run-btn')).not.toBeDisabled();

    await user.click(screen.getByTestId('load-test-run-btn'));

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/load-tests/runs/run-new');
    });
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/projects/project-a/load-tests/def-1/runs',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('Run is disabled while the form has unsaved changes', async () => {
    const user = userEvent.setup();
    const hrefOf = (url: RequestInfo | URL) =>
      typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

    global.fetch = jest.fn().mockImplementation(async (url: RequestInfo | URL) => {
      const href = hrefOf(url);
      if (href.includes('/api/skill-configs')) {
        return { ok: true, status: 200, json: async () => [] };
      }
      if (href.includes('/load-test-targets')) {
        return { ok: true, status: 200, json: async () => ({ items: [target] }) };
      }
      if (href.includes('/load-tests/def-1')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'def-1',
            projectId: 'project-a',
            name: 'Runnable',
            description: null,
            targetUrl: target.baseUrl,
            environment: target.environmentLabel,
            engine: 'k6',
            flowType: 'single',
            scriptSource: 'form_builder',
            script: 'export default function () {}',
            loadProfile: { vus: 5, durationMinutes: 2 },
            clientThresholds: [{ metric: 'http_req_failed', expression: 'rate<0.01' }],
            secretRefs: null,
            createdAt: '2026-07-24T00:00:00.000Z',
            updatedAt: '2026-07-24T00:00:00.000Z',
            createdBy: 'u',
            updatedBy: 'u',
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ items: [] }) };
    }) as unknown as typeof fetch;

    renderBuilder('def-1');

    await waitFor(() => {
      expect(screen.getByTestId('load-test-run-btn')).toBeEnabled();
    });

    await user.type(screen.getByLabelText(/^Name$/i), ' edited');

    await waitFor(() => {
      expect(screen.getByTestId('load-test-run-btn')).toBeDisabled();
    });
  });

  it('Run re-enables after a successful save clears dirty state', async () => {
    const user = userEvent.setup();
    const hrefOf = (url: RequestInfo | URL) =>
      typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

    const definition = {
      id: 'def-1',
      projectId: 'project-a',
      name: 'Runnable',
      description: null as string | null,
      targetUrl: target.baseUrl,
      environment: target.environmentLabel,
      engine: 'k6',
      flowType: 'single',
      scriptSource: 'form_builder',
      script: 'export default function () {}',
      loadProfile: { vus: 5, durationMinutes: 2 },
      clientThresholds: [{ metric: 'http_req_failed', expression: 'rate<0.01' }],
      secretRefs: null as Record<string, string> | null,
      createdAt: '2026-07-24T00:00:00.000Z',
      updatedAt: '2026-07-24T00:00:00.000Z',
      createdBy: 'u',
      updatedBy: 'u',
    };

    global.fetch = jest.fn().mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = hrefOf(url);
      if (href.includes('/api/skill-configs')) {
        return { ok: true, status: 200, json: async () => [] };
      }
      if (href.includes('/load-test-targets')) {
        return { ok: true, status: 200, json: async () => ({ items: [target] }) };
      }
      if (href.includes('/load-tests/def-1') && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as { name: string; script: string };
        definition.name = body.name;
        definition.script = body.script;
        definition.updatedAt = '2026-07-25T12:00:00.000Z';
        return { ok: true, status: 200, json: async () => ({ ...definition }) };
      }
      if (href.includes('/load-tests/def-1') && !href.includes('/runs')) {
        return { ok: true, status: 200, json: async () => ({ ...definition }) };
      }
      return { ok: true, status: 200, json: async () => ({ items: [] }) };
    }) as unknown as typeof fetch;

    renderBuilder('def-1');

    await waitFor(() => {
      expect(screen.getByTestId('load-test-run-btn')).toBeEnabled();
    });

    await user.type(screen.getByLabelText(/^Name$/i), ' edited');

    await waitFor(() => {
      expect(screen.getByTestId('load-test-run-btn')).toBeDisabled();
      expect(screen.getByTestId('load-test-dirty-hint')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('load-test-save-btn'));

    await waitFor(() => {
      expect(screen.queryByTestId('load-test-dirty-hint')).not.toBeInTheDocument();
      expect(screen.getByTestId('load-test-run-btn')).toBeEnabled();
    });
  });

  it('Run API error surfaces as a toast without navigating', async () => {
    const user = userEvent.setup();
    const hrefOf = (url: RequestInfo | URL) =>
      typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

    global.fetch = jest.fn().mockImplementation(async (url: RequestInfo | URL, init?: RequestInit) => {
      const href = hrefOf(url);
      if (href.includes('/api/skill-configs')) {
        return { ok: true, status: 200, json: async () => [] };
      }
      if (href.includes('/load-test-targets')) {
        return { ok: true, status: 200, json: async () => ({ items: [target] }) };
      }
      if (href.includes('/load-tests/def-1') && !href.includes('/runs')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'def-1',
            projectId: 'project-a',
            name: 'Runnable',
            description: null,
            targetUrl: target.baseUrl,
            environment: target.environmentLabel,
            engine: 'k6',
            flowType: 'single',
            scriptSource: 'form_builder',
            script: 'export default function () {}',
            loadProfile: { vus: 5, durationMinutes: 2 },
            clientThresholds: [{ metric: 'http_req_failed', expression: 'rate<0.01' }],
            secretRefs: null,
            createdAt: '2026-07-24T00:00:00.000Z',
            updatedAt: '2026-07-24T00:00:00.000Z',
            createdBy: 'u',
            updatedBy: 'u',
          }),
        };
      }
      if (init?.method === 'POST' && href.includes('/runs')) {
        return {
          ok: false,
          status: 409,
          json: async () => ({ error: 'Target already has an active run' }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ items: [] }) };
    }) as unknown as typeof fetch;

    renderBuilder('def-1');

    await waitFor(() => {
      expect(screen.getByTestId('load-test-run-btn')).toBeEnabled();
    });

    await user.click(screen.getByTestId('load-test-run-btn'));

    await waitFor(() => {
      expect(screen.getByTestId('load-test-builder-error-toast')).toHaveTextContent(
        'Target already has an active run',
      );
    });
    expect(mockNavigate).not.toHaveBeenCalledWith(expect.stringContaining('/runs/'));
  });

  it('shows Definition/Runs section tabs for saved definitions', async () => {
    const hrefOf = (url: RequestInfo | URL) =>
      typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

    global.fetch = jest.fn().mockImplementation(async (url: RequestInfo | URL) => {
      const href = hrefOf(url);
      if (href.includes('/api/skill-configs')) {
        return { ok: true, status: 200, json: async () => [] };
      }
      if (href.includes('/load-test-targets')) {
        return { ok: true, status: 200, json: async () => ({ items: [target] }) };
      }
      if (href.includes('/load-tests/def-1')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'def-1',
            projectId: 'project-a',
            name: 'Runnable',
            description: null,
            targetUrl: target.baseUrl,
            environment: target.environmentLabel,
            engine: 'k6',
            flowType: 'single',
            scriptSource: 'form_builder',
            script: 'export default function () {}',
            loadProfile: { vus: 5, durationMinutes: 2 },
            clientThresholds: [{ metric: 'http_req_failed', expression: 'rate<0.01' }],
            secretRefs: null,
            createdAt: '2026-07-24T00:00:00.000Z',
            updatedAt: '2026-07-24T00:00:00.000Z',
            createdBy: 'u',
            updatedBy: 'u',
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ items: [] }) };
    }) as unknown as typeof fetch;

    renderBuilder('def-1', 'definition');

    await waitFor(() => {
      expect(screen.getByTestId('load-test-section-tabs')).toBeInTheDocument();
    });
    expect(screen.getByTestId('load-test-section-definition')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByTestId('load-test-section-runs')).toHaveAttribute(
      'aria-selected',
      'false',
    );
  });

  it('Runs section renders the definition run history panel', async () => {
    const hrefOf = (url: RequestInfo | URL) =>
      typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;

    global.fetch = jest.fn().mockImplementation(async (url: RequestInfo | URL) => {
      const href = hrefOf(url);
      if (href.includes('/api/skill-configs')) {
        return { ok: true, status: 200, json: async () => [] };
      }
      if (href.includes('/load-test-targets')) {
        return { ok: true, status: 200, json: async () => ({ items: [target] }) };
      }
      if (href.includes('/load-tests/runs')) {
        return { ok: true, status: 200, json: async () => ({ items: [] }) };
      }
      if (href.includes('/load-tests/def-1')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'def-1',
            projectId: 'project-a',
            name: 'Runnable',
            description: null,
            targetUrl: target.baseUrl,
            environment: target.environmentLabel,
            engine: 'k6',
            flowType: 'single',
            scriptSource: 'form_builder',
            script: 'export default function () {}',
            loadProfile: { vus: 5, durationMinutes: 2 },
            clientThresholds: [{ metric: 'http_req_failed', expression: 'rate<0.01' }],
            secretRefs: null,
            createdAt: '2026-07-24T00:00:00.000Z',
            updatedAt: '2026-07-24T00:00:00.000Z',
            createdBy: 'u',
            updatedBy: 'u',
          }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ items: [] }) };
    }) as unknown as typeof fetch;

    renderBuilder('def-1', 'runs');

    await waitFor(() => {
      expect(screen.getByTestId('load-test-definition-runs')).toBeInTheDocument();
    });
    expect(screen.getByTestId('load-test-section-runs')).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.queryByTestId('load-test-guided-form')).not.toBeInTheDocument();
    expect(screen.queryByTestId('load-test-save-btn')).not.toBeInTheDocument();
  });
});
