import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PlaybookRunActions } from '../PlaybookRunActions';
import type { PlaybookRunDetail } from '../../../shared/types/playbook';

let shell = { userId: 'owner', can: (_key: string) => false };
jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: () => shell,
}));

const RUN: PlaybookRunDetail = {
  runId: 'run-1',
  project: 'Apex',
  definitionName: 'Validate design',
  definitionVersionId: 'version-2',
  versionNumber: 2,
  status: 'suspended',
  initiatorUserId: 'owner',
  startedAt: '2026-09-22T10:00:00.000Z',
  completedAt: null,
  currentStepId: 'agent',
  suspension: null,
  steps: [
    {
      id: 'step-run-1',
      runId: 'run-1',
      stepId: 'agent',
      stepType: 'cursor-agent',
      status: 'failed_retryable',
      agentRunId: null,
      resumeToken: null,
      outputInline: { error: 'worker stopped' },
      outputBlobRef: null,
      expiresAt: null,
      startedAt: '2026-09-22T10:00:00.000Z',
      completedAt: '2026-09-22T10:01:00.000Z',
      createdAt: '2026-09-22T10:00:00.000Z',
      updatedAt: '2026-09-22T10:01:00.000Z',
    },
  ],
};

function renderActions(run = RUN) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    ...render(
      <QueryClientProvider client={client}>
        <PlaybookRunActions run={run} />
      </QueryClientProvider>
    ),
    client,
  };
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  shell = { userId: 'owner', can: (_key: string) => false };
  global.fetch = jest.fn(async (url: string) => {
    if (url.endsWith('/cancel')) {
      return response({ runId: 'run-1', status: 'cancelled', outcome: 'cancelled' });
    }
    if (url.endsWith('/retry')) {
      return response({
        runId: 'run-1',
        stepRunId: 'step-run-1',
        status: 'running',
        outcome: 'retried',
      });
    }
    return response(RUN);
  }) as unknown as typeof fetch;
});

describe('VT-20 — Playbook run actions', () => {
  it('shows eligible actions to the initiator or project admin, but not a stranger', () => {
    const { unmount } = renderActions();
    expect(screen.getByTestId('playbook-run-cancel')).toBeInTheDocument();
    expect(screen.getByTestId('playbook-run-retry-step')).toBeInTheDocument();
    unmount();

    shell = { userId: 'admin', can: (key: string) => key === 'playbooks:admin' };
    const admin = renderActions();
    expect(screen.getByTestId('playbook-run-actions')).toBeInTheDocument();
    admin.unmount();

    shell = { userId: 'stranger', can: (_key: string) => false };
    renderActions();
    expect(screen.queryByTestId('playbook-run-actions')).not.toBeInTheDocument();
  });

  it('confirms cancellation with initial and restored focus, then announces success', async () => {
    renderActions();
    const cancel = screen.getByTestId('playbook-run-cancel');
    await userEvent.click(cancel);

    expect(screen.getByTestId('playbook-cancel-dialog')).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByTestId('playbook-cancel-keep-run')).toHaveFocus();

    await userEvent.click(screen.getByTestId('playbook-cancel-confirm'));
    expect(await screen.findByTestId('playbook-run-action-success')).toHaveTextContent(
      /cancelled/i
    );
    await waitFor(() => expect(cancel).toHaveFocus());
  });

  it('retries only the current failed_retryable row and announces progress', async () => {
    const { client } = renderActions();
    const invalidate = jest.spyOn(client, 'invalidateQueries');
    await userEvent.click(screen.getByTestId('playbook-run-retry-step'));

    expect(await screen.findByTestId('playbook-run-action-success')).toHaveTextContent(
      /retry started/i
    );
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/playbooks/runs/run-1/steps/step-run-1/retry',
      expect.objectContaining({ method: 'POST' })
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['playbook-runs', 'Apex'] });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['playbook-run', 'Apex', 'run-1'],
    });
  });

  it('disables the active action while pending and keeps transport errors retryable', async () => {
    let resolveRequest!: (value: Response) => void;
    global.fetch = jest.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveRequest = resolve;
        })
    ) as unknown as typeof fetch;
    renderActions();
    const retry = screen.getByTestId('playbook-run-retry-step');
    await userEvent.click(retry);

    expect(retry).toBeDisabled();
    expect(retry).toHaveTextContent('Retrying…');
    resolveRequest(response({ error: 'Network path unavailable' }, 500));

    expect(await screen.findByTestId('playbook-run-action-error')).toHaveTextContent(
      'Network path unavailable'
    );
    expect(retry).toBeEnabled();
  });

  it('renders the 403 refresh state as an alert', async () => {
    global.fetch = jest.fn(async () =>
      response({ error: 'Forbidden' }, 403)
    ) as unknown as typeof fetch;
    renderActions();
    await userEvent.click(screen.getByTestId('playbook-run-retry-step'));

    expect(await screen.findByTestId('playbook-run-action-error')).toHaveTextContent(
      /access changed.*refreshed/i
    );
  });
});
