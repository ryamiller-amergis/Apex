import { AI_RUN_V2_VISUAL_SPEC_VERSION } from '../../../shared/types/aiRunV2VisualSpec';
import { createVisualExecute } from '../../services/aiRunsV2Worker/visualEntrypoint';

const spec = {
  specVersion: AI_RUN_V2_VISUAL_SPEC_VERSION,
  subjectId: 'prototype-1',
  subjectKind: 'design-prototype' as const,
  promptInputs: { featureName: 'Standup summary' },
  designSystem: {},
  designReference: { navItems: [] },
  model: { modelId: 'anthropic.claude', maxTokens: 8000 },
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
    expect(model).toEqual({ modelId: 'anthropic.claude', maxTokens: 8000 });
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
