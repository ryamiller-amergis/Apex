import { render, screen, fireEvent } from '@testing-library/react';
import { ReadAloudButton } from '../ReadAloudButton';
import { useSpeechOutput } from '../../hooks/useSpeechOutput';
import { useSpeechOutputSettings } from '../../hooks/useSpeechOutputSettings';

jest.mock('../../hooks/useSpeechOutput', () => ({
  useSpeechOutput: jest.fn(),
}));

jest.mock('../../hooks/useSpeechOutputSettings', () => ({
  useSpeechOutputSettings: jest.fn(),
}));

const mockSpeak = jest.fn();
const mockStop = jest.fn();
const mockSetRate = jest.fn();

function setupHook(overrides: Partial<ReturnType<typeof useSpeechOutput>> = {}) {
  (useSpeechOutput as jest.Mock).mockReturnValue({
    speak: mockSpeak,
    stop: mockStop,
    isSpeaking: false,
    isSpeechOutputSupported: true,
    selectedVoiceName: 'Microsoft Jenny Neural',
    ...overrides,
  });
}

describe('ReadAloudButton', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (useSpeechOutputSettings as jest.Mock).mockReturnValue({
      rate: 1.1,
      setRate: mockSetRate,
      minRate: 0.5,
      maxRate: 2,
    });
    setupHook();
  });

  it('renders nothing when speech output is not supported', () => {
    setupHook({ isSpeechOutputSupported: false });
    const { container } = render(<ReadAloudButton text="Hello" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a read-aloud button and speed slider when supported', () => {
    render(<ReadAloudButton text="Hello agent" />);
    expect(screen.getByRole('button', { name: 'Read aloud' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Speech speed' })).toBeInTheDocument();
    expect(screen.getByText('1.1×')).toBeInTheDocument();
  });

  it('calls speak with message text on click', () => {
    render(<ReadAloudButton text="Hello agent" />);
    fireEvent.click(screen.getByRole('button', { name: 'Read aloud' }));
    expect(mockSpeak).toHaveBeenCalledWith('Hello agent');
    expect(mockStop).not.toHaveBeenCalled();
  });

  it('calls stop when already speaking', () => {
    setupHook({ isSpeaking: true });
    render(<ReadAloudButton text="Hello agent" />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop reading' }));
    expect(mockStop).toHaveBeenCalled();
    expect(mockSpeak).not.toHaveBeenCalled();
  });

  it('updates speech rate when the slider changes', () => {
    render(<ReadAloudButton text="Hello agent" />);
    fireEvent.change(screen.getByRole('slider', { name: 'Speech speed' }), { target: { value: '1.5' } });
    expect(mockSetRate).toHaveBeenCalledWith(1.5);
  });
});
