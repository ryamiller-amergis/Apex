import { render, screen, fireEvent } from '@testing-library/react';
import { WorkItemContextModal } from '../WorkItemContextModal';
import { useMyWorkItemContext } from '../../hooks/useDevWorkbench';

jest.mock('../../hooks/useDevWorkbench', () => ({
  useMyWorkItemContext: jest.fn(),
}));

const onClose = jest.fn();

function renderModal() {
  return render(
    <WorkItemContextModal
      project="MaxView"
      workItemId={42}
      title="Shift scheduler"
      onClose={onClose}
    />,
  );
}

describe('WorkItemContextModal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('shows the Feature description and each child state', () => {
    (useMyWorkItemContext as jest.Mock).mockReturnValue({
      data: {
        id: 42,
        title: 'Shift scheduler',
        workItemType: 'Feature',
        state: 'In Progress',
        description: 'Build the scheduler',
        acceptanceCriteria: 'Nurses can pick a shift',
        reproSteps: '',
        design: '',
        children: [
          { id: 201, title: 'Pick a shift', workItemType: 'Product Backlog Item', state: 'New' },
          { id: 202, title: 'Save the pick', workItemType: 'Technical Backlog Item', state: 'In Pull Request' },
        ],
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: jest.fn(),
      isFetching: false,
    });

    renderModal();

    expect(screen.getByRole('dialog', { name: 'Shift scheduler' })).toBeInTheDocument();
    expect(screen.getByTestId('my-work-item-context-description')).toHaveTextContent('Build the scheduler');
    expect(screen.getByTestId('my-work-item-context-child-201')).toHaveTextContent('New');
    expect(screen.getByTestId('my-work-item-context-child-202')).toHaveTextContent('In Pull Request');
    expect(useMyWorkItemContext).toHaveBeenCalledWith('MaxView', 42);
  });

  it('closes from the close button and Escape', () => {
    (useMyWorkItemContext as jest.Mock).mockReturnValue({
      data: {
        id: 42,
        title: 'Shift scheduler',
        workItemType: 'Feature',
        state: 'In Progress',
        description: '',
        acceptanceCriteria: '',
        reproSteps: '',
        design: '',
        children: [],
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: jest.fn(),
      isFetching: false,
    });

    renderModal();
    fireEvent.click(screen.getByTestId('my-work-item-context-close'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('my-work-item-context-children')).toHaveTextContent('No child work items.');
  });
});
