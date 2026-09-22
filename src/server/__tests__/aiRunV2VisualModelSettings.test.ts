/**
 * A worker holds no policy.
 *
 * Model settings have three layers — the project override in the database,
 * the app default, and the environment variable that tunes it — and a visual
 * worker can read none of them. So the effective values are resolved on App
 * Service, by the same module that applies them in process, and travel on the
 * specification.
 *
 * These tests pin the resolved numbers to the in-process ones and pin the two
 * lanes apart: a prototype ceiling is not a UI Lab ceiling, and collapsing
 * them to one number truncates one lane or overspends on the other.
 */
import { resolvePrototypeVisualModel } from '../services/bedrockService';
import { resolveUiLabVisualModel } from '../services/uiLabBedrockService';

/** What `UI_MOCK_MAX_TOKENS` and `MODEL_INVOKE_TIMEOUT_MS` come to unset. */
const PROTOTYPE_DEFAULT_MAX_TOKENS = 32_000;
const PROTOTYPE_DEFAULT_TIMEOUT_MS = 12 * 60_000;

/** What `DEFAULT_UI_LAB_MAX_TOKENS` and `DEFAULT_UI_LAB_TIMEOUT_MS` come to. */
const UI_LAB_DEFAULT_MAX_TOKENS = 16_000;
const UI_LAB_DEFAULT_TIMEOUT_MS = 10 * 60_000;

/**
 * Both app defaults are read from the environment once, at module load, so
 * the only way to observe the override is to load the module again under it.
 * That is why this file re-requires rather than importing at the top.
 */
function underEnvironment<T>(env: Record<string, string>, read: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    let result!: T;
    jest.isolateModules(() => {
      result = read();
    });
    return result;
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('prototype lane model settings', () => {
  it('resolves the ceiling and timeout the in-process path applies when the project sets none', () => {
    expect(resolvePrototypeVisualModel({ modelId: 'anthropic.claude' })).toEqual({
      modelId: 'anthropic.claude',
      maxTokens: PROTOTYPE_DEFAULT_MAX_TOKENS,
      timeoutMs: PROTOTYPE_DEFAULT_TIMEOUT_MS,
    });
  });

  it('lets a project override win, as it does in process', () => {
    expect(
      resolvePrototypeVisualModel({
        modelId: 'anthropic.claude',
        maxTokens: 9_000,
        timeoutMs: 90_000,
      }),
    ).toEqual({ modelId: 'anthropic.claude', maxTokens: 9_000, timeoutMs: 90_000 });
  });

  /**
   * `generateDesignPrototypeHtml` takes the override only when it is above
   * zero. A specification that carried a zero ceiling would refuse validation
   * on the worker for a project the in-process path serves happily.
   */
  it('ignores a non-positive ceiling override, as the in-process path does', () => {
    for (const override of [0, -1]) {
      expect(
        resolvePrototypeVisualModel({ modelId: 'anthropic.claude', maxTokens: override })
          .maxTokens,
      ).toBe(PROTOTYPE_DEFAULT_MAX_TOKENS);
    }
  });

  it('treats a null override as no override', () => {
    expect(
      resolvePrototypeVisualModel({
        modelId: 'anthropic.claude',
        maxTokens: null,
        timeoutMs: null,
      }),
    ).toEqual({
      modelId: 'anthropic.claude',
      maxTokens: PROTOTYPE_DEFAULT_MAX_TOKENS,
      timeoutMs: PROTOTYPE_DEFAULT_TIMEOUT_MS,
    });
  });

  it('carries the environment-tuned app default, which a worker cannot read', () => {
    const resolved = underEnvironment(
      {
        BEDROCK_UI_MOCK_MAX_TOKENS: '48000',
        BEDROCK_INVOKE_TIMEOUT_MS: '300000',
      },
      () =>
        (
          require('../services/bedrockService') as typeof import('../services/bedrockService')
        ).resolvePrototypeVisualModel({ modelId: 'anthropic.claude' }),
    );

    expect(resolved).toEqual({
      modelId: 'anthropic.claude',
      maxTokens: 48_000,
      timeoutMs: 300_000,
    });
  });

  /** The in-process prototype payload has no temperature key at all. */
  it('sets no temperature, because the in-process path sends none', () => {
    expect(
      Object.keys(resolvePrototypeVisualModel({ modelId: 'anthropic.claude' })),
    ).not.toContain('temperature');
  });
});

describe('UI Lab lane model settings', () => {
  it("resolves its own defaults rather than the prototype lane's", () => {
    expect(resolveUiLabVisualModel({ modelId: 'anthropic.claude' })).toEqual({
      modelId: 'anthropic.claude',
      maxTokens: UI_LAB_DEFAULT_MAX_TOKENS,
      timeoutMs: UI_LAB_DEFAULT_TIMEOUT_MS,
    });
  });

  /**
   * The two lanes are tuned separately and one shared number would be wrong
   * for both. Asserted rather than assumed, so a future "simplification" that
   * flattens them fails here.
   */
  it('stays distinct from the prototype lane', () => {
    const prototype = resolvePrototypeVisualModel({ modelId: 'anthropic.claude' });
    const uiLab = resolveUiLabVisualModel({ modelId: 'anthropic.claude' });

    expect(uiLab.maxTokens).not.toBe(prototype.maxTokens);
    expect(uiLab.timeoutMs).not.toBe(prototype.timeoutMs);
  });

  it('lets a project override win', () => {
    expect(
      resolveUiLabVisualModel({
        modelId: 'anthropic.claude',
        maxTokens: 24_000,
        timeoutMs: 120_000,
      }),
    ).toEqual({ modelId: 'anthropic.claude', maxTokens: 24_000, timeoutMs: 120_000 });
  });

  it('carries the environment-tuned UI Lab default', () => {
    const resolved = underEnvironment(
      {
        BEDROCK_UI_LAB_MAX_TOKENS: '20000',
        BEDROCK_UI_LAB_TIMEOUT_MS: '420000',
      },
      () =>
        (
          require('../services/uiLabBedrockService') as typeof import('../services/uiLabBedrockService')
        ).resolveUiLabVisualModel({ modelId: 'anthropic.claude' }),
    );

    expect(resolved).toEqual({
      modelId: 'anthropic.claude',
      maxTokens: 20_000,
      timeoutMs: 420_000,
    });
  });

  it('carries a project temperature so the contract can express it', () => {
    expect(
      resolveUiLabVisualModel({ modelId: 'anthropic.claude', temperature: 0.2 }).temperature,
    ).toBe(0.2);
  });

  it('leaves temperature off entirely when the project set none', () => {
    for (const temperature of [undefined, null]) {
      const model = resolveUiLabVisualModel({ modelId: 'anthropic.claude', temperature });

      expect(Object.keys(model)).not.toContain('temperature');
    }
  });
});
