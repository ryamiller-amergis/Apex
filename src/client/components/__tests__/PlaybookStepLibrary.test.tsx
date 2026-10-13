import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { PlaybookStepTypePaletteItem } from '../../../shared/types/playbook';
import { PlaybookStepLibrary } from '../PlaybookStepLibrary';

function item(stepType: string): PlaybookStepTypePaletteItem {
  return {
    stepType,
    label: stepType,
    sideEffect: 'read',
    requiredPermissions: ['playbooks:view'],
    inputJsonSchema: {},
    outputJsonSchema: {},
    canSuspend: false,
  };
}

const ITEMS = ['cursor-agent', 'ingest-artifact', 'branch', 'approval-gate', 'notify', 'interview'].map(item);

function renderLibrary(usage: Record<string, number> = {}, onAdd = jest.fn()) {
  render(
    <PlaybookStepLibrary
      items={ITEMS}
      usage={usage}
      canAuthor
      collapsed={false}
      onToggleCollapsed={jest.fn()}
      onAdd={onAdd}
    />,
  );
  return onAdd;
}

describe('PlaybookStepLibrary', () => {
  it('shows the default three most used steps before any usage is recorded', () => {
    renderLibrary();
    expect(screen.getByTestId('playbook-palette-top-cursor-agent')).toBeInTheDocument();
    expect(screen.getByTestId('playbook-palette-top-approval-gate')).toBeInTheDocument();
    expect(screen.getByTestId('playbook-palette-top-notify')).toBeInTheDocument();
    expect(screen.queryByTestId('playbook-palette-top-branch')).not.toBeInTheDocument();
  });

  it('ranks most used steps by recorded usage', () => {
    renderLibrary({ branch: 5, interview: 3 });
    const popular = screen.getByRole('region', { name: 'Most used' });
    const tiles = within(popular).getAllByRole('button').map((tile) => tile.getAttribute('data-testid'));
    expect(tiles).toEqual([
      'playbook-palette-top-branch',
      'playbook-palette-top-interview',
      'playbook-palette-top-cursor-agent',
    ]);
  });

  it('filters by title or description and says when nothing matches', async () => {
    renderLibrary();
    const search = screen.getByTestId('playbook-library-search');
    await userEvent.type(search, 'approve');
    expect(screen.getByTestId('playbook-palette-approval-gate')).toBeInTheDocument();
    expect(screen.queryByTestId('playbook-palette-notify')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Most used' })).not.toBeInTheDocument();

    await userEvent.clear(search);
    await userEvent.type(search, 'zzz');
    expect(screen.getByTestId('playbook-library-empty')).toBeInTheDocument();
  });

  it('adds a step on click', async () => {
    const onAdd = renderLibrary();
    await userEvent.click(screen.getByTestId('playbook-palette-notify'));
    expect(onAdd).toHaveBeenCalledWith('notify');
  });
});
