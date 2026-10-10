import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  PlaybookDefinitionDetail,
  PlaybookPublishedVersionSummary,
} from '../../../shared/types/playbook';
import { PlaybookDefinitionPanel } from '../PlaybookDefinitionPanel';

const mockCan = jest.fn();
jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: () => ({ can: mockCan }),
}));

const PROJECT = 'Apex';
const GRAPH = { nodes: [{ id: 'notify', stepType: 'notify', config: { text: 'snapshot' } }], edges: [] };
const SUMMARY = {
  id: 'def-1',
  project: PROJECT,
  name: 'Release checks',
  description: 'Checks a release',
  draftUpdatedAt: '2026-09-22T12:00:00.000Z',
  currentPublishedVersionNumber: null,
};
const DETAIL: PlaybookDefinitionDetail = {
  definition: {
    id: 'def-1',
    project: PROJECT,
    name: 'Release checks',
    description: 'Checks a release',
    createdBy: 'author',
    createdAt: '2026-09-22T10:00:00.000Z',
    updatedAt: '2026-09-22T12:00:00.000Z',
  },
  draft: {
    id: 'draft-1',
    definitionId: 'def-1',
    nextVersionNumber: 1,
    graph: GRAPH,
    updatedAt: '2026-09-22T12:00:00.000Z',
  },
  versions: [],
  currentPublishedVersionId: null,
};

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function renderPanel(canAuthor = true) {
  mockCan.mockImplementation((key: string) => canAuthor && key === 'playbooks:author');
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <PlaybookDefinitionPanel project={PROJECT} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  jest.restoreAllMocks();
  mockCan.mockReset();
});

beforeEach(() => {
  global.fetch = jest.fn() as unknown as typeof fetch;
});

it('renders independent loading, error/retry, and author-aware empty states', async () => {
  let resolveFetch!: (value: Response) => void;
  (global.fetch as jest.Mock).mockReturnValueOnce(
    new Promise((resolve) => { resolveFetch = resolve; }),
  );
  const loading = renderPanel();
  expect(screen.getByTestId('playbook-definitions-loading')).toBeInTheDocument();
  resolveFetch(jsonResponse({ definitions: [] }));
  await screen.findByTestId('playbook-definition-empty-state');
  expect(screen.getByTestId('playbook-definition-create')).toBeInTheDocument();
  loading.unmount();

  (global.fetch as jest.Mock).mockResolvedValueOnce(jsonResponse({ error: 'List unavailable' }, 500));
  renderPanel();
  expect(await screen.findByTestId('playbook-definitions-error')).toHaveTextContent('List unavailable');
  expect(screen.getByTestId('playbook-definitions-retry')).toBeInTheDocument();
});

it('shows the empty state without Create to a viewer', async () => {
  (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({ definitions: [] }));
  renderPanel(false);

  expect(await screen.findByTestId('playbook-definition-empty-state')).toBeInTheDocument();
  expect(screen.queryByTestId('playbook-definition-create')).not.toBeInTheDocument();
});

it('keeps selected-definition loading, error, and retry separate from the list', async () => {
  let detailCalls = 0;
  (global.fetch as jest.Mock).mockImplementation(async (url: string) => {
    if (url.includes('/definitions/def-1')) {
      detailCalls += 1;
      return detailCalls === 1
        ? jsonResponse({ error: 'Detail unavailable' }, 500)
        : jsonResponse(DETAIL);
    }
    return jsonResponse({ definitions: [SUMMARY] });
  });
  renderPanel();

  expect(await screen.findByTestId('playbook-definition-detail-error')).toHaveTextContent(
    'Detail unavailable',
  );
  expect(screen.getByTestId('playbook-definition-select')).toBeInTheDocument();
  await userEvent.click(screen.getByTestId('playbook-definition-detail-retry'));
  expect(await screen.findByTestId('playbook-draft-editor')).toBeInTheDocument();
});

it('AC-0 publishes only the last saved valid draft, marks the immutable version current, and retains the editor', async () => {
  const published: PlaybookPublishedVersionSummary = {
    id: 'version-1',
    definitionId: 'def-1',
    versionNumber: 1,
    status: 'published',
    publishedBy: 'author',
    publishedAt: '2026-09-22T12:05:00.000Z',
  };
  let detail: PlaybookDefinitionDetail = DETAIL;
  const fetchMock = (global.fetch as jest.Mock).mockImplementation(async (url, init) => {
    const path = String(url);
    if (path.endsWith('/draft') && (init as RequestInit | undefined)?.method === 'PUT') {
      detail = {
        ...detail,
        draft: { ...detail.draft, graph: { nodes: [], edges: [] }, updatedAt: 'rev-2' },
      };
      return jsonResponse({ definition: detail.definition, draft: detail.draft });
    }
    if (path.endsWith('/publish')) {
      detail = {
        ...DETAIL,
        draft: { ...DETAIL.draft, nextVersionNumber: 2, updatedAt: 'rev-2' },
        versions: [published],
        currentPublishedVersionId: 'version-1',
      };
      return jsonResponse({
        publishedVersion: published,
        draft: detail.draft,
        currentPublishedVersionId: 'version-1',
      }, 201);
    }
    if (path.includes('/definitions/def-1')) return jsonResponse(detail);
    return jsonResponse({ definitions: [SUMMARY] });
  });
  renderPanel();

  const editor = await screen.findByTestId('playbook-draft-editor');
  fireEvent.change(editor, { target: { value: JSON.stringify({ nodes: [], edges: [] }) } });
  await waitFor(() => expect(screen.getByTestId('playbook-draft-publish')).toBeDisabled());

  await userEvent.click(screen.getByTestId('playbook-draft-save'));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
    '/api/playbooks/definitions/def-1/draft',
    expect.objectContaining({ method: 'PUT' }),
  ));
  await userEvent.click(screen.getByTestId('playbook-draft-publish'));

  expect(await screen.findByTestId('playbook-version-current')).toHaveTextContent('Current');
  expect(screen.getByTestId('playbook-draft-editor')).toBeInTheDocument();
  const publishBody = JSON.parse(String(
    (fetchMock.mock.calls.find(([url]) => String(url).endsWith('/publish'))?.[1] as RequestInit).body,
  ));
  expect(publishBody).toEqual({ project: PROJECT, expectedDraftUpdatedAt: 'rev-2' });
});

it('AC-1 shows a specific publish validation error and leaves version UI unchanged', async () => {
  (global.fetch as jest.Mock).mockImplementation(async (url: string) => {
    const path = String(url);
    if (path.endsWith('/publish')) {
      return jsonResponse({ error: 'Step notify exceeds the structural limit.' }, 400);
    }
    if (path.includes('/definitions/def-1')) return jsonResponse(DETAIL);
    return jsonResponse({ definitions: [SUMMARY] });
  });
  renderPanel();

  await screen.findByTestId('playbook-draft-editor');
  await userEvent.click(screen.getByTestId('playbook-draft-publish'));

  expect(await screen.findByRole('alert')).toHaveTextContent('Step notify exceeds the structural limit.');
  expect(screen.getByTestId('playbook-version-list')).toHaveTextContent('No published versions yet');
  expect(screen.queryByTestId('playbook-version-current')).not.toBeInTheDocument();
});

it('AC-2 saving retained draft does not mutate the published history snapshot', async () => {
  const versionedDetail = {
    ...DETAIL,
    versions: [{
      id: 'version-1',
      definitionId: 'def-1',
      versionNumber: 1,
      status: 'published',
      publishedBy: 'author',
      publishedAt: '2026-09-22T11:00:00.000Z',
    }],
    currentPublishedVersionId: 'version-1',
  };
  (global.fetch as jest.Mock).mockImplementation(async (url: string) => (
    String(url).includes('/definitions/def-1')
      ? jsonResponse(versionedDetail)
      : jsonResponse({ definitions: [SUMMARY] })
  ));
  renderPanel();

  const versionList = await screen.findByTestId('playbook-version-list');
  const historyBefore = versionList.textContent;
  fireEvent.change(screen.getByTestId('playbook-draft-editor'), {
    target: {
      value: JSON.stringify({
        nodes: [{ id: 'changed', stepType: 'notify' }],
        edges: [],
      }),
    },
  });
  await userEvent.click(screen.getByTestId('playbook-draft-save'));

  expect(versionList.textContent).toBe(historyBefore);
  expect(versionList).not.toHaveTextContent('changed');
});

it('AC-3 viewer sees definitions/history but no create, save, publish, or deprecate controls', async () => {
  (global.fetch as jest.Mock).mockImplementation(async (url: string) => (
    String(url).includes('/definitions/def-1')
      ? jsonResponse({
          ...DETAIL,
          versions: [{
            id: 'version-1',
            definitionId: 'def-1',
            versionNumber: 1,
            status: 'published',
            publishedBy: 'author',
            publishedAt: '2026-09-22T11:00:00.000Z',
          }],
          currentPublishedVersionId: 'version-1',
        })
      : jsonResponse({ definitions: [SUMMARY] })
  ));
  renderPanel(false);

  expect(await screen.findByTestId('playbook-version-list')).toHaveTextContent('Version 1');
  expect(screen.getByTestId('playbook-draft-editor')).toHaveAttribute('readonly');
  for (const id of [
    'playbook-definition-create',
    'playbook-draft-save',
    'playbook-draft-publish',
    'playbook-version-deprecate',
  ]) {
    expect(screen.queryByTestId(id)).not.toBeInTheDocument();
  }
});

it('shows save/publish pending states, conflict reload, labels, live status, and deprecation confirmation copy', async () => {
  let saveResolve!: (value: Response) => void;
  let publishResolve!: (value: Response) => void;
  const versionedDetail = {
    ...DETAIL,
    versions: [{
      id: 'version-1',
      definitionId: 'def-1',
      versionNumber: 1,
      status: 'published',
      publishedBy: 'author',
      publishedAt: '2026-09-22T11:00:00.000Z',
    }],
    currentPublishedVersionId: 'version-1',
  };
  (global.fetch as jest.Mock).mockImplementation(async (url: string) => {
    const path = String(url);
    if (path.endsWith('/draft')) return new Promise((resolve) => { saveResolve = resolve; });
    if (path.endsWith('/publish')) return new Promise((resolve) => { publishResolve = resolve; });
    if (path.includes('/definitions/def-1')) return jsonResponse(versionedDetail);
    return jsonResponse({ definitions: [SUMMARY] });
  });
  renderPanel();

  const editor = await screen.findByLabelText('Draft graph JSON');
  expect(editor).toHaveAttribute('aria-describedby');
  await userEvent.click(screen.getByTestId('playbook-draft-save'));
  await waitFor(() => {
    expect(screen.getByTestId('playbook-draft-save')).toHaveTextContent('Saving…');
  });
  await act(async () => {
    saveResolve(jsonResponse({ definition: DETAIL.definition, draft: DETAIL.draft }));
  });
  await screen.findByText('Draft saved.');

  await userEvent.click(screen.getByTestId('playbook-draft-publish'));
  expect(screen.getByTestId('playbook-draft-publish')).toHaveTextContent('Publishing…');
  await act(async () => {
    publishResolve(jsonResponse({ error: 'Draft changed by another author.' }, 409));
  });
  expect(await screen.findByTestId('playbook-draft-conflict')).toHaveTextContent(/reload/i);
  expect(within(screen.getByTestId('playbook-draft-conflict')).getByRole('button', { name: /reload/i })).toBeInTheDocument();

  await userEvent.click(screen.getByTestId('playbook-version-deprecate'));
  const dialog = screen.getByRole('dialog', { name: /deprecate version 1/i });
  expect(dialog).toHaveTextContent(/pinned runs continue/i);
  expect(within(dialog).getByTestId('playbook-version-deprecate-confirm')).toBeInTheDocument();
  expect(screen.getByTestId('playbook-definition-status')).toHaveAttribute('aria-live', 'polite');
});
