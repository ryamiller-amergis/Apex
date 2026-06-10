import { pickSpeechVoice } from '../pickSpeechVoice';

function makeVoice(
  name: string,
  lang: string,
  overrides: Partial<SpeechSynthesisVoice> = {},
): SpeechSynthesisVoice {
  return {
    name,
    lang,
    default: false,
    localService: true,
    voiceURI: name,
    ...overrides,
  } as SpeechSynthesisVoice;
}

describe('pickSpeechVoice', () => {
  it('returns null for an empty voice list', () => {
    expect(pickSpeechVoice([], 'en-US')).toBeNull();
  });

  it('prefers neural / natural voices over basic defaults', () => {
    const voices = [
      makeVoice('Microsoft David Desktop', 'en-US', { default: true }),
      makeVoice('Microsoft Jenny Neural', 'en-US', { localService: false }),
    ];
    expect(pickSpeechVoice(voices, 'en-US')?.name).toBe('Microsoft Jenny Neural');
  });

  it('avoids espeak-style robotic voices', () => {
    const voices = [
      makeVoice('eSpeak English', 'en-US'),
      makeVoice('Karen', 'en-AU'),
    ];
    expect(pickSpeechVoice(voices, 'en-US')?.name).toBe('Karen');
  });

  it('prefers an exact language match', () => {
    const voices = [
      makeVoice('Google UK English Female', 'en-GB'),
      makeVoice('Google US English', 'en-US', { localService: false }),
    ];
    expect(pickSpeechVoice(voices, 'en-US')?.name).toBe('Google US English');
  });
});
