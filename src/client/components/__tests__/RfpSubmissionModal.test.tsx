import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RfpSubmissionModal } from '../RfpSubmissionModal';
import { useSubmitRfpRequest } from '../../hooks/useRfpIntake';
import { useSpeechInput } from '../../hooks/useSpeechInput';

jest.mock('../../hooks/useRfpIntake', () => ({
  useSubmitRfpRequest: jest.fn(),
}));

jest.mock('../../hooks/useSpeechInput', () => ({
  useSpeechInput: jest.fn(),
}));

const mockUseSubmit = useSubmitRfpRequest as jest.MockedFunction<typeof useSubmitRfpRequest>;
const mockUseSpeech = useSpeechInput as jest.MockedFunction<typeof useSpeechInput>;

interface SpeechState {
  isListening: boolean;
  isSpeechSupported: boolean;
  speechError: string | null;
  toggle: jest.Mock;
  stop: jest.Mock;
  onTranscript?: (text: string) => void;
}

let speech: SpeechState;

function modalTree() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <RfpSubmissionModal onClose={jest.fn()} />
    </QueryClientProvider>
  );
}

function renderModal() {
  return render(modalTree());
}

function fillRequired() {
  fireEvent.change(screen.getByTestId('rfp-field-title'), { target: { value: 'Keep me' } });
  fireEvent.change(screen.getByTestId('rfp-field-stakeholder'), { target: { value: 'BA' } });
  fireEvent.change(screen.getByTestId('rfp-field-request'), { target: { value: 'Need a tracker' } });
  fireEvent.change(screen.getByTestId('rfp-field-problem'), { target: { value: 'Fragmented' } });
  fireEvent.change(screen.getByTestId('rfp-field-existingSolution'), { target: { value: 'none' } });
  fireEvent.change(screen.getByTestId('rfp-field-expectedUsers'), { target: { value: 'medium' } });
  fireEvent.change(screen.getByTestId('rfp-field-aiInApp'), { target: { value: 'yes' } });
}

describe('RfpSubmissionModal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseSubmit.mockReturnValue({
      mutateAsync: jest.fn(),
      isPending: false,
      isError: false,
      error: null,
    } as never);
    speech = {
      isListening: false,
      isSpeechSupported: true,
      speechError: null,
      toggle: jest.fn(),
      stop: jest.fn(),
    };
    mockUseSpeech.mockImplementation((onTranscript) => {
      speech.onTranscript = onTranscript;
      return speech;
    });
  });

  it('PBI-003 AC-2 shows existing system stack only for change-existing', () => {
    renderModal();
    expect(screen.queryByTestId('rfp-existing-system-stack')).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId('rfp-field-requestType'), { target: { value: 'change-existing' } });
    expect(screen.getByTestId('rfp-existing-system-stack')).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('rfp-field-requestType'), { target: { value: 'new-app' } });
    expect(screen.queryByTestId('rfp-existing-system-stack')).not.toBeInTheDocument();
  });

  it('PBI-003 AC-1 preserves entered values when create fails', async () => {
    const mutateAsync = jest.fn().mockRejectedValue(new Error('create failed'));
    mockUseSubmit.mockReturnValue({
      mutateAsync,
      isPending: false,
      isError: true,
      error: new Error('create failed'),
    } as never);

    renderModal();
    fillRequired();
    fireEvent.click(screen.getByTestId('rfp-submit-button'));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(screen.getByTestId('rfp-field-title')).toHaveValue('Keep me');
    expect(screen.getByTestId('rfp-submit-error')).toHaveTextContent(/create failed/i);
  });

  it('shows a success confirmation after submit', async () => {
    const mutateAsync = jest.fn().mockResolvedValue({ id: 'rfp-9', title: 'Keep me' });
    mockUseSubmit.mockReturnValue({
      mutateAsync,
      isPending: false,
      isError: false,
      error: null,
    } as never);

    renderModal();
    fillRequired();
    fireEvent.click(screen.getByTestId('rfp-submit-button'));

    await waitFor(() => expect(screen.getByTestId('rfp-submit-success')).toBeInTheDocument());
    expect(screen.getByTestId('rfp-submit-success')).toHaveTextContent(/submitted successfully/i);
    expect(screen.queryByTestId('rfp-submission-form')).not.toBeInTheDocument();
  });

  it('FF-2 labels the stakeholder field Sponsoring team', () => {
    renderModal();
    expect(screen.getByLabelText(/sponsoring team/i)).toBe(screen.getByTestId('rfp-field-stakeholder'));
  });

  it('FF-0 FF-1 offers the three user bands and three AI answers', () => {
    renderModal();
    const bands = Array.from((screen.getByTestId('rfp-field-expectedUsers') as HTMLSelectElement).options)
      .map((option) => option.textContent);
    expect(bands).toEqual(['Select…', 'Small (1–100)', 'Medium (101–500)', 'Large (501+)']);
    const ai = Array.from((screen.getByTestId('rfp-field-aiInApp') as HTMLSelectElement).options)
      .map((option) => option.textContent);
    expect(ai).toEqual(['Select…', 'Yes', 'No', 'Not sure']);
  });

  it('FF-0 FF-1 blocks submit until expected users and AI intent are chosen', async () => {
    const mutateAsync = jest.fn();
    mockUseSubmit.mockReturnValue({ mutateAsync, isPending: false, isError: false, error: null } as never);
    renderModal();
    fillRequired();
    fireEvent.change(screen.getByTestId('rfp-field-expectedUsers'), { target: { value: '' } });
    fireEvent.change(screen.getByTestId('rfp-field-aiInApp'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('rfp-submit-button'));

    await waitFor(() => expect(screen.getByTestId('rfp-validation-summary')).toHaveTextContent(/expected users is required/i));
    expect(screen.getByTestId('rfp-validation-summary')).toHaveTextContent(/ai in the application is required/i);
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('FF-0 FF-1 submits the chosen expected users and AI intent', async () => {
    const mutateAsync = jest.fn().mockResolvedValue({ id: 'rfp-9', title: 'Keep me' });
    mockUseSubmit.mockReturnValue({ mutateAsync, isPending: false, isError: false, error: null } as never);
    renderModal();
    fillRequired();
    fireEvent.click(screen.getByTestId('rfp-submit-button'));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalled());
    expect(mutateAsync.mock.calls[0][0].intake).toMatchObject({ expectedUsers: 'medium', aiInApp: 'yes', stakeholder: 'BA' });
  });

  it('FF-3 shows a mic button on the five long fields', () => {
    renderModal();
    for (const field of ['request', 'problem', 'existingSolution', 'advantage', 'constraints']) {
      expect(screen.getByTestId(`rfp-mic-${field}`)).toBeInTheDocument();
    }
  });

  it('FF-3 hides the mic buttons when the browser has no speech recognition', () => {
    speech.isSpeechSupported = false;
    renderModal();
    expect(screen.queryByTestId('rfp-mic-request')).not.toBeInTheDocument();
  });

  it('FF-3 writes the transcript into the field whose mic was pressed', () => {
    renderModal();
    fireEvent.change(screen.getByTestId('rfp-field-problem'), { target: { value: 'Typed' } });
    fireEvent.click(screen.getByTestId('rfp-mic-problem'));

    expect(speech.toggle).toHaveBeenCalledWith('Typed');
    speech.onTranscript?.('Typed and spoken');
    expect(screen.getByTestId('rfp-field-problem')).toHaveValue('Typed and spoken');
    expect(screen.getByTestId('rfp-field-request')).toHaveValue('');
  });

  it('FF-3 starting another field stops the current one first', () => {
    const view = renderModal();
    fireEvent.click(screen.getByTestId('rfp-mic-request'));
    speech.isListening = true;
    view.rerender(modalTree());
    expect(screen.getByTestId('rfp-mic-request')).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByTestId('rfp-mic-problem'));
    expect(speech.stop).toHaveBeenCalled();
    expect(speech.toggle).toHaveBeenCalledTimes(1);

    speech.isListening = false;
    view.rerender(modalTree());
    expect(speech.toggle).toHaveBeenCalledTimes(2);
    speech.onTranscript?.('Spoken problem');
    expect(screen.getByTestId('rfp-field-problem')).toHaveValue('Spoken problem');
  });
});
