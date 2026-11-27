import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ProjectSkillLibraryPage from '../ProjectSkillLibraryPage';

let superAdmin = false;
jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: () => ({ can: () => true, isSuperAdmin: superAdmin }),
}));

const save = jest.fn();
const setTools = jest.fn();
let allowed: string[] = [];
const SKILL_CONTENT = [
  '---',
  'name: incident-notes',
  'description: "Look up an outage"',
  'playbook-capabilities: [azure-cli]',
  'metadata:',
  '  apex:',
  '    skill-type: autonomous',
  '---',
  '',
  'Read the catalog.',
  '',
].join('\n');

jest.mock('../../hooks/useProjectSkillLibrary', () => ({
  useProjectSkillLibrary: () => ({
    isPending: false,
    isError: false,
    data: {
      skills: [
        {
          id: 's1',
          name: 'incident-notes',
          description: 'Look up an outage',
          versions: [
            {
              id: 'v1',
              versionNumber: 1,
              status: 'published',
              skillType: 'autonomous',
              outputKind: null,
              content: SKILL_CONTENT,
              createdBy: 'author',
              createdAt: '2026-11-18T00:00:00.000Z',
              files: [],
            },
          ],
        },
      ],
    },
  }),
  useSaveProjectSkill: () => ({ mutateAsync: save, isPending: false }),
  useProjectSkillTools: () => ({
    data: {
      catalog: [{ id: 'azure-cli', label: 'Azure CLI', description: 'Run az commands.' }],
      allowed,
    },
  }),
  useSetProjectSkillTools: () => ({ mutate: setTools, isPending: false, isError: false }),
  useSkillDraftModels: () => ({ data: [] }),
  useGenerateProjectSkillDraft: () => ({ mutateAsync: jest.fn(), isPending: false }),
  extractSkillFileText: jest.fn(),
}));

function openEditorOnExistingSkill() {
  render(<ProjectSkillLibraryPage project="Apex" />);
  fireEvent.click(screen.getByTestId('skill-library-card-s1'));
  fireEvent.click(screen.getByTestId('skill-library-edit'));
}

beforeEach(() => {
  save.mockReset().mockResolvedValue(undefined);
  setTools.mockReset();
  allowed = ['azure-cli'];
  superAdmin = false;
});

describe('skill library shows the whole skill file', () => {
  it('lists the frontmatter in the version viewer', () => {
    render(<ProjectSkillLibraryPage project="Apex" />);
    fireEvent.click(screen.getByTestId('skill-library-card-s1'));
    const viewer = screen.getByTestId('skill-library-versions');
    expect(viewer).toHaveTextContent('playbook-capabilities: [azure-cli]');
    expect(viewer).toHaveTextContent('skill-type: autonomous');
  });

  it('opens the editor with the frontmatter in the file and the tool ticked', () => {
    openEditorOnExistingSkill();
    expect(screen.getByTestId('skill-library-body')).toHaveValue(SKILL_CONTENT);
    expect(screen.getByTestId('skill-library-tool-azure-cli')).toBeChecked();
  });

  it('writes a tool change into the file, and takes it out again', () => {
    openEditorOnExistingSkill();
    fireEvent.click(screen.getByTestId('skill-library-tool-azure-cli'));
    const file = () => (screen.getByTestId('skill-library-body') as HTMLTextAreaElement).value;
    expect(file()).not.toContain('playbook-capabilities');
    expect(screen.getByTestId('skill-library-tool-azure-cli')).not.toBeChecked();
    fireEvent.click(screen.getByTestId('skill-library-tool-azure-cli'));
    expect(file()).toContain('playbook-capabilities: [azure-cli]');
    expect(file()).toContain('Read the catalog.');
  });

  it('follows a hand edit of the file in the Description field', () => {
    openEditorOnExistingSkill();
    fireEvent.change(screen.getByTestId('skill-library-body'), {
      target: { value: SKILL_CONTENT.replace('Look up an outage', 'Hand edited') },
    });
    expect(screen.getByTestId('skill-library-description')).toHaveValue('Hand edited');
  });

  it('saves the file as shown, with the name taken from the title', async () => {
    openEditorOnExistingSkill();
    fireEvent.change(screen.getByTestId('skill-library-description'), { target: { value: 'New words' } });
    fireEvent.click(screen.getByTestId('skill-library-save'));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const sent = save.mock.calls[0][0].content as string;
    expect(sent).toContain('name: incident-notes');
    expect(sent).toContain('description: "New words"');
    expect(sent).toContain('playbook-capabilities: [azure-cli]');
    expect(sent).toContain('Read the catalog.');
  });

  it('refuses to save when the type line was deleted by hand', async () => {
    openEditorOnExistingSkill();
    fireEvent.change(screen.getByTestId('skill-library-body'), {
      target: { value: SKILL_CONTENT.replace('metadata:\n  apex:\n    skill-type: autonomous\n', '') },
    });
    fireEvent.click(screen.getByTestId('skill-library-save'));
    expect(await screen.findByText(/needs a type/)).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });
});

describe('tools a project allows', () => {
  it('disables a tool the project has not allowed on a skill that does not use it', () => {
    allowed = [];
    render(<ProjectSkillLibraryPage project="Apex" />);
    fireEvent.click(screen.getAllByTestId('skill-library-write')[0]);
    expect(screen.getByTestId('skill-library-tool-azure-cli')).toBeDisabled();
    expect(screen.getByTestId('skill-library-tools')).toHaveTextContent('Not enabled for Apex');
  });

  it('shows the allow-list panel to a platform admin only', () => {
    render(<ProjectSkillLibraryPage project="Apex" />);
    expect(screen.queryByTestId('skill-library-tool-allow-list')).not.toBeInTheDocument();
  });

  it('lets a platform admin turn a tool off', () => {
    superAdmin = true;
    render(<ProjectSkillLibraryPage project="Apex" />);
    fireEvent.click(screen.getByTestId('skill-library-allow-azure-cli'));
    expect(setTools).toHaveBeenCalledWith([]);
  });

  it('lets a platform admin turn a tool on', () => {
    superAdmin = true;
    allowed = [];
    render(<ProjectSkillLibraryPage project="Apex" />);
    fireEvent.click(screen.getByTestId('skill-library-allow-azure-cli'));
    expect(setTools).toHaveBeenCalledWith(['azure-cli']);
  });
});
