import { renderHook, act } from '@testing-library/react';
import { useSpeechOutput } from '../useSpeechOutput';

interface MockUtterance {
  text: string;
  rate: number;
  pitch: number;
  volume: number;
  voice: SpeechSynthesisVoice | null;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

const utteranceInstances: MockUtterance[] = [];
const speakMock = jest.fn();
const cancelMock = jest.fn();

function createMockUtterance(text: string): MockUtterance {
  const utterance: MockUtterance = {
    text,
    rate: 1,
    pitch: 1,
    volume: 1,
    voice: null,
    onstart: null,
    onend: null,
    onerror: null,
  };
  utteranceInstances.push(utterance);
  return utterance;
}

beforeEach(() => {
  utteranceInstances.length = 0;
  speakMock.mockClear();
  cancelMock.mockClear();

  class MockSpeechSynthesisUtterance {
    text: string;
    rate = 1;
    pitch = 1;
    volume = 1;
    voice: SpeechSynthesisVoice | null = null;
    onstart: (() => void) | null = null;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;

    constructor(text: string) {
      this.text = text;
      const mock = createMockUtterance(text);
      Object.defineProperty(this, 'rate', {
        get: () => mock.rate,
        set: (value) => { mock.rate = value; },
      });
      Object.defineProperty(this, 'pitch', {
        get: () => mock.pitch,
        set: (value) => { mock.pitch = value; },
      });
      Object.defineProperty(this, 'volume', {
        get: () => mock.volume,
        set: (value) => { mock.volume = value; },
      });
      Object.defineProperty(this, 'voice', {
        get: () => mock.voice,
        set: (value) => { mock.voice = value; },
      });
      Object.defineProperty(this, 'onstart', {
        get: () => mock.onstart,
        set: (fn) => { mock.onstart = fn; },
      });
      Object.defineProperty(this, 'onend', {
        get: () => mock.onend,
        set: (fn) => { mock.onend = fn; },
      });
      Object.defineProperty(this, 'onerror', {
        get: () => mock.onerror,
        set: (fn) => { mock.onerror = fn; },
      });
    }
  }

  const neuralVoice = {
    name: 'Microsoft Jenny Neural',
    lang: 'en-US',
    default: false,
    localService: false,
    voiceURI: 'Microsoft Jenny Neural',
  } as SpeechSynthesisVoice;

  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    writable: true,
    value: {
      speak: speakMock,
      cancel: cancelMock,
      getVoices: () => [neuralVoice],
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
    },
  });

  Object.defineProperty(window, 'SpeechSynthesisUtterance', {
    configurable: true,
    writable: true,
    value: MockSpeechSynthesisUtterance,
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('useSpeechOutput', () => {
  it('reports speech output as supported when speechSynthesis exists', () => {
    const { result } = renderHook(() => useSpeechOutput());
    expect(result.current.isSpeechOutputSupported).toBe(true);
  });

  it('starts speaking stripped text and sets isSpeaking true', () => {
    const { result } = renderHook(() => useSpeechOutput());

    act(() => {
      result.current.speak('Hello **world**!');
    });

    expect(cancelMock).toHaveBeenCalled();
    expect(speakMock).toHaveBeenCalledTimes(1);
    expect(utteranceInstances[0].text).toBe('Hello world!');

    act(() => {
      utteranceInstances[0].onstart?.();
    });

    expect(result.current.isSpeaking).toBe(true);
  });

  it('chunks long text at sentence boundaries', () => {
    const { result } = renderHook(() => useSpeechOutput());
    const longText = `${'This is sentence one. '.repeat(12)}Final sentence.`;

    act(() => {
      result.current.speak(longText);
    });

    expect(utteranceInstances).toHaveLength(1);
    expect(utteranceInstances[0].text.length).toBeLessThanOrEqual(200);

    act(() => {
      utteranceInstances[0].onend?.();
    });

    expect(utteranceInstances.length).toBeGreaterThan(1);
    for (const utterance of utteranceInstances) {
      expect(utterance.text.length).toBeLessThanOrEqual(200);
    }
  });

  it('queues chunks and clears isSpeaking after the last chunk ends', () => {
    const { result } = renderHook(() => useSpeechOutput());
    const longText = `${'Part one here. '.repeat(10)}The end.`;

    act(() => {
      result.current.speak(longText);
    });

    act(() => {
      utteranceInstances[0].onstart?.();
    });
    expect(result.current.isSpeaking).toBe(true);

    for (let i = 0; i < utteranceInstances.length - 1; i++) {
      act(() => {
        utteranceInstances[i].onend?.();
      });
      expect(result.current.isSpeaking).toBe(true);
      expect(speakMock).toHaveBeenCalledTimes(i + 2);
    }

    act(() => {
      utteranceInstances[utteranceInstances.length - 1].onend?.();
    });
    expect(result.current.isSpeaking).toBe(false);
  });

  it('stops speaking and cancels synthesis', () => {
    const { result } = renderHook(() => useSpeechOutput());

    act(() => {
      result.current.speak('Hello');
      utteranceInstances[0].onstart?.();
    });
    expect(result.current.isSpeaking).toBe(true);

    act(() => {
      result.current.stop();
    });

    expect(cancelMock).toHaveBeenCalled();
    expect(result.current.isSpeaking).toBe(false);
  });

  it('clears isSpeaking on utterance error', () => {
    const { result } = renderHook(() => useSpeechOutput());

    act(() => {
      result.current.speak('Hello');
      utteranceInstances[0].onstart?.();
      utteranceInstances[0].onerror?.();
    });

    expect(result.current.isSpeaking).toBe(false);
  });

  it('cancels synthesis on unmount', () => {
    const { unmount } = renderHook(() => useSpeechOutput());
    cancelMock.mockClear();

    unmount();

    expect(cancelMock).toHaveBeenCalled();
  });

  it('does nothing when text is empty after stripping', () => {
    const { result } = renderHook(() => useSpeechOutput());

    act(() => {
      result.current.speak('```\ncode only\n```');
    });

    expect(speakMock).not.toHaveBeenCalled();
  });

  it('applies custom rate and preferred voice to utterances', () => {
    const { result } = renderHook(() => useSpeechOutput({ rate: 1.4 }));

    act(() => {
      result.current.speak('Hello there.');
    });

    expect(utteranceInstances[0].rate).toBe(1.4);
    expect(utteranceInstances[0].pitch).toBe(1);
    expect(utteranceInstances[0].voice?.name).toBe('Microsoft Jenny Neural');
    expect(result.current.selectedVoiceName).toBe('Microsoft Jenny Neural');
  });

  it('restarts the current chunk when rate changes while speaking', () => {
    const longText = `${'Part one here. '.repeat(10)}The end.`;
    const { result, rerender } = renderHook(
      ({ speechRate }: { speechRate: number }) => useSpeechOutput({ rate: speechRate }),
      { initialProps: { speechRate: 1 } },
    );

    act(() => {
      result.current.speak(longText);
      utteranceInstances[0].onstart?.();
    });

    const utteranceCountBeforeRateChange = utteranceInstances.length;
    cancelMock.mockClear();
    speakMock.mockClear();

    rerender({ speechRate: 1.6 });

    expect(cancelMock).toHaveBeenCalled();
    expect(speakMock).toHaveBeenCalled();
    expect(utteranceInstances.length).toBeGreaterThan(utteranceCountBeforeRateChange);
    expect(utteranceInstances[utteranceInstances.length - 1].rate).toBe(1.6);
    expect(result.current.isSpeaking).toBe(true);
  });
});
