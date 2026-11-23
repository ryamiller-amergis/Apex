import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PlaybookTemplateSummary } from '../../../shared/types/playbookTemplates';
import { PlaybookTemplateGallery } from '../PlaybookTemplateGallery';

let isSuperAdmin = false;
jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: () => ({ isSuperAdmin }),
}));

const installMutate = jest.fn();
const removeMutate = jest.fn();
let templatesState: {
  isPending: boolean;
  isError: boolean;
  error?: Error;
  data?: { templates: PlaybookTemplateSummary[] };
};
jest.mock('../../hooks/usePlaybookTemplates', () => ({
  usePlaybookTemplates: () => templatesState,
  useInstallPlaybookTemplate: () => ({
    mutateAsync: installMutate,
    isPending: false,
    isError: false,
  }),
  useRemoveSharedPlaybookTemplate: () => ({
    mutateAsync: removeMutate,
    isPending: false,
    isError: false,
    reset: jest.fn(),
  }),
}));

function template(overrides: Partial<PlaybookTemplateSummary>): PlaybookTemplateSummary {
  return {
    templateKey: 'core-interview',
    templateVersion: 1,
    displayName: 'Core interview',
    summary: 'One human-led interview.',
    category: 'interview',
    tags: [],
    graphFile: 'interview.json',
    requiredFlags: [],
    requiredPermissions: ['playbooks:author'],
    installPolicy: 'one-per-project',
    installState: 'not-installed',
    installedDefinitionId: null,
    installedTemplateVersion: null,
    stepSummary: ['interview', 'notify'],
    source: 'shipped',
    ...overrides,
  };
}

const SHARED = template({
  templateKey: 'shared:abc',
  displayName: 'Team review',
  summary: 'Shared flow',
  category: 'shared',
  installPolicy: 'multiple',
  source: 'shared',
  sharedByName: 'Pat Admin',
  sharedAt: '2026-11-20T00:00:00.000Z',
  sourceProject: 'Project A',
  stepSummary: ['cursor-agent'],
});

function renderGallery(props: { canAuthor?: boolean; onInstalled?: (id: string) => void } = {}) {
  return render(
    <PlaybookTemplateGallery
      project="Project B"
      canAuthor={props.canAuthor ?? true}
      onInstalled={props.onInstalled ?? jest.fn()}
      onClose={jest.fn()}
    />,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  isSuperAdmin = false;
  templatesState = {
    isPending: false,
    isError: false,
    data: { templates: [template({}), SHARED] },
  };
});

describe('PlaybookTemplateGallery', () => {
  it('groups built-in and shared templates under their own headings', () => {
    renderGallery();
    expect(screen.getByText('Built in')).toBeInTheDocument();
    expect(screen.getByTestId('playbook-template-shared-heading')).toBeInTheDocument();
    expect(screen.getByTestId('playbook-template-core-interview')).toBeInTheDocument();
    expect(screen.getByTestId('playbook-template-shared:abc')).toHaveAttribute('data-source', 'shared');
  });

  it('omits the shared heading when nothing is shared', () => {
    templatesState = { isPending: false, isError: false, data: { templates: [template({})] } };
    renderGallery();
    expect(screen.queryByTestId('playbook-template-shared-heading')).not.toBeInTheDocument();
  });

  it('shows who shared a template and where it came from', () => {
    renderGallery();
    const card = screen.getByTestId('playbook-template-shared:abc');
    expect(card).toHaveTextContent('by Pat Admin');
    expect(card).toHaveTextContent('from Project A');
  });

  it('creates a copy and opens it when a template is used', async () => {
    installMutate.mockResolvedValue({ definition: { id: 'new-def' } });
    const onInstalled = jest.fn();
    renderGallery({ onInstalled });
    fireEvent.click(screen.getByTestId('playbook-template-install-shared:abc'));
    await waitFor(() => expect(onInstalled).toHaveBeenCalledWith('new-def'));
    expect(installMutate).toHaveBeenCalledWith('shared:abc');
  });

  it('keeps working after an install fails', async () => {
    installMutate.mockRejectedValue(new Error('nope'));
    const onInstalled = jest.fn();
    renderGallery({ onInstalled });
    fireEvent.click(screen.getByTestId('playbook-template-install-core-interview'));
    await waitFor(() => expect(installMutate).toHaveBeenCalled());
    expect(onInstalled).not.toHaveBeenCalled();
    expect(screen.getByTestId('playbook-template-install-core-interview')).toBeEnabled();
  });

  it('hides the use button without playbooks:author', () => {
    renderGallery({ canAuthor: false });
    expect(screen.queryByTestId('playbook-template-install-core-interview')).not.toBeInTheDocument();
    expect(screen.queryByTestId('playbook-template-install-shared:abc')).not.toBeInTheDocument();
  });

  it('labels an installed draft as one to open and hides installed or updatable shipped templates', () => {
    templatesState = {
      isPending: false,
      isError: false,
      data: {
        templates: [
          template({ templateKey: 'a', installState: 'draft-only' }),
          template({ templateKey: 'b', installState: 'published' }),
          template({ templateKey: 'c', installState: 'update-available' }),
        ],
      },
    };
    renderGallery();
    expect(screen.getByTestId('playbook-template-install-a')).toHaveTextContent('Open draft');
    expect(screen.queryByTestId('playbook-template-install-b')).not.toBeInTheDocument();
    expect(screen.queryByTestId('playbook-template-install-c')).not.toBeInTheDocument();
    expect(screen.getByTestId('playbook-template-state-b')).toHaveTextContent('Published in this project');
    expect(screen.getByText(/review and apply this update/)).toBeInTheDocument();
  });

  it('shows Remove on shared templates only to platform admins', () => {
    renderGallery();
    expect(screen.queryByTestId('playbook-template-remove-shared:abc')).not.toBeInTheDocument();
  });

  it('never offers Remove on a built-in template', () => {
    isSuperAdmin = true;
    renderGallery();
    expect(screen.queryByTestId('playbook-template-remove-core-interview')).not.toBeInTheDocument();
    expect(screen.getByTestId('playbook-template-remove-shared:abc')).toBeInTheDocument();
  });

  it('asks before removing, then removes the shared template', async () => {
    isSuperAdmin = true;
    removeMutate.mockResolvedValue(undefined);
    renderGallery();
    fireEvent.click(screen.getByTestId('playbook-template-remove-shared:abc'));
    expect(removeMutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('playbook-template-remove-confirm-shared:abc'));
    await waitFor(() => expect(removeMutate).toHaveBeenCalledWith('shared:abc'));
  });

  it('can back out of a removal', () => {
    isSuperAdmin = true;
    renderGallery();
    fireEvent.click(screen.getByTestId('playbook-template-remove-shared:abc'));
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(removeMutate).not.toHaveBeenCalled();
    expect(screen.getByTestId('playbook-template-remove-shared:abc')).toBeInTheDocument();
  });

  it('summarises long step lists and shows an error', () => {
    templatesState = {
      isPending: false,
      isError: false,
      data: {
        templates: [
          template({ stepSummary: ['notify', 'notify', 'notify', 'notify', 'notify', 'notify', 'notify', 'notify'] }),
        ],
      },
    };
    renderGallery();
    expect(screen.getByText('+2')).toBeInTheDocument();
  });

  it('shows a load error', () => {
    templatesState = { isPending: false, isError: true, error: new Error('Boom') };
    renderGallery();
    expect(screen.getByRole('alert')).toHaveTextContent('Boom');
  });
});
