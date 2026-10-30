import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BrainstormCitationDto, BrainstormSourceDto } from '../../../shared/types/brainstormSources';
import type { BrainstormSessionDetail } from '../../../shared/types/brainstorm';
import { BrainstormCitationChip } from '../BrainstormCitationChip';
import { BrainstormEndSessionDialog } from '../BrainstormEndSessionDialog';
import { BrainstormSourcesPanel } from '../BrainstormSourcesPanel';
import { BrainstormSourceRow, sourceStatusText } from '../BrainstormSourceRow';
import { sourceIsTransitional } from '../../hooks/useBrainstormSources';

const source = (overrides: Partial<BrainstormSourceDto>): BrainstormSourceDto => ({
  id: 'src-1',
  sessionId: 's-1',
  kind: 'project-repository',
  displayName: 'Apex',
  cloneUrl: null,
  requestedRevision: null,
  commitSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
  state: 'ready',
  reasonCode: null,
  reasonText: null,
  sizeBytes: 10,
  mcpReadOnlyToolCount: null,
  updatedAt: '2026-10-29T12:00:00.000Z',
  ...overrides,
});

const session: BrainstormSessionDetail = {
  id: 's-1',
  title: 'Ideas',
  creatorId: 'creator',
  creatorName: 'Ada',
  state: 'active',
  model: 'm',
  artifactType: null,
  lastActivityAt: '2026-10-29T12:00:00.000Z',
  createdAt: '2026-10-29T12:00:00.000Z',
  canMutate: false,
  threadId: 't-1',
  version: 1,
  failureReason: null,
};

function renderPanel(current = session, rows: BrainstormSourceDto[] = []) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    text: async () => JSON.stringify(rows),
  }) as jest.Mock;
  return render(
    <QueryClientProvider client={client}>
      <BrainstormSourcesPanel project="Apex" session={current} />
    </QueryClientProvider>,
  );
}

describe('Brainstorm sources UI — PBI-005 / PBI-008 / PBI-010', () => {
  it('PBI-010 derived: a member sees Not loaded (idle) and no add button', async () => {
    const idle = source({ state: 'cleaned', commitSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678' });
    renderPanel(session, [idle]);
    expect(await screen.findByTestId('brainstorm-source-status-src-1')).toHaveTextContent('Not loaded (idle)');
    expect(screen.queryByTestId('brainstorm-add-source-button')).not.toBeInTheDocument();
    expect(sourceStatusText(idle, true)).toMatch(/re-clone/);
  });

  it('shows a busy marker while a saved clone is copying', () => {
    render(
      <BrainstormSourceRow
        source={source({ state: 'preparing', commitSha: null })}
        canMutate
        removing={false}
        onRemove={jest.fn()}
      />,
    );
    expect(screen.getByTestId('brainstorm-source-busy-src-1')).toBeInTheDocument();
    expect(screen.getByTestId('brainstorm-source-status-src-1')).toHaveTextContent('Copying the saved clone');
  });

  it('PBI-005 (b): a failed clone shows the failure text', () => {
    expect(sourceStatusText(source({ state: 'failed', reasonText: 'The repository could not be reached.', commitSha: null }), true))
      .toBe('The repository could not be reached.');
    expect(sourceIsTransitional(source({ state: 'preparing' }))).toBe(true);
    expect(sourceIsTransitional(source({ state: 'ready' }))).toBe(false);
  });

  it('PBI-008 (a): a citation chip exposes the claim from the keyboard', () => {
    const citation: BrainstormCitationDto = {
      id: 'cite-1',
      messageId: 'm-1',
      sourceKind: 'project-repository',
      sourceName: 'Apex',
      path: 'src/a.ts',
      mcpServerName: null,
      mcpToolId: null,
      revision: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      claim: 'The module exports a',
      createdAt: '2026-10-29T12:00:00.000Z',
    };
    render(<BrainstormCitationChip citation={citation} />);
    const chip = screen.getByTestId('brainstorm-citation-chip-cite-1');
    expect(chip).toHaveTextContent('src/a.ts');
    fireEvent.click(chip);
    expect(screen.getByTestId('brainstorm-citation-popover')).toHaveTextContent('The module exports a');
  });

  it('PBI-009 (a): the end dialog states that clones go and the chat stays', () => {
    const onConfirm = jest.fn();
    render(<BrainstormEndSessionDialog open pending={false} error={null} onCancel={jest.fn()} onConfirm={onConfirm} />);
    expect(screen.getByTestId('brainstorm-end-session-dialog')).toHaveTextContent('Clones are deleted now');
    fireEvent.click(screen.getByTestId('brainstorm-end-session-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('lists default-attached project repositories and MCP servers when no explicit sources are attached', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    global.fetch = jest.fn(async (url: string) => {
      if (url.includes('/sources/options')) {
        return {
          ok: true,
          text: async () => JSON.stringify({
            repositories: [
              {
                skillSettingsId: 'skill-1',
                displayName: 'Apex Repo',
                ready: true,
                readinessText: 'Ready to attach',
                alreadyAttached: false,
              },
            ],
            catalog: [
              {
                skillSettingsId: 'cat-1',
                displayName: 'MatterWorx',
                ready: true,
                readinessText: 'Ready to attach',
                alreadyAttached: false,
              },
            ],
            mcpServers: [
              {
                connectionId: 'mcp-1',
                displayName: 'Clerk Directory',
                readOnlyToolCount: 4,
                alreadyAttached: false,
              },
            ],
            mcpEnabled: true,
            limits: { maxWorkspaceBytes: 5_000_000_000, maxConcurrentClones: 3 },
          }),
        };
      }
      return {
        ok: true,
        text: async () => JSON.stringify([]),
      };
    }) as jest.Mock;

    render(
      <QueryClientProvider client={client}>
        <BrainstormSourcesPanel project="Apex" session={{ ...session, canMutate: true }} />
      </QueryClientProvider>,
    );

    expect(await screen.findByTestId('brainstorm-default-sources-list')).toBeInTheDocument();
    expect(screen.getByTestId('brainstorm-default-source-repo-cat-1')).toHaveTextContent('MatterWorx');
    expect(screen.getByTestId('brainstorm-default-source-repo-skill-1')).toHaveTextContent('Apex Repo');
    expect(screen.getByTestId('brainstorm-default-source-mcp-mcp-1')).toHaveTextContent('Clerk Directory');
  });
});
