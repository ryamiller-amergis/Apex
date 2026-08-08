import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DiagramTitleEditor } from '../DiagramTitleEditor';

describe('DiagramTitleEditor — PBI-005', () => {
  it('PBI-005 AC-0: renders title and notifies parent on change', async () => {
    const user = userEvent.setup();
    const onTitleChange = jest.fn();
    render(
      <DiagramTitleEditor title="Architecture Overview" onTitleChange={onTitleChange} editable />,
    );

    const input = screen.getByTestId('diagram-title-input');
    expect(input).toHaveValue('Architecture Overview');
    expect(input).not.toBeDisabled();

    await user.clear(input);
    await user.type(input, 'New Name');
    expect(onTitleChange).toHaveBeenCalled();
    expect(onTitleChange).toHaveBeenLastCalledWith(expect.stringContaining('New Name'));
  });

  it('PBI-005 AC-0: rejects empty/whitespace title with field error', async () => {
    const user = userEvent.setup();
    render(
      <DiagramTitleEditor title="Valid" onTitleChange={jest.fn()} editable />,
    );

    const input = screen.getByTestId('diagram-title-input');
    await user.clear(input);
    await user.tab();

    expect(await screen.findByText(/title is required|required/i)).toBeInTheDocument();
  });

  it('PBI-005 AC-0: rejects whitespace-only title with field error', async () => {
    const user = userEvent.setup();
    render(
      <DiagramTitleEditor title="Valid" onTitleChange={jest.fn()} editable />,
    );

    const input = screen.getByTestId('diagram-title-input');
    await user.clear(input);
    await user.type(input, '   ');
    await user.tab();

    expect(await screen.findByText(/title is required|required/i)).toBeInTheDocument();
  });

  it('PBI-005 AC-3: title input is disabled without edit access', () => {
    render(
      <DiagramTitleEditor
        title="Shared Diagram"
        onTitleChange={jest.fn()}
        editable={false}
      />,
    );

    expect(screen.getByTestId('diagram-title-input')).toBeDisabled();
  });

  it('syncs when the title prop changes from the editor', () => {
    const { rerender } = render(
      <DiagramTitleEditor title="Original" onTitleChange={jest.fn()} editable />,
    );
    expect(screen.getByTestId('diagram-title-input')).toHaveValue('Original');

    rerender(
      <DiagramTitleEditor title="From Server" onTitleChange={jest.fn()} editable />,
    );
    expect(screen.getByTestId('diagram-title-input')).toHaveValue('From Server');
  });
});
