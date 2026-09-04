/**
 * Completion-sound playback gating on the notification toast stream.
 */
import { act, render } from '@testing-library/react';
import { NotificationProvider } from '../NotificationContext';
import type {
  AppNotification,
  GenerationSoundPreferences,
} from '../../../shared/types/notification';

const playGenerationSoundMock = jest.fn();

let soundQuery: { data: GenerationSoundPreferences | undefined };

jest.mock('../../hooks/useGenerationSoundSettings', () => ({
  useGenerationSoundSettings: () => soundQuery,
}));

jest.mock('../../utils/generationSound', () => ({
  playGenerationSound: (soundId: string) => playGenerationSoundMock(soundId),
}));

class MockEventSource {
  static instances: MockEventSource[] = [];
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onopen: ((ev: Event) => void) | null = null;
  closed = false;

  constructor(public url: string) {
    MockEventSource.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }
}

function notification(overrides: Partial<AppNotification> = {}): AppNotification {
  return {
    id: `n-${Math.random().toString(36).slice(2)}`,
    userId: 'oid-a',
    type: 'ai',
    title: 'PRD generation complete',
    body: null,
    link: null,
    read: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function emitToast(overrides: Partial<AppNotification> = {}, toast = true): void {
  act(() => {
    MockEventSource.instances[0].emit({
      type: 'notification',
      notification: notification(overrides),
      toast,
    });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  MockEventSource.instances = [];
  Object.defineProperty(globalThis, 'EventSource', {
    writable: true,
    configurable: true,
    value: MockEventSource,
  });
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ count: 0 }),
  }) as unknown as typeof fetch;
  soundQuery = { data: { generationSoundEnabled: true, generationSoundId: 'bell' } };
});

/** Flushes the provider's unread-count fetch so state settles before assertions. */
async function renderProvider() {
  const result = render(
    <NotificationProvider>
      <div />
    </NotificationProvider>,
  );
  await act(async () => {});
  return result;
}

describe('generation sound playback', () => {
  it('plays the chosen sound when a generation toast arrives', async () => {
    await renderProvider();

    emitToast();

    expect(playGenerationSoundMock).toHaveBeenCalledWith('bell');
  });

  it('stays silent while the preference is off', async () => {
    soundQuery = { data: { generationSoundEnabled: false, generationSoundId: 'bell' } };
    await renderProvider();

    emitToast();

    expect(playGenerationSoundMock).not.toHaveBeenCalled();
  });

  it('stays silent before preferences load', async () => {
    soundQuery = { data: undefined };
    await renderProvider();

    emitToast();

    expect(playGenerationSoundMock).not.toHaveBeenCalled();
  });

  it('ignores AI notifications outside the generation set', async () => {
    await renderProvider();

    emitToast({ title: 'Design doc validation complete' });

    expect(playGenerationSoundMock).not.toHaveBeenCalled();
  });

  it('ignores notifications the user has muted as toasts', async () => {
    await renderProvider();

    emitToast({}, false);

    expect(playGenerationSoundMock).not.toHaveBeenCalled();
  });

  it('chimes once when two generations finish together', async () => {
    await renderProvider();

    emitToast({ title: 'PRD generation complete' });
    emitToast({ title: 'Design doc generated' });

    expect(playGenerationSoundMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the stream open when the preference changes', async () => {
    const { rerender } = await renderProvider();

    soundQuery = { data: { generationSoundEnabled: true, generationSoundId: 'pop' } };
    rerender(
      <NotificationProvider>
        <div />
      </NotificationProvider>,
    );

    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0].closed).toBe(false);
  });
});
