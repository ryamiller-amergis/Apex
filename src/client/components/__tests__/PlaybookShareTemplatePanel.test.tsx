import { fireEvent, render, screen } from '@testing-library/react';
import { PlaybookShareTemplatePanel } from '../PlaybookShareTemplatePanel';

const mutate = jest.fn();
let shareState: Record<string, unknown>;
jest.mock('../../hooks/usePlaybookTemplates', () => ({
  useSharePlaybookAsTemplate: () => shareState,
}));

function renderPanel(onClose = jest.fn()) {
  render(
    <PlaybookShareTemplatePanel
      project="Project A"
      definitionId="def-1"
      defaultName="Review flow"
      defaultSummary="Reviews docs"
      versionNumber={3}
      onClose={onClose}
    />,
  );
  return onClose;
}

beforeEach(() => {
  jest.clearAllMocks();
  shareState = { mutate, isPending: false, isError: false, isSuccess: false };
});

describe('PlaybookShareTemplatePanel', () => {
  it('starts with the Playbook name and description', () => {
    renderPanel();
    expect(screen.getByTestId('playbook-share-template-name')).toHaveValue('Review flow');
    expect(screen.getByTestId('playbook-share-template-summary')).toHaveValue('Reviews docs');
    expect(screen.getByText(/live version \(v3\)/)).toBeInTheDocument();
  });

  it('shares with the edited name and summary, trimmed', () => {
    renderPanel();
    fireEvent.change(screen.getByTestId('playbook-share-template-name'), { target: { value: '  Team review ' } });
    fireEvent.change(screen.getByTestId('playbook-share-template-summary'), { target: { value: ' For teams ' } });
    fireEvent.click(screen.getByTestId('playbook-share-template-submit'));
    expect(mutate).toHaveBeenCalledWith({ name: 'Team review', summary: 'For teams' });
  });

  it('will not share without a name', () => {
    renderPanel();
    fireEvent.change(screen.getByTestId('playbook-share-template-name'), { target: { value: '   ' } });
    expect(screen.getByTestId('playbook-share-template-submit')).toBeDisabled();
  });

  it('shows the server error', () => {
    shareState = { ...shareState, isError: true, error: new Error('Publish this Playbook first') };
    renderPanel();
    expect(screen.getByRole('alert')).toHaveTextContent('Publish this Playbook first');
  });

  it('lists what was left out after sharing', () => {
    shareState = {
      ...shareState,
      isSuccess: true,
      data: {
        template: { displayName: 'Review flow' },
        notes: ['"Review": the assignee was removed. Choose one after installing.'],
      },
    };
    const onClose = renderPanel();
    expect(screen.getByTestId('playbook-share-template-notes')).toHaveTextContent('assignee was removed');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('omits the list when nothing was removed', () => {
    shareState = {
      ...shareState,
      isSuccess: true,
      data: { template: { displayName: 'Review flow' }, notes: [] },
    };
    renderPanel();
    expect(screen.queryByTestId('playbook-share-template-notes')).not.toBeInTheDocument();
  });
});
