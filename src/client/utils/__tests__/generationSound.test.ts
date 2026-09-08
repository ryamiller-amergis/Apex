import {
  isGenerationSoundSupported,
  playGenerationSound,
  resetGenerationSoundContextForTests,
} from '../generationSound';
import {
  normalizeGenerationSoundPreferences,
  shouldPlayGenerationSound,
} from '../../../shared/types/notification';

class FakeGainNode {
  gain = {
    setValueAtTime: jest.fn(),
    exponentialRampToValueAtTime: jest.fn(),
  };
  connect = jest.fn();
  disconnect = jest.fn();
}

class FakeOscillator {
  type = 'sine';
  frequency = { setValueAtTime: jest.fn() };
  connect = jest.fn();
  disconnect = jest.fn();
  start = jest.fn();
  stop = jest.fn();
  onended: (() => void) | null = null;
}

let lastContext: FakeAudioContext | null = null;
/** State a freshly constructed context starts in — mirrors autoplay policy. */
let initialState: 'running' | 'suspended' = 'running';
let resumeShouldReject = false;

/** Takes the instance as an argument so the constructor never aliases `this`. */
function rememberContext(ctx: FakeAudioContext): void {
  lastContext = ctx;
}

class FakeAudioContext {
  state: 'running' | 'suspended' | 'closed' = initialState;
  currentTime = 0;
  destination = {};
  oscillators: FakeOscillator[] = [];
  gains: FakeGainNode[] = [];

  constructor() {
    rememberContext(this);
  }

  resume = jest.fn(async () => {
    if (resumeShouldReject) throw new Error('blocked by autoplay policy');
    this.state = 'running';
  });

  createOscillator = jest.fn(() => {
    const osc = new FakeOscillator();
    this.oscillators.push(osc);
    return osc;
  });

  createGain = jest.fn(() => {
    const gain = new FakeGainNode();
    this.gains.push(gain);
    return gain;
  });
}

function installAudioContext(): void {
  (window as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
}

function removeAudioContext(): void {
  delete (window as unknown as { AudioContext?: unknown }).AudioContext;
  delete (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext;
}

beforeEach(() => {
  lastContext = null;
  initialState = 'running';
  resumeShouldReject = false;
  resetGenerationSoundContextForTests();
  removeAudioContext();
});

afterEach(() => {
  removeAudioContext();
  resetGenerationSoundContextForTests();
});

describe('generation sound support detection', () => {
  it('reports unsupported when the browser has no Web Audio API', () => {
    expect(isGenerationSoundSupported()).toBe(false);
  });

  it('reports supported once an AudioContext constructor exists', () => {
    installAudioContext();
    expect(isGenerationSoundSupported()).toBe(true);
  });

  it('accepts the prefixed webkitAudioContext', () => {
    (window as unknown as { webkitAudioContext: unknown }).webkitAudioContext = FakeAudioContext;
    expect(isGenerationSoundSupported()).toBe(true);
  });
});

describe('playGenerationSound', () => {
  it('resolves false instead of throwing when Web Audio is unavailable', async () => {
    await expect(playGenerationSound('chime')).resolves.toBe(false);
  });

  it('schedules every tone in the recipe and reports success', async () => {
    installAudioContext();

    await expect(playGenerationSound('chime')).resolves.toBe(true);

    expect(lastContext).not.toBeNull();
    expect(lastContext!.oscillators).toHaveLength(2);
    for (const osc of lastContext!.oscillators) {
      expect(osc.start).toHaveBeenCalledTimes(1);
      expect(osc.stop).toHaveBeenCalledTimes(1);
      expect(osc.connect).toHaveBeenCalledTimes(1);
    }
  });

  it('gives each built-in sound a distinct leading pitch', async () => {
    installAudioContext();
    const leadPitch = async (soundId: 'chime' | 'bell' | 'pop') => {
      resetGenerationSoundContextForTests();
      await playGenerationSound(soundId);
      return lastContext!.oscillators[0].frequency.setValueAtTime.mock.calls[0][0] as number;
    };

    const chime = await leadPitch('chime');
    const bell = await leadPitch('bell');
    const pop = await leadPitch('pop');

    expect(new Set([chime, bell, pop]).size).toBe(3);
  });

  it('reuses one AudioContext across calls', async () => {
    installAudioContext();

    await playGenerationSound('chime');
    const first = lastContext;
    await playGenerationSound('bell');

    expect(lastContext).toBe(first);
    expect(first!.oscillators).toHaveLength(4);
  });

  it('resumes a context suspended by the autoplay policy', async () => {
    installAudioContext();
    initialState = 'suspended';

    await expect(playGenerationSound('bell')).resolves.toBe(true);
    expect(lastContext!.resume).toHaveBeenCalled();
    expect(lastContext!.oscillators).toHaveLength(2);
  });

  it('reports failure when the browser refuses to resume audio', async () => {
    installAudioContext();
    initialState = 'suspended';
    resumeShouldReject = true;

    await expect(playGenerationSound('pop')).resolves.toBe(false);
    expect(lastContext!.oscillators).toHaveLength(0);
  });

  it('disconnects nodes when a tone ends so repeated plays do not leak', async () => {
    installAudioContext();

    await playGenerationSound('pop');
    const osc = lastContext!.oscillators[0];
    osc.onended?.();

    expect(osc.disconnect).toHaveBeenCalled();
    expect(lastContext!.gains[0].disconnect).toHaveBeenCalled();
  });
});

describe('shouldPlayGenerationSound', () => {
  it('plays for scoped AI generation completions', () => {
    expect(
      shouldPlayGenerationSound({ type: 'ai', title: 'PRD generation complete' }),
    ).toBe(true);
    expect(shouldPlayGenerationSound({ type: 'ai', title: 'Design doc generated' })).toBe(true);
    expect(shouldPlayGenerationSound({ type: 'ai', title: 'Design prototype ready' })).toBe(true);
  });

  it('stays silent for other AI notifications', () => {
    expect(
      shouldPlayGenerationSound({ type: 'ai', title: 'Design doc validation complete' }),
    ).toBe(false);
  });

  it('stays silent for non-AI notification types', () => {
    expect(
      shouldPlayGenerationSound({ type: 'system', title: 'PRD generation complete' }),
    ).toBe(false);
  });
});

describe('normalizeGenerationSoundPreferences', () => {
  it('defaults to off with the chime sound', () => {
    expect(normalizeGenerationSoundPreferences(null)).toEqual({
      generationSoundEnabled: false,
      generationSoundId: 'chime',
    });
  });

  it('keeps valid stored values', () => {
    expect(
      normalizeGenerationSoundPreferences({
        generationSoundEnabled: true,
        generationSoundId: 'bell',
      }),
    ).toEqual({ generationSoundEnabled: true, generationSoundId: 'bell' });
  });

  it('falls back to the default sound for an unrecognized id', () => {
    expect(
      normalizeGenerationSoundPreferences({
        generationSoundEnabled: true,
        generationSoundId: 'airhorn',
      }),
    ).toEqual({ generationSoundEnabled: true, generationSoundId: 'chime' });
  });
});
