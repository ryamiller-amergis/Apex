/**
 * Completion-sound settings in the notification preferences panel.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NotificationPreferences } from '../NotificationPreferences';
import type { GenerationSoundPreferences } from '../../../shared/types/notification';

const updateSoundMutate = jest.fn();
const playGenerationSoundMock = jest.fn();

let soundQuery: { data: GenerationSoundPreferences | undefined };
let updateSoundState: { mutate: jest.Mock; isError: boolean; error: Error | null };

jest.mock('../../hooks/useNotifications', () => ({
  useNotificationPreferences: () => ({
    data: [],
    isLoading: false,
    isError: false,
    refetch: jest.fn(),
    error: null,
  }),
  useUpdateNotificationPreference: () => ({
    mutate: jest.fn(),
    isError: false,
    error: null,
  }),
}));

jest.mock('../../hooks/useGenerationSoundSettings', () => ({
  useGenerationSoundSettings: () => soundQuery,
  useUpdateGenerationSoundSettings: () => updateSoundState,
}));

jest.mock('../../utils/generationSound', () => ({
  playGenerationSound: (soundId: string) => playGenerationSoundMock(soundId),
}));

beforeEach(() => {
  jest.clearAllMocks();
  playGenerationSoundMock.mockResolvedValue(true);
  soundQuery = { data: { generationSoundEnabled: false, generationSoundId: 'chime' } };
  updateSoundState = { mutate: updateSoundMutate, isError: false, error: null };
});

function enableSound(soundId: GenerationSoundPreferences['generationSoundId'] = 'chime') {
  soundQuery = { data: { generationSoundEnabled: true, generationSoundId: soundId } };
}

describe('completion sound settings', () => {
  it('starts switched off with the sound picker locked', () => {
    render(<NotificationPreferences />);

    expect(screen.getByTestId('generation-sound-enabled')).not.toBeChecked();
    expect(screen.getByTestId('generation-sound-select')).toBeDisabled();
    expect(screen.getByTestId('generation-sound-preview')).toBeDisabled();
  });

  it('saves the preference and previews the sound when switched on', async () => {
    render(<NotificationPreferences />);

    fireEvent.click(screen.getByTestId('generation-sound-enabled'));

    expect(updateSoundMutate).toHaveBeenCalledWith({ generationSoundEnabled: true });
    await waitFor(() => expect(playGenerationSoundMock).toHaveBeenCalledWith('chime'));
  });

  it('does not preview when switched off', () => {
    enableSound();
    render(<NotificationPreferences />);

    fireEvent.click(screen.getByTestId('generation-sound-enabled'));

    expect(updateSoundMutate).toHaveBeenCalledWith({ generationSoundEnabled: false });
    expect(playGenerationSoundMock).not.toHaveBeenCalled();
  });

  it('offers every built-in sound and saves the chosen one', async () => {
    enableSound();
    render(<NotificationPreferences />);

    const select = screen.getByTestId('generation-sound-select');
    expect(select).toBeEnabled();
    expect(
      Array.from(select.querySelectorAll('option')).map((o) => o.getAttribute('value')),
    ).toEqual(['chime', 'bell', 'pop']);

    fireEvent.change(select, { target: { value: 'bell' } });

    expect(updateSoundMutate).toHaveBeenCalledWith({ generationSoundId: 'bell' });
    await waitFor(() => expect(playGenerationSoundMock).toHaveBeenCalledWith('bell'));
  });

  it('plays the saved sound from the preview button without saving again', async () => {
    enableSound('pop');
    render(<NotificationPreferences />);

    fireEvent.click(screen.getByTestId('generation-sound-preview'));

    await waitFor(() => expect(playGenerationSoundMock).toHaveBeenCalledWith('pop'));
    expect(updateSoundMutate).not.toHaveBeenCalled();
  });

  it('explains what to do when the browser blocks audio', async () => {
    enableSound();
    playGenerationSoundMock.mockResolvedValue(false);
    render(<NotificationPreferences />);

    fireEvent.click(screen.getByTestId('generation-sound-preview'));

    await waitFor(() =>
      expect(screen.getByTestId('generation-sound-blocked')).toBeInTheDocument(),
    );
  });

  it('surfaces a failed save', () => {
    enableSound();
    updateSoundState = {
      mutate: updateSoundMutate,
      isError: true,
      error: new Error('Invalid generationSoundId'),
    };
    render(<NotificationPreferences />);

    expect(screen.getByRole('alert')).toHaveTextContent('Invalid generationSoundId');
  });

  it('falls back to the defaults before preferences load', () => {
    soundQuery = { data: undefined };
    render(<NotificationPreferences />);

    expect(screen.getByTestId('generation-sound-enabled')).not.toBeChecked();
    expect(screen.getByTestId('generation-sound-select')).toHaveValue('chime');
  });
});
