import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import ProjectSkillLibraryPage from '../ProjectSkillLibraryPage';

jest.mock('../../hooks/useAppShell', () => ({
  useAppShell: () => ({ can: () => true }),
}));

const generate = jest.fn();
jest.mock('../../hooks/useProjectSkillLibrary', () => ({
  useProjectSkillLibrary: () => ({ isPending: false, isError: false, data: { skills: [] } }),
  useSaveProjectSkill: () => ({ mutateAsync: jest.fn(), isPending: false }),
  useProjectSkillTools: () => ({ data: { catalog: [], allowed: [] } }),
  useSetProjectSkillTools: () => ({ mutate: jest.fn(), isPending: false, isError: false }),
  useSkillDraftModels: () => ({ data: [] }),
  useGenerateProjectSkillDraft: () => ({ mutateAsync: generate, isPending: false }),
  extractSkillFileText: jest.fn(),
}));

function openEditor() {
  render(<ProjectSkillLibraryPage project="Apex" />);
  // The header and the empty state each offer the button.
  fireEvent.click(screen.getAllByTestId('skill-library-write')[0]);
}

function fill(title: string, request: string) {
  fireEvent.change(screen.getByTestId('skill-library-title'), { target: { value: title } });
  fireEvent.change(screen.getByTestId('skill-library-ai-request'), { target: { value: request } });
}

beforeEach(() => generate.mockReset());

describe('Draft with AI errors', () => {
  it('shows a failed draft inside the AI panel, with a heading and the reason', async () => {
    generate.mockRejectedValue(new Error('The AI answered in a form Apex could not read.'));
    openEditor();
    fill('Release notes', 'Write notes from merged PRs');
    fireEvent.click(screen.getByTestId('skill-library-ai-generate'));

    const alert = await screen.findByTestId('skill-library-ai-error');
    expect(alert).toHaveAttribute('role', 'alert');
    expect(alert).toHaveTextContent('Could not draft the skill');
    expect(alert).toHaveTextContent('could not read');
    expect(alert.closest('section')).toContainElement(screen.getByTestId('skill-library-ai-generate'));
  });

  it('explains a missing title or request in the same place', () => {
    openEditor();
    fireEvent.click(screen.getByTestId('skill-library-ai-generate'));
    expect(screen.getByTestId('skill-library-ai-error')).toHaveTextContent('Give the skill a title');

    fireEvent.change(screen.getByTestId('skill-library-title'), { target: { value: 'Notes' } });
    fireEvent.click(screen.getByTestId('skill-library-ai-generate'));
    expect(screen.getByTestId('skill-library-ai-error')).toHaveTextContent('Say what the skill should do');
    expect(generate).not.toHaveBeenCalled();
  });

  it('can be dismissed, and clears when the next attempt succeeds', async () => {
    generate.mockRejectedValueOnce(new Error('Try again'));
    openEditor();
    fill('Release notes', 'Write notes');
    fireEvent.click(screen.getByTestId('skill-library-ai-generate'));
    await screen.findByTestId('skill-library-ai-error');

    fireEvent.click(screen.getByTestId('skill-library-ai-error-dismiss'));
    expect(screen.queryByTestId('skill-library-ai-error')).not.toBeInTheDocument();

    generate.mockRejectedValueOnce(new Error('Again'));
    fireEvent.click(screen.getByTestId('skill-library-ai-generate'));
    await screen.findByTestId('skill-library-ai-error');

    generate.mockResolvedValueOnce({ description: 'd', instructions: 'i' });
    fireEvent.click(screen.getByTestId('skill-library-ai-generate'));
    await waitFor(() => expect(screen.queryByTestId('skill-library-ai-error')).not.toBeInTheDocument());
    expect(screen.getByTestId('skill-library-description')).toHaveValue('d');
  });

  it('does not put the draft error in the save error line', async () => {
    generate.mockRejectedValue(new Error('Boom'));
    openEditor();
    fill('Release notes', 'Write notes');
    fireEvent.click(screen.getByTestId('skill-library-ai-generate'));
    const alert = await screen.findByTestId('skill-library-ai-error');
    const form = screen.getByTestId('skill-library-form');
    expect(within(form).getAllByRole('alert')).toEqual([alert]);
  });
});
