import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { DIAGRAM_DEFAULT_TITLE } from '../../../shared/types/diagram';
import { DiagramEditorView } from '../DiagramEditorView';
import { DiagramsView } from '../DiagramsView';

const mockCan = jest.fn((key: string) => key === 'diagram:create' || key === 'diagram:edit' || key === 'diagram:view');
const mockNavigate = jest.fn();

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: () => ({ can: mockCan }),
}));

jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
}));

jest.mock('../ExcalidrawAdapter', () => {
  const ReactActual = jest.requireActual('react') as typeof React;
  const MockAdapter = ReactActual.forwardRef(
    (
      props: {
        scene: unknown;
        editable: boolean;
        onSceneChange: (s: unknown) => void;
        onCanvasHydrated?: (s: unknown) => void;
      },
      ref: React.Ref<{ getThumbnailSource: () => { exportPngBlob: () => Promise<Blob> } }>,
    ) => {
      ReactActual.useImperativeHandle(ref, () => ({
        getThumbnailSource: () => ({
          exportPngBlob: async () => new Blob(['x'], { type: 'image/png' }),
        }),
        getLiveScene: () => ({
          elements: [{ id: 'drawn' }],
          appState: {},
          files: {},
        }),
        exportPng: async () => new Blob(['x'], { type: 'image/png' }),
        exportSvg: async () => document.createElementNS('http://www.w3.org/2000/svg', 'svg'),
        exportNativeJson: async () => '{}',
      }));
      ReactActual.useEffect(() => {
        props.onCanvasHydrated?.(props.scene);
      }, []);
      return ReactActual.createElement(
        'div',
        {
          'data-testid': 'diagram-editor-canvas',
          'data-editable': String(props.editable),
        },
        ReactActual.createElement(
          'button',
          {
            type: 'button',
            'data-testid': 'diagram-mock-draw',
            onClick: () =>
              props.onSceneChange({
                elements: [{ id: 'drawn' }],
                appState: {},
                files: {},
              }),
          },
          'Draw',
        ),
      );
    },
  );
  return { ExcalidrawAdapter: MockAdapter, __esModule: true, default: MockAdapter };
});

function renderEditor(mode: 'new' | 'existing' = 'new', diagramId: string | null = null) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[mode === 'new' ? '/diagrams/new' : `/diagrams/${diagramId}`]}>
        <Routes>
          <Route
            path="/diagrams/new"
            element={<DiagramEditorView projectId="project-a" diagramId={null} mode="new" />}
          />
          <Route
            path="/diagrams/:id"
            element={
              <DiagramEditorView projectId="project-a" diagramId={diagramId} mode="existing" />
            }
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('DiagramEditorView / DiagramsView — FEAT-003', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCan.mockImplementation(
      (key: string) => key === 'diagram:create' || key === 'diagram:edit' || key === 'diagram:view',
    );
  });

  it('PBI-002 AC-0 / VT-01: New Diagram opens Untitled diagram and Save creates it', async () => {
    const user = userEvent.setup();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({
        id: 'diagram-created',
        projectId: 'project-a',
        ownerId: 'owner-1',
        ownerName: 'Owner One',
        title: DIAGRAM_DEFAULT_TITLE,
        scene: { elements: [{ id: 'drawn' }], appState: {}, files: {} },
        thumbnail: 'data:image/png;base64,aaa',
        version: 1,
        effectiveAccess: 'owner',
        createdAt: '2026-08-06T00:00:00.000Z',
        updatedAt: '2026-08-06T00:00:00.000Z',
      }),
    }) as jest.Mock;

    renderEditor('new');
    expect(screen.getByTestId('diagram-title-input')).toHaveValue(DIAGRAM_DEFAULT_TITLE);

    await user.click(screen.getByTestId('diagram-mock-draw'));
    expect(screen.getByTestId('diagram-unsaved-indicator')).toBeInTheDocument();

    await user.click(screen.getByTestId('diagram-save-button'));
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByTestId('diagram-unsaved-indicator')).not.toBeInTheDocument(),
    );
    expect(mockNavigate).toHaveBeenCalledWith('/diagrams/diagram-created', { replace: true });
  });

  it('PBI-002 AC-1 / VT-02: save failure shows error and keeps unsaved indicator', async () => {
    const user = userEvent.setup();
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: 'Save failed' }),
    }) as jest.Mock;

    renderEditor('new');
    await user.click(screen.getByTestId('diagram-mock-draw'));
    await user.click(screen.getByTestId('diagram-save-button'));

    await waitFor(() => expect(screen.getByTestId('diagram-save-error')).toBeInTheDocument());
    expect(screen.getByTestId('diagram-unsaved-indicator')).toBeInTheDocument();
    expect(screen.queryByText(/saved successfully/i)).not.toBeInTheDocument();
  });

  it('PBI-002 AC-3 / VT-04: hides New Diagram and Save when create/edit denied', () => {
    mockCan.mockImplementation((key: string) => key === 'diagram:view');

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <DiagramsView projectId="project-a" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.queryByTestId('diagram-new-button')).not.toBeInTheDocument();
    expect(screen.getByTestId('diagrams-create-forbidden')).toBeInTheDocument();

    renderEditor('new');
    expect(screen.queryByTestId('diagram-save-button')).not.toBeInTheDocument();
  });

  it('PBI-003 AC-1 / VT-06: conflict opens VersionConflictDialog without overwriting local scene', async () => {
    const user = userEvent.setup();
    global.fetch = jest.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (!init?.method || init.method === 'GET') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'diagram-1',
            projectId: 'project-a',
            ownerId: 'owner-1',
            ownerName: 'Owner One',
            title: DIAGRAM_DEFAULT_TITLE,
            scene: { elements: [], appState: {}, files: {} },
            thumbnail: 'data:image/png;base64,aaa',
            version: 1,
            effectiveAccess: 'owner',
            createdAt: '2026-08-06T00:00:00.000Z',
            updatedAt: '2026-08-06T00:00:00.000Z',
          }),
        };
      }
      return {
        ok: false,
        status: 409,
        json: async () => ({
          error: 'Diagram was updated by another editor',
          code: 'DIAGRAM_VERSION_CONFLICT',
        }),
      };
    }) as jest.Mock;

    renderEditor('existing', 'diagram-1');
    await waitFor(() => expect(screen.getByTestId('diagram-editor-canvas')).toBeInTheDocument());
    await user.click(screen.getByTestId('diagram-mock-draw'));
    await user.click(screen.getByTestId('diagram-save-button'));

    await waitFor(() => expect(screen.getByTestId('diagram-conflict-dialog')).toBeInTheDocument());
    expect(screen.getByTestId('diagram-unsaved-indicator')).toBeInTheDocument();
  });

  it('PBI-003 AC-2 / VT-07: clean editor does not show unsaved dialog on Back', async () => {
    const user = userEvent.setup();
    renderEditor('new');
    await user.click(screen.getByTestId('diagram-editor-back'));
    expect(screen.queryByTestId('diagram-unsaved-dialog')).not.toBeInTheDocument();
    expect(mockNavigate).toHaveBeenCalledWith('/diagrams');
  });

  it('PBI-003 AC-3 / VT-08: dirty editor shows unsaved dialog on Back; Stay keeps editor open', async () => {
    const user = userEvent.setup();
    renderEditor('new');
    await user.click(screen.getByTestId('diagram-mock-draw'));
    await user.click(screen.getByTestId('diagram-editor-back'));
    expect(screen.getByTestId('diagram-unsaved-dialog')).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalledWith('/diagrams');

    await user.click(screen.getByTestId('diagram-unsaved-stay'));
    expect(screen.queryByTestId('diagram-unsaved-dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('diagram-editor')).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalledWith('/diagrams');
  });

  it('DiagramsView exposes New Diagram trigger when create is allowed', () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <DiagramsView projectId="project-a" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByTestId('diagram-new-button')).toBeInTheDocument();
    expect(screen.getByTestId('diagrams-browse-view')).toBeInTheDocument();
  });

  it('PBI-005 AC-2 / AC-3: export menu is present for editors', async () => {
    renderEditor('new');
    expect(screen.getByTestId('diagram-export-png')).toBeInTheDocument();
    expect(screen.getByTestId('diagram-export-svg')).toBeInTheDocument();
    expect(screen.getByTestId('diagram-export-excalidraw')).toBeInTheDocument();
  });

  it('PBI-005 AC-3 / PBI-008 AC-0: view-only disables title and save but keeps export', async () => {
    mockCan.mockImplementation((key: string) => key === 'diagram:view' || key === 'diagram:edit');
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'diagram-view',
        projectId: 'project-a',
        ownerId: 'owner-1',
        ownerName: 'Owner One',
        title: 'Shared View',
        scene: { elements: [], appState: {}, files: {} },
        thumbnail: 'data:image/png;base64,aaa',
        version: 1,
        effectiveAccess: 'view',
        createdAt: '2026-08-06T00:00:00.000Z',
        updatedAt: '2026-08-06T00:00:00.000Z',
      }),
    }) as jest.Mock;

    renderEditor('existing', 'diagram-view');
    await waitFor(() => expect(screen.getByTestId('diagram-editor-canvas')).toBeInTheDocument());

    expect(screen.getByTestId('diagram-editor-readonly')).toBeInTheDocument();
    expect(screen.getByTestId('diagram-view-only-label')).toHaveTextContent(/view only/i);
    expect(screen.getByTestId('diagram-title-input')).toBeDisabled();
    expect(screen.getByTestId('diagram-save-button')).toBeDisabled();
    expect(screen.getByTestId('diagram-export-png')).toBeEnabled();
    expect(screen.getByTestId('diagram-export-svg')).toBeEnabled();
    expect(screen.getByTestId('diagram-export-excalidraw')).toBeEnabled();
  });

  it('PBI-008 AC-1: revoked grant on load shows access-denied state', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({ error: 'Forbidden', code: 'DIAGRAM_FORBIDDEN' }),
    }) as jest.Mock;

    renderEditor('existing', 'diagram-revoked');
    await waitFor(() => expect(screen.getByTestId('diagram-access-denied')).toBeInTheDocument());
    expect(screen.queryByTestId('diagram-editor-canvas')).not.toBeInTheDocument();
  });

  it('PBI-008 AC-2: edit grant without diagram:edit renders view-only controls', async () => {
    mockCan.mockImplementation((key: string) => key === 'diagram:view');
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'diagram-ceiling',
        projectId: 'project-a',
        ownerId: 'owner-2',
        ownerName: 'Owner Two',
        title: 'Shared Edit Cap',
        scene: { elements: [{ id: 'a' }], appState: {}, files: {} },
        thumbnail: 'data:image/png;base64,aaa',
        version: 1,
        effectiveAccess: 'view',
        createdAt: '2026-08-06T00:00:00.000Z',
        updatedAt: '2026-08-06T00:00:00.000Z',
      }),
    }) as jest.Mock;

    renderEditor('existing', 'diagram-ceiling');
    await waitFor(() => expect(screen.getByTestId('diagram-editor-readonly')).toBeInTheDocument());
    expect(screen.getByTestId('diagram-save-button')).toBeDisabled();
    expect(screen.getByTestId('diagram-editor-canvas')).toHaveAttribute('data-editable', 'false');
  });

  it('PBI-008 AC-0: view-only Back ignores pan/zoom dirty and does not prompt discard', async () => {
    const user = userEvent.setup();
    mockCan.mockImplementation((key: string) => key === 'diagram:view');
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        id: 'diagram-shared',
        projectId: 'project-a',
        ownerId: 'owner-2',
        ownerName: 'Owner Two',
        title: 'Shared View',
        scene: {
          elements: [{ id: 'a', type: 'rectangle' }],
          appState: { viewBackgroundColor: '#fff', scrollX: 0, scrollY: 0 },
          files: {},
        },
        thumbnail: 'data:image/png;base64,aaa',
        version: 1,
        effectiveAccess: 'view',
        createdAt: '2026-08-06T00:00:00.000Z',
        updatedAt: '2026-08-06T00:00:00.000Z',
      }),
    }) as jest.Mock;

    renderEditor('existing', 'diagram-shared');
    await waitFor(() => expect(screen.getByTestId('diagram-editor-readonly')).toBeInTheDocument());

    // View-only leave must never prompt discard (pan/zoom must not count as unsaved edits).
    await user.click(screen.getByTestId('diagram-editor-back'));
    expect(screen.queryByTestId('diagram-unsaved-dialog')).not.toBeInTheDocument();
    expect(mockNavigate).toHaveBeenCalledWith('/diagrams');
  });
});
