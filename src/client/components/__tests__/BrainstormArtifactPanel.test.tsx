import type { ReactNode } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrainstormArtifactPanel, ARTIFACT_EMPTY_TEXT } from '../BrainstormArtifactPanel';
import { BrainstormSuggestionChips } from '../BrainstormSuggestionChips';
import { useBrainstormArtifact, useSwitchArtifactType } from '../../hooks/useBrainstormArtifact';
import { useBrainstormActions, useKeepStandalone } from '../../hooks/useBrainstormActions';
import type { BrainstormSessionDetail } from '../../../shared/types/brainstorm';
import type { BrainstormActionsDto, BrainstormArtifactDto } from '../../../shared/types/brainstormArtifact';

const markdownProps: Array<Record<string, unknown>> = [];

jest.mock('react-markdown', () => ({
  __esModule: true,
  default: (props: { children: ReactNode } & Record<string, unknown>) => {
    markdownProps.push(props);
    return <div {...{ 'data-testid': 'markdown' }}>{props.children}</div>;
  },
}));
jest.mock('remark-gfm', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../../hooks/useBrainstormArtifact', () => {
  const actual = jest.requireActual('../../hooks/useBrainstormArtifact');
  return {
    brainstormArtifactKeys: actual.brainstormArtifactKeys,
    useBrainstormArtifact: jest.fn(),
    useSwitchArtifactType: jest.fn(),
    useLabelCheckpoint: () => ({ mutateAsync: jest.fn(), isPending: false }),
    useBrainstormVersions: () => ({ data: { versions: [], nextCursor: null }, isSuccess: true }),
    useBrainstormCompare: () => ({ data: undefined }),
    useRollbackArtifact: () => ({ mutateAsync: jest.fn(), isPending: false }),
  };
});
jest.mock('../../hooks/useBrainstormActions', () => ({
  useBrainstormActions: jest.fn(),
  useKeepStandalone: jest.fn(),
  usePreviewHandoff: () => ({ mutate: jest.fn(), isPending: true, isIdle: false }),
  useConfirmHandoff: () => ({ mutate: jest.fn(), isPending: false }),
}));

const artifactHook = useBrainstormArtifact as jest.Mock;
const switchHook = useSwitchArtifactType as jest.Mock;
const actionsHook = useBrainstormActions as jest.Mock;
const keepHook = useKeepStandalone as jest.Mock;

const session: BrainstormSessionDetail = {
  id: 's-1',
  title: 'Auth ideas',
  creatorId: 'creator',
  creatorName: 'Ada',
  state: 'active',
  model: 'm',
  artifactType: 'adr',
  lastActivityAt: '2026-10-29T10:00:00.000Z',
  createdAt: '2026-10-29T10:00:00.000Z',
  canMutate: true,
  threadId: 't-1',
  version: 1,
  failureReason: null,
};

function artifact(overrides: Partial<BrainstormArtifactDto> = {}): BrainstormArtifactDto {
  return {
    id: 'art-1',
    sessionId: 's-1',
    type: 'adr',
    markdown: '# Use OIDC\n\n## Context\n\nCookies.',
    version: 2,
    updatedAt: '2026-10-29T10:00:00.000Z',
    lastOrigin: 'ai_change',
    lastChangeFailure: null,
    ...overrides,
  };
}

const actions: BrainstormActionsDto = {
  artifactVersion: 2,
  viewerCanAct: true,
  handoffs: [],
  actions: [
    {
      id: 'create-adr',
      kind: 'create_direct',
      targetModule: 'adr',
      label: 'Create an ADR',
      description: 'Create a Proposed ADR from this artifact.',
      state: 'unavailable',
      reasons: [{ code: 'MISSING_INFORMATION', text: 'Add a Decision Outcome section.' }],
      missingInformation: ['Decision Outcome'],
      handoffId: null,
      resultRef: null,
    },
    {
      id: 'keep-standalone',
      kind: 'keep_standalone',
      targetModule: 'standalone',
      label: 'Keep as a standalone artifact',
      description: 'Keep it in Brainstorm.',
      state: 'available',
      reasons: [],
      missingInformation: [],
      handoffId: null,
      resultRef: null,
    },
  ],
};

function query<T>(data: T | undefined, extra: Record<string, unknown> = {}) {
  return { data, isLoading: false, isError: false, isFetching: false, isSuccess: data !== undefined, refetch: jest.fn(), ...extra };
}

function renderPanel(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
  return {
    ...view,
    rerenderPanel: (next: ReactNode) => view.rerender(
      <QueryClientProvider client={client}>
        <MemoryRouter>{next}</MemoryRouter>
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  markdownProps.length = 0;
  switchHook.mockReturnValue({ mutateAsync: jest.fn().mockResolvedValue({ kind: 'reshaping' }), isPending: false });
  actionsHook.mockReturnValue(query(actions));
  keepHook.mockReturnValue({ mutate: jest.fn(), isPending: false });
});

describe('BrainstormArtifactPanel', () => {
  it('VT-06: a new version replaces the body in place and is announced politely', () => {
    artifactHook.mockReturnValue(query(artifact()));
    const view = renderPanel(<BrainstormArtifactPanel project="Apex" session={session} turnRunning />);
    expect(screen.getByTestId('brainstorm-artifact-body')).toHaveTextContent('Cookies.');

    artifactHook.mockReturnValue(query(artifact({ version: 3, markdown: '# Use OIDC\n\n## Context\n\nTokens.' })));
    view.rerenderPanel(<BrainstormArtifactPanel project="Apex" session={session} turnRunning={false} />);

    expect(screen.getByTestId('brainstorm-artifact-body')).toHaveTextContent('Tokens.');
    const live = screen.getByTestId('brainstorm-artifact-live');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toHaveTextContent('Artifact updated to version 3');
    expect(screen.getByRole('region', { name: 'Artifact' })).toBeInTheDocument();
  });

  it('VT-07: renders without raw HTML support', () => {
    artifactHook.mockReturnValue(query(artifact({ markdown: '<script>alert(1)</script><img src=x onerror="alert(1)">\n\n# Title' })));
    const { container } = renderPanel(<BrainstormArtifactPanel project="Apex" session={session} turnRunning={false} />);

    const props = markdownProps[markdownProps.length - 1];
    expect(props.skipHtml).toBe(true);
    expect(props.rehypePlugins).toBeUndefined();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
  });

  it('shows the empty state when the artifact has no content and hides the checkpoint field on an empty version', () => {
    artifactHook.mockReturnValue(query(artifact({
      version: 1,
      markdown: '',
      type: 'technical_design',
      id: 'art-1',
      checkpointName: 'Type set: Technical design',
    })));
    renderPanel(<BrainstormArtifactPanel project="Apex" session={session} turnRunning={false} />);

    expect(screen.getByTestId('brainstorm-artifact-empty')).toHaveTextContent(ARTIFACT_EMPTY_TEXT);
    expect(screen.getByTestId('brainstorm-next-actions')).toHaveTextContent('Next actions appear once the artifact has content');
    expect(screen.getByTestId('brainstorm-artifact-type-badge')).toHaveTextContent('Technical design');
    expect(screen.queryByTestId('brainstorm-checkpoint-input')).not.toBeInTheDocument();
  });

  it('shows Explore in the format badge when no artifact type has been selected yet', () => {
    artifactHook.mockReturnValue(query(artifact({ version: 0, markdown: '', type: null, id: null })));
    renderPanel(<BrainstormArtifactPanel project="Apex" session={session} turnRunning={false} />);

    expect(screen.getByTestId('brainstorm-artifact-type-badge')).toHaveTextContent('Explore');
  });

  it('shows the saved checkpoint badge when the current version already has a name', () => {
    artifactHook.mockReturnValue(query(artifact({ version: 2, checkpointName: 'Initial draft' })));
    renderPanel(<BrainstormArtifactPanel project="Apex" session={session} turnRunning={false} />);

    expect(screen.getByTestId('brainstorm-checkpoint-saved')).toHaveTextContent('Initial draft');
    expect(screen.queryByTestId('brainstorm-checkpoint-input')).not.toBeInTheDocument();
  });

  it('opens the full-screen artifact reader modal and closes on Escape', () => {
    artifactHook.mockReturnValue(query(artifact({ version: 3, markdown: '# Discovery Brief\n\nSummary paragraph.' })));
    renderPanel(<BrainstormArtifactPanel project="Apex" session={session} turnRunning={false} />);

    fireEvent.click(screen.getByTestId('brainstorm-artifact-reader-open'));
    expect(screen.getByTestId('brainstorm-artifact-reader-modal')).toBeInTheDocument();
    expect(screen.getByTestId('brainstorm-artifact-reader-body')).toHaveTextContent('Summary paragraph.');

    fireEvent.keyDown(screen.getByTestId('brainstorm-artifact-reader-modal'), { key: 'Escape' });
    expect(screen.queryByTestId('brainstorm-artifact-reader-modal')).not.toBeInTheDocument();
  });

  it('announces the new type when a new version updates the artifact type', () => {
    artifactHook.mockReturnValue(query(artifact()));
    const view = renderPanel(<BrainstormArtifactPanel project="Apex" session={session} turnRunning={false} />);
    expect(screen.getByTestId('brainstorm-artifact-type-badge')).toHaveTextContent('ADR');

    artifactHook.mockReturnValue(query(artifact({ version: 4, type: 'technical_design' })));
    view.rerenderPanel(<BrainstormArtifactPanel project="Apex" session={session} turnRunning={false} />);
    expect(screen.getByTestId('brainstorm-artifact-type-badge')).toHaveTextContent('Technical design');
    expect(screen.getByTestId('brainstorm-artifact-live')).toHaveTextContent('Type is now');
  });

  it('VT-29: a failed load shows an error with Retry that refetches', () => {
    const refetch = jest.fn();
    artifactHook.mockReturnValue(query(undefined, { isError: true, refetch }));
    renderPanel(<BrainstormArtifactPanel project="Apex" session={session} turnRunning={false} />);

    expect(screen.getByTestId('brainstorm-artifact-error')).toHaveAttribute('role', 'alert');
    fireEvent.click(screen.getByTestId('brainstorm-artifact-retry'));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('shows the last failed change from the collaborator', () => {
    artifactHook.mockReturnValue(query(artifact({
      lastChangeFailure: { code: 'ARTIFACT_TOO_LARGE', summary: 'The artifact is too large. The change was not applied.', at: '2026-10-29T10:00:00.000Z' },
    })));
    renderPanel(<BrainstormArtifactPanel project="Apex" session={session} turnRunning={false} />);
    expect(screen.getByTestId('brainstorm-artifact-change-failure')).toHaveTextContent('The artifact is too large');
  });

  it('a non-creator reads the artifact with no mutating control', () => {
    artifactHook.mockReturnValue(query(artifact()));
    actionsHook.mockReturnValue(query({ ...actions, viewerCanAct: false, actions: [] }));
    renderPanel(<BrainstormArtifactPanel project="Apex" session={{ ...session, canMutate: false }} turnRunning={false} />);

    expect(screen.getByTestId('brainstorm-readonly-notice')).toBeInTheDocument();
    expect(screen.getByTestId('brainstorm-artifact-type-badge')).toHaveTextContent('ADR');
    expect(screen.queryByTestId('brainstorm-checkpoint-input')).not.toBeInTheDocument();
    expect(screen.queryByTestId('brainstorm-action-create-adr')).not.toBeInTheDocument();
  });
});

describe('Next actions and chips (VT-26)', () => {
  it('chips list the same available actions as the panel; an unavailable action shows its reason', () => {
    artifactHook.mockReturnValue(query(artifact()));
    renderPanel(
      <>
        <BrainstormArtifactPanel project="Apex" session={session} turnRunning={false} />
        <BrainstormSuggestionChips project="Apex" sessionId="s-1" onSelect={jest.fn()} />
      </>,
    );

    const panel = screen.getByTestId('brainstorm-next-actions');
    const availableInPanel = within(panel)
      .getAllByRole('button')
      .filter((button) => button.getAttribute('aria-disabled') !== 'true')
      .map((button) => button.closest('li')?.getAttribute('data-testid')?.replace('brainstorm-action-', ''));
    const chipIds = screen
      .getAllByTestId(/^brainstorm-suggestion-chip-/)
      .map((chip) => chip.getAttribute('data-testid')?.replace('brainstorm-suggestion-chip-', ''));
    expect(chipIds).toEqual(availableInPanel);
    expect(chipIds).toEqual(['keep-standalone']);

    expect(screen.getByTestId('brainstorm-action-reason-create-adr')).toHaveTextContent('Add a Decision Outcome section.');
    const adrButton = screen.getByTestId('brainstorm-action-start-create-adr');
    expect(adrButton).toHaveAttribute('aria-disabled', 'true');
    expect(adrButton).toHaveAccessibleDescription('Add a Decision Outcome section.');
  });

  it('keep as standalone posts the current version', () => {
    const mutate = jest.fn();
    keepHook.mockReturnValue({ mutate, isPending: false });
    artifactHook.mockReturnValue(query(artifact()));
    renderPanel(<BrainstormArtifactPanel project="Apex" session={session} turnRunning={false} />);

    fireEvent.click(screen.getByTestId('brainstorm-action-start-keep-standalone'));
    expect(mutate).toHaveBeenCalledWith({ expectedVersion: 2 }, expect.any(Object));
  });

  it('a chip request opens the action from the panel', () => {
    const mutate = jest.fn();
    keepHook.mockReturnValue({ mutate, isPending: false });
    artifactHook.mockReturnValue(query(artifact()));
    const view = renderPanel(<BrainstormArtifactPanel project="Apex" session={session} turnRunning={false} actionRequest={null} />);
    view.rerenderPanel(
      <BrainstormArtifactPanel project="Apex" session={session} turnRunning={false} actionRequest={{ actionId: 'keep-standalone', nonce: 1 }} />,
    );
    expect(mutate).toHaveBeenCalledTimes(1);
  });
});
