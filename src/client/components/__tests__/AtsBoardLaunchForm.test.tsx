import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('labels each field with a question and an example', () => {
    render(<AtsBoardLaunchForm pending={false} onCancel={jest.fn()} onStart={jest.fn()} />);
    const objective = screen.getByLabelText('What should Phase 1 achieve?');
    expect(objective).toHaveAttribute('placeholder', expect.stringMatching(/^e\.g\. /));
    expect(objective).toHaveAccessibleDescription(/Describe the result/);
  });

  it('disables dictation when the browser has no speech recognition', () => {
    render(<AtsBoardLaunchForm pending={false} onCancel={jest.fn()} onStart={jest.fn()} />);
    expect(screen.getByTestId('ats-board-objective-mic')).toBeDisabled();
  });

  describe('with speech recognition', () => {
    const instances: FakeRecognition[] = [];

    class FakeRecognition {
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onresult: ((event: unknown) => void) | null = null;
      start = jest.fn(() => {
        this.onstart?.();
      });
      stop = jest.fn(() => {
        this.onend?.();
      });

      constructor() {
        instances.push(this);
      }
    }

    function latestRecognition(): FakeRecognition {
      const latest = instances[instances.length - 1];
      if (!latest) throw new Error('Speech recognition was not constructed');
      return latest;
    }

    beforeEach(() => {
      instances.length = 0;
      (window as unknown as { SpeechRecognition: unknown }).SpeechRecognition = FakeRecognition;
    });

    afterEach(() => {
      delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
    });

    it('writes the transcript into the field whose microphone was pressed', async () => {
      render(<AtsBoardLaunchForm pending={false} onCancel={jest.fn()} onStart={jest.fn()} />);
      const mic = await screen.findByTestId('ats-board-boundaries-mic');
      await waitFor(() => expect(mic).toBeEnabled());

      fireEvent.click(mic);
      expect(mic).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByTestId('ats-board-objective-mic')).toBeDisabled();

      act(() => {
        latestRecognition().onresult?.({ results: [{ isFinal: true, 0: { transcript: 'No payroll yet' } }] });
      });
      expect(screen.getByTestId('ats-board-boundaries')).toHaveValue('No payroll yet');
      expect(screen.getByTestId('ats-board-objective')).toHaveValue('');

      fireEvent.click(mic);
      expect(latestRecognition().stop).toHaveBeenCalled();
      expect(mic).toHaveAttribute('aria-pressed', 'false');
    });
  });
});
