/**
 * Tests for BacklogViewer inline editing (Phase 2b):
 *  - editable=false (default): no edit buttons on any card
 *  - editable=true: edit icons appear on epic / feature / item cards
 *  - Clicking an edit icon opens a form pre-filled with that entity's data
 *  - Saving calls onSaveBacklog with the updated full backlog JSON
 *  - Cancelling closes without calling onSaveBacklog
 */

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { BacklogViewer } from '../BacklogViewer';

// ── Sample backlog fixture ─────────────────────────────────────────────────────

const sampleBacklog = {
  epics: [
    {
      title: 'Epic Alpha',
      priority: 'Must Have',
      description: 'Epic Alpha description.',
      features: [
        {
          title: 'Feature One',
          priority: 'Should Have',
          description: 'Feature One description.',
          items: [
            {
              type: 'PBI' as const,
              id: 'PBI-001',
              title: 'Item A',
              priority: 'Must Have',
              description: 'Item A description.',
            },
          ],
        },
      ],
    },
  ],
};

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('BacklogViewer – editable=false (default)', () => {
  it('renders without any edit buttons', () => {
    render(<BacklogViewer data={sampleBacklog} />);
    // No pencil / edit buttons should be in the document
    const editBtns = screen.queryAllByRole('button', { name: /edit/i });
    // Only collapse/expand buttons should exist; no "Edit epic" etc.
    const editActionBtns = editBtns.filter(
      (b) => b.getAttribute('aria-label')?.toLowerCase().includes('edit'),
    );
    expect(editActionBtns).toHaveLength(0);
  });
});

describe('BacklogViewer – editable=true', () => {
  const mockOnSaveBacklog = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders an edit button on each epic card', () => {
    render(
      <BacklogViewer data={sampleBacklog} editable onSaveBacklog={mockOnSaveBacklog} />,
    );
    const epicEditBtns = screen.getAllByRole('button', { name: 'Edit epic' });
    expect(epicEditBtns).toHaveLength(1);
  });

  it('renders an edit button on each feature card', () => {
    render(
      <BacklogViewer data={sampleBacklog} editable onSaveBacklog={mockOnSaveBacklog} />,
    );
    const featureEditBtns = screen.getAllByRole('button', { name: 'Edit feature' });
    expect(featureEditBtns).toHaveLength(1);
  });

  it('renders an edit button on each item card', () => {
    render(
      <BacklogViewer data={sampleBacklog} editable onSaveBacklog={mockOnSaveBacklog} />,
    );
    const itemEditBtns = screen.getAllByRole('button', { name: 'Edit item' });
    expect(itemEditBtns).toHaveLength(1);
  });

  describe('Epic edit form', () => {
    it('opens a form pre-filled with the epic title and description', () => {
      render(
        <BacklogViewer data={sampleBacklog} editable onSaveBacklog={mockOnSaveBacklog} />,
      );
      const epicEditBtn = screen.getByRole('button', { name: 'Edit epic' });
      fireEvent.click(epicEditBtn);

      const dialog = screen.getByRole('dialog');
      expect(dialog).toBeInTheDocument();

      const titleInput = within(dialog).getByLabelText(/title/i);
      expect(titleInput).toHaveValue('Epic Alpha');

      const descInput = within(dialog).getByLabelText(/description/i);
      expect(descInput).toHaveValue('Epic Alpha description.');
    });

    it('calling Save updates the epic and calls onSaveBacklog with the updated backlog', async () => {
      render(
        <BacklogViewer data={sampleBacklog} editable onSaveBacklog={mockOnSaveBacklog} />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Edit epic' }));

      const dialog = screen.getByRole('dialog');
      const titleInput = within(dialog).getByLabelText(/title/i);
      fireEvent.change(titleInput, { target: { value: 'Epic Alpha Updated' } });

      fireEvent.click(within(dialog).getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(mockOnSaveBacklog).toHaveBeenCalledTimes(1);
      });

      const savedBacklog = mockOnSaveBacklog.mock.calls[0][0] as typeof sampleBacklog;
      expect(savedBacklog.epics[0].title).toBe('Epic Alpha Updated');
      // Other fields should remain unchanged
      expect(savedBacklog.epics[0].description).toBe('Epic Alpha description.');
    });

    it('cancelling the form closes without calling onSaveBacklog', () => {
      render(
        <BacklogViewer data={sampleBacklog} editable onSaveBacklog={mockOnSaveBacklog} />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Edit epic' }));

      const dialog = screen.getByRole('dialog');
      fireEvent.click(within(dialog).getByRole('button', { name: /cancel/i }));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(mockOnSaveBacklog).not.toHaveBeenCalled();
    });
  });

  describe('Feature edit form', () => {
    it('opens a form pre-filled with the feature title and description', () => {
      render(
        <BacklogViewer data={sampleBacklog} editable onSaveBacklog={mockOnSaveBacklog} />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Edit feature' }));

      const dialog = screen.getByRole('dialog');
      const titleInput = within(dialog).getByLabelText(/title/i);
      expect(titleInput).toHaveValue('Feature One');

      const descInput = within(dialog).getByLabelText(/description/i);
      expect(descInput).toHaveValue('Feature One description.');
    });

    it('saving the feature form calls onSaveBacklog with updated feature data', async () => {
      render(
        <BacklogViewer data={sampleBacklog} editable onSaveBacklog={mockOnSaveBacklog} />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Edit feature' }));

      const dialog = screen.getByRole('dialog');
      const titleInput = within(dialog).getByLabelText(/title/i);
      fireEvent.change(titleInput, { target: { value: 'Feature One Updated' } });
      fireEvent.click(within(dialog).getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(mockOnSaveBacklog).toHaveBeenCalledTimes(1);
      });

      const saved = mockOnSaveBacklog.mock.calls[0][0] as typeof sampleBacklog;
      expect(saved.epics[0].features[0].title).toBe('Feature One Updated');
    });
  });

  describe('Item edit form', () => {
    it('opens a form pre-filled with the item title and description', () => {
      render(
        <BacklogViewer data={sampleBacklog} editable onSaveBacklog={mockOnSaveBacklog} />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Edit item' }));

      const dialog = screen.getByRole('dialog');
      const titleInput = within(dialog).getByLabelText(/title/i);
      expect(titleInput).toHaveValue('Item A');
    });

    it('saving the item form calls onSaveBacklog with updated item data', async () => {
      render(
        <BacklogViewer data={sampleBacklog} editable onSaveBacklog={mockOnSaveBacklog} />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Edit item' }));

      const dialog = screen.getByRole('dialog');
      const titleInput = within(dialog).getByLabelText(/title/i);
      fireEvent.change(titleInput, { target: { value: 'Item A Updated' } });
      fireEvent.click(within(dialog).getByRole('button', { name: /save/i }));

      await waitFor(() => {
        expect(mockOnSaveBacklog).toHaveBeenCalledTimes(1);
      });

      const saved = mockOnSaveBacklog.mock.calls[0][0] as typeof sampleBacklog;
      expect(saved.epics[0].features[0].items![0].title).toBe('Item A Updated');
    });
  });
});
