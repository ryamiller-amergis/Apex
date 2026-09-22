import { AI_RUN_V2_VISUAL_SPEC_VERSION } from '../../../shared/types/aiRunV2VisualSpec';
import { createVisualExecute } from '../../services/aiRunsV2Worker/visualEntrypoint';

const spec = {
  specVersion: AI_RUN_V2_VISUAL_SPEC_VERSION,
  subjectId: 'prototype-1',
  subjectKind: 'design-prototype' as const,
  prototypePrompt: { branch: 'maxview' as const },
  promptInputs: { featureName: 'Standup summary' },
  designSystem: {},
  designReference: { navItems: [] },
  model: { modelId: 'anthropic.claude', maxTokens: 8000, timeoutMs: 600_000 },
  usage: { feature: 'design-prototype' },
  outputPath: 'prototype.html',
};

function checkpoints() {
  const progress: string[] = [];
  return {
    recorded: progress,
    port: {
      publishStarted: async () => undefined,
      publishHeartbeat: async () => undefined,
      publishProgress: async (phase: string, status: string) => {
        progress.push(`${phase}:${status}`);
      },
      lastSequence: () => 0,
    },
  };
}

describe('visual execute', () => {
  it('uploads the generated html under the path the specification names', async () => {
    const execute = createVisualExecute({
      invokeModel: async () => '<html>ok</html>',
    });
    const beats = checkpoints();

    const outcome = await execute({
      specification: spec as never,
      command: {} as never,
      checkpoints: beats.port as never,
      signal: new AbortController().signal,
    });

    expect(outcome.files).toEqual([
      {
        path: 'prototype.html',
        content: '<html>ok</html>',
        contentType: 'text/html',
      },
    ]);
    expect(beats.recorded).toContain('execution:running');
  });

  it('passes the built prompt and the specification model to Bedrock', async () => {
    const invokeModel = jest.fn().mockResolvedValue('<html/>');
    const execute = createVisualExecute({ invokeModel });

    await execute({
      specification: spec as never,
      command: {} as never,
      checkpoints: checkpoints().port as never,
      signal: new AbortController().signal,
    });

    const [prompt, model] = invokeModel.mock.calls[0];
    expect(prompt).toContain('**Feature:** Standup summary');
    expect(model).toEqual({
      modelId: 'anthropic.claude',
      maxTokens: 8000,
      timeoutMs: 600_000,
    });
  });

  /**
   * The in-process prototype path attaches the Figma screenshot as a vision
   * input, and the prompt tells the model the screenshot is there. Without
   * this the V2 output diverges from the in-process output for the same
   * feature, with nothing to flag it.
   */
  it('hands the specification screenshot to the model', async () => {
    const invokeModel = jest.fn().mockResolvedValue('<html/>');
    const execute = createVisualExecute({ invokeModel });

    await execute({
      specification: {
        ...spec,
        designReference: {
          navItems: [],
          screenshotBase64: 'QUJD',
          screenshotMediaType: 'image/png',
          screenshotWidth: 1024,
          screenshotHeight: 810,
        },
      } as never,
      command: {} as never,
      checkpoints: checkpoints().port as never,
      signal: new AbortController().signal,
    });

    expect(invokeModel.mock.calls[0][2]).toEqual({
      base64: 'QUJD',
      mediaType: 'image/png',
    });
  });

  it('defaults the media type to png, matching the in-process Figma reference', async () => {
    const invokeModel = jest.fn().mockResolvedValue('<html/>');
    const execute = createVisualExecute({ invokeModel });

    await execute({
      specification: {
        ...spec,
        designReference: { navItems: [], screenshotBase64: 'QUJD' },
      } as never,
      command: {} as never,
      checkpoints: checkpoints().port as never,
      signal: new AbortController().signal,
    });

    expect(invokeModel.mock.calls[0][2]).toEqual({
      base64: 'QUJD',
      mediaType: 'image/png',
    });
  });

  it('passes no image when the specification carries no screenshot', async () => {
    const invokeModel = jest.fn().mockResolvedValue('<html/>');
    const execute = createVisualExecute({ invokeModel });

    await execute({
      specification: spec as never,
      command: {} as never,
      checkpoints: checkpoints().port as never,
      signal: new AbortController().signal,
    });

    expect(invokeModel.mock.calls[0][2]).toBeUndefined();
  });

  /** UI Lab attaches the same Figma reference in process, so it travels too. */
  it('hands the screenshot to a ui-lab-screen subject as well', async () => {
    const invokeModel = jest.fn().mockResolvedValue('<html/>');
    const execute = createVisualExecute({ invokeModel });

    await execute({
      specification: {
        ...spec,
        subjectKind: 'ui-lab-screen',
        outputPath: 'design.html',
        promptInputs: { userPrompt: 'A timecard approval queue' },
        designReference: { navItems: [], screenshotBase64: 'QUJD' },
      } as never,
      command: {} as never,
      checkpoints: checkpoints().port as never,
      signal: new AbortController().signal,
    });

    expect(invokeModel.mock.calls[0][2]).toEqual({
      base64: 'QUJD',
      mediaType: 'image/png',
    });
  });

  it('refuses a specification that does not validate', async () => {
    const invokeModel = jest.fn();
    const execute = createVisualExecute({ invokeModel });

    await expect(
      execute({
        specification: { specVersion: 99 } as never,
        command: {} as never,
        checkpoints: checkpoints().port as never,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('visual specification');
    expect(invokeModel).not.toHaveBeenCalled();
  });

  it('carries usage back as an artifact because a worker cannot write it', async () => {
    const execute = createVisualExecute({
      invokeModel: async () => ({
        html: '<html>ok</html>',
        usage: { inputTokens: 120, outputTokens: 3400 },
        durationMs: 9000,
      }),
    });

    const outcome = await execute({
      specification: spec as never,
      command: {} as never,
      checkpoints: checkpoints().port as never,
      signal: new AbortController().signal,
    });

    expect(outcome.files.map((f) => f.path)).toEqual([
      'prototype.html',
      'usage.json',
    ]);
    const usage = JSON.parse(outcome.files[1].content as string);
    expect(usage).toMatchObject({
      modelId: 'anthropic.claude',
      feature: 'design-prototype',
      inputTokens: 120,
      outputTokens: 3400,
    });
  });

  it('builds UI Lab instructions for a ui-lab-screen subject, not prototype ones', async () => {
    const invokeModel = jest.fn().mockResolvedValue('<html/>');
    const execute = createVisualExecute({ invokeModel });

    const outcome = await execute({
      specification: {
        ...spec,
        subjectKind: 'ui-lab-screen',
        outputPath: 'design.html',
        promptInputs: { userPrompt: 'A timecard approval queue' },
      } as never,
      command: {} as never,
      checkpoints: checkpoints().port as never,
      signal: new AbortController().signal,
    });

    const [prompt] = invokeModel.mock.calls[0];
    expect(prompt).toContain('expert UI/UX designer and front-end engineer');
    expect(prompt).toContain('A timecard approval queue');
    expect(prompt).toContain('<!-- STATE:LOADING:START -->');
    expect(prompt).not.toContain('NEW_FEATURE');
    expect(outcome.files[0].path).toBe('design.html');
  });

  it('refuses empty model output rather than uploading a blank prototype', async () => {
    const execute = createVisualExecute({ invokeModel: async () => '   ' });

    await expect(
      execute({
        specification: spec as never,
        command: {} as never,
        checkpoints: checkpoints().port as never,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('returned no HTML');
  });
});
