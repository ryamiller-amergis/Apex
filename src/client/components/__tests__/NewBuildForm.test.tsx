import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { NewBuildForm } from '../NewBuildForm';
import { BuildApiError, useBuildRepositories, useStartBuild } from '../../hooks/useBuilds';
import { useAvailableModels } from '../../hooks/useProjectSkillConfig';

jest.mock('../../hooks/useBuilds', () => ({
  BuildApiError: class BuildApiError extends Error {
    status = 409;
    code?: string;
    refusals: string[] = [];
    constructor(status: number, message: string, code?: string, refusals: string[] = []) {
      super(message);
      this.status = status;
      this.code = code;
      this.refusals = refusals;
    }
  },
  useBuildRepositories: jest.fn(),
  useStartBuild: jest.fn(),
}));
jest.mock('../../hooks/useProjectSkillConfig', () => ({ useAvailableModels: jest.fn() }));

const repositories = useBuildRepositories as jest.Mock;
const startBuild = useStartBuild as jest.Mock;
const models = useAvailableModels as jest.Mock;

function renderForm() {
  const Probe = () => {
    const location = useLocation();
    const notice = (location.state as { notice?: string } | null)?.notice ?? '';
    return <div {...{ 'data-testid': 'location' }}>{`${location.pathname}|${notice}`}</div>;
  };
  return render(
    <MemoryRouter initialEntries={['/builds/new']}>
      <Routes>
        <Route path="*" element={<><NewBuildForm project="Apex" /><Probe /></>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('NewBuildForm (VT-04, VT-36)', () => {
  const mutateAsync = jest.fn();

  beforeEach(() => {
    mutateAsync.mockReset();
    repositories.mockReturnValue({
      isLoading: false,
      isSuccess: true,
      data: { repositories: [{ repository: 'apex', label: 'Apex' }] },
    });
    models.mockReturnValue({ data: [{ id: 'composer', displayName: 'Composer' }] });
    startBuild.mockReturnValue({
      mutateAsync,
      isPending: false,
      isError: false,
      error: null,
      data: undefined,
    });
  });

  it('VT-36 shows the secrets warning and refuses an empty description', async () => {
    renderForm();
    expect(screen.getByTestId('new-build-secrets-notice')).toHaveTextContent('Do not paste passwords');
    fireEvent.click(screen.getByTestId('new-build-submit'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Describe the feature'));
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('VT-04 lists every refusal and keeps the form', () => {
    startBuild.mockReturnValue({
      mutateAsync,
      isPending: false,
      isError: true,
      error: new BuildApiError(409, 'Three items need attention.', 'BUILD_PREFLIGHT_REFUSED', [
        'The code map is missing. A Platform Admin can fix this.',
        'The pipeline is missing. A project admin can fix this.',
      ]),
      data: undefined,
    });
    renderForm();
    expect(screen.getByTestId('new-build-error-summary')).toBeInTheDocument();
    expect(screen.getByTestId('new-build-refusal-list').querySelectorAll('li')).toHaveLength(2);
  });

  it('disables submit while a start is in flight and shows a queue notice', () => {
    startBuild.mockReturnValue({
      mutateAsync,
      isPending: true,
      isError: false,
      error: null,
      data: { status: 'queued', queuePosition: 2, buildRunId: 'b', playbookRunId: null, queueReason: 'project_limit', replayed: false },
    });
    renderForm();
    expect(screen.getByTestId('new-build-submit')).toBeDisabled();
    expect(screen.getByTestId('new-build-queued-notice')).toHaveTextContent('Position 2');
  });

  it('starts a build and leaves for the list', async () => {
    mutateAsync.mockResolvedValue({ status: 'intake', buildRunId: 'b', playbookRunId: 'r' });
    renderForm();
    fireEvent.change(screen.getByTestId('new-build-prompt'), { target: { value: 'Add a reports page' } });
    fireEvent.click(screen.getByTestId('new-build-submit'));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/builds|Your build has started.'));
    expect(mutateAsync).toHaveBeenCalledWith(expect.objectContaining({
      repository: 'apex',
      prompt: 'Add a reports page',
    }));
  });
});
