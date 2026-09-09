import type { GenerationSoundId } from '../../shared/types/notification';

/**
 * Built-in completion sounds are synthesized with the Web Audio API instead of
 * shipped as audio files — no binary assets, no network fetch, and the tones
 * stay identical across browsers.
 */
interface ToneStep {
  /** Pitch in Hz. */
  frequency: number;
  /** Offset from the start of playback, in seconds. */
  startAt: number;
  /** How long the tone rings, in seconds. */
  duration: number;
  /** Peak amplitude before the master gain is applied (0–1). */
  gain: number;
  type: OscillatorType;
}

const TONE_RECIPES: Record<GenerationSoundId, ToneStep[]> = {
  // Two ascending sine notes — the "done" motif.
  chime: [
    { frequency: 880, startAt: 0, duration: 0.18, gain: 0.18, type: 'sine' },
    { frequency: 1174.66, startAt: 0.12, duration: 0.3, gain: 0.15, type: 'sine' },
  ],
  // Fundamental plus an octave overtone with a long tail reads as a struck bell.
  bell: [
    { frequency: 1568, startAt: 0, duration: 0.9, gain: 0.13, type: 'sine' },
    { frequency: 3136, startAt: 0, duration: 0.45, gain: 0.05, type: 'sine' },
  ],
  // Short, dry blip for people who want the least intrusive cue.
  pop: [
    { frequency: 523.25, startAt: 0, duration: 0.09, gain: 0.2, type: 'triangle' },
    { frequency: 1046.5, startAt: 0.05, duration: 0.08, gain: 0.11, type: 'sine' },
  ],
};

/** Keeps the loudest recipe comfortable next to normal system volume. */
const MASTER_GAIN = 0.6;

/** Exponential ramps cannot reach zero, so decay to an inaudible floor instead. */
const SILENCE = 0.0001;

type AudioContextConstructor = new () => AudioContext;

function getAudioContextConstructor(): AudioContextConstructor | null {
  if (typeof window === 'undefined') return null;
  const candidate = window.AudioContext
    ?? (window as unknown as { webkitAudioContext?: AudioContextConstructor }).webkitAudioContext;
  return candidate ?? null;
}

/** False in jsdom and in browsers without Web Audio, so callers can skip cleanly. */
export function isGenerationSoundSupported(): boolean {
  return getAudioContextConstructor() !== null;
}

/**
 * Browsers cap the number of live AudioContexts, so every sound shares one.
 * Created lazily — constructing it at import time would trip autoplay warnings.
 */
let sharedContext: AudioContext | null = null;

function getSharedContext(): AudioContext | null {
  if (sharedContext && sharedContext.state !== 'closed') return sharedContext;
  const Ctor = getAudioContextConstructor();
  if (!Ctor) return null;
  try {
    sharedContext = new Ctor();
    return sharedContext;
  } catch {
    return null;
  }
}

function scheduleTone(ctx: AudioContext, step: ToneStep, startTime: number): void {
  const oscillator = ctx.createOscillator();
  const envelope = ctx.createGain();

  oscillator.type = step.type;
  oscillator.frequency.setValueAtTime(step.frequency, startTime);

  const peak = step.gain * MASTER_GAIN;
  const endTime = startTime + step.duration;
  envelope.gain.setValueAtTime(SILENCE, startTime);
  envelope.gain.exponentialRampToValueAtTime(peak, startTime + 0.012);
  envelope.gain.exponentialRampToValueAtTime(SILENCE, endTime);

  oscillator.connect(envelope);
  envelope.connect(ctx.destination);
  oscillator.onended = () => {
    oscillator.disconnect();
    envelope.disconnect();
  };
  oscillator.start(startTime);
  oscillator.stop(endTime);
}

/**
 * Play a completion sound. Never throws and never blocks the caller's UI —
 * audio is a garnish on the toast, not a step in it.
 *
 * @returns true when the tones were scheduled; false when the browser has no
 * Web Audio support or is still withholding audio until a user gesture.
 */
export async function playGenerationSound(soundId: GenerationSoundId): Promise<boolean> {
  const ctx = getSharedContext();
  if (!ctx) return false;

  // Autoplay policy: a context created before the first user gesture starts
  // suspended. resume() succeeds once the user has interacted with the page.
  if (ctx.state === 'suspended') {
    try {
      await ctx.resume();
    } catch {
      return false;
    }
  }
  if (ctx.state !== 'running') return false;

  try {
    const startTime = ctx.currentTime;
    for (const step of TONE_RECIPES[soundId]) {
      scheduleTone(ctx, step, startTime + step.startAt);
    }
    return true;
  } catch {
    return false;
  }
}

/** Test seam — drops the cached context so each test starts clean. */
export function resetGenerationSoundContextForTests(): void {
  sharedContext = null;
}
