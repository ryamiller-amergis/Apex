import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AtsBoardLaunchForm } from '../AtsBoardLaunchForm';

describe('AtsBoardLaunchForm', () => {
  it('asks for a charter and strips contact details before start', async () => {
    const onStart = jest.fn();
    render(<AtsBoardLaunchForm pending={false} onCancel={jest.fn()} onStart={onStart} />);

    fireEvent.click(screen.getByTestId('ats-board-start'));
    expect(await screen.findByText('Describe the outcome in a sentence or two.')).toBeInTheDocument();
    expect(onStart).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('ats-board-objective'), {
      target: { value: 'Replace the fill workflow. Contact ada@example.com.' },
    });
    fireEvent.change(screen.getByTestId('ats-board-separation'), {
      target: { value: 'Run without the old system of record.' },
    });
    fireEvent.change(screen.getByTestId('ats-board-staffing-model'), {
      target: { value: 'Contract clinical staffing.' },
    });
    fireEvent.change(screen.getByTestId('ats-board-boundaries'), {
      target: { value: 'No payroll in the first release.' },
    });
    fireEvent.change(screen.getByTestId('ats-board-non-negotiables'), {
      target: { value: 'Do not copy old screens.' },
    });
    fireEvent.click(screen.getByTestId('ats-board-authorize-research'));
    fireEvent.click(screen.getByTestId('ats-board-start'));

    await waitFor(() => expect(onStart).toHaveBeenCalledTimes(1));
    const charter = String(onStart.mock.calls[0][0].charter);
    expect(charter).toContain('[redacted email]');
    expect(charter).not.toContain('ada@example.com');
    expect(onStart.mock.calls[0][0].authorizeNamedResearch).toBe(true);
  });

  it('blocks Aya or eRecruit until named research is authorized', async () => {
    const onStart = jest.fn();
    render(<AtsBoardLaunchForm pending={false} onCancel={jest.fn()} onStart={onStart} />);
    fireEvent.change(screen.getByTestId('ats-board-objective'), {
      target: { value: 'Beat Aya on the speed of a filled assignment.' },
    });
    fireEvent.change(screen.getByTestId('ats-board-separation'), {
      target: { value: 'Leave the old system for this workflow.' },
    });
    fireEvent.change(screen.getByTestId('ats-board-staffing-model'), {
      target: { value: 'Contract clinical staffing.' },
    });
    fireEvent.change(screen.getByTestId('ats-board-boundaries'), {
      target: { value: 'No payroll in the first release.' },
    });
    fireEvent.change(screen.getByTestId('ats-board-non-negotiables'), {
      target: { value: 'Do not copy old screens.' },
    });
    fireEvent.click(screen.getByTestId('ats-board-start'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/explicit authorization/);
    expect(onStart).not.toHaveBeenCalled();
  });
});
