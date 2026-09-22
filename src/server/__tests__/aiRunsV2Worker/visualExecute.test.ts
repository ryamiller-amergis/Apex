import { AI_RUN_V2_VISUAL_SPEC_VERSION } from '../../../shared/types/aiRunV2VisualSpec';
import { VisualModelTruncatedError } from '../../services/aiRunsV2Worker/bedrockVisualClient';
import { createVisualExecute } from '../../services/aiRunsV2Worker/visualEntrypoint';

const spec = {
  specVersion: AI_RUN_V2_VISUAL_SPEC_VERSION,
  subjectId: 'prototype-1',
  subjectKind: 'design-prototype' as const,
  prototypePrompt: { branch: 'maxview' as const },
  promptInputs: {
    featureName: 'Standup summary',
    featureDescription: '',
    planSection: '',
    pbiSection: '### PBI 1: Show the summary',
    scopingSection: 'Only render the described feature.',
    extendMode: false,
    targetRoute: null,
    existingPageContext: '',
    targetScreenHint: '',
    pageScreenshotHint: '',
    sourceFiles: [],
    omittedSourcePaths: [],
  },
  designSystem: {},
  designReference: { navItems: [], images: [] },
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
          images: [
            {
              kind: 'design-reference',
              base64: 'QUJD',
              mediaType: 'image/png',
              width: 1024,
              height: 810,
            },
          ],
        },
      } as never,
      command: {} as never,
      checkpoints: checkpoints().port as never,
      signal: new AbortController().signal,
    });

    expect(invokeModel.mock.calls[0][2]).toEqual([
      { base64: 'QUJD', mediaType: 'image/png' },
    ]);
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

    expect(invokeModel.mock.calls[0][2]).toEqual([]);
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
        promptInputs: {
          userPrompt: 'A timecard approval queue',
          targetRoute: null,
          designSystemName: 'APEX',
          skillMarkdown: '# UI Lab',
          componentIndex: '- AppHeader',
          existingPageContext: '',
        },
        designReference: {
          navItems: [],
          images: [
            {
              kind: 'design-reference',
              base64: 'QUJD',
              mediaType: 'image/png',
            },
          ],
        },
      } as never,
      command: {} as never,
      checkpoints: checkpoints().port as never,
      signal: new AbortController().signal,
    });

    expect(invokeModel.mock.calls[0][2]).toEqual([
      { base64: 'QUJD', mediaType: 'image/png' },
    ]);
  });

  it('hands EXTEND images to the model in their immutable order', async () => {
    const invokeModel = jest.fn().mockResolvedValue('<html/>');
    const execute = createVisualExecute({ invokeModel });

    await execute({
      specification: {
        ...spec,
        promptInputs: {
          ...spec.promptInputs,
          extendMode: true,
          targetRoute: '/timecards',
          existingPageContext: 'export const Timecards = () => null;',
        },
        designReference: {
          navItems: [],
          images: [
            {
              kind: 'design-reference',
              base64: 'QUJD',
              mediaType: 'image/png',
            },
            {
              kind: 'existing-page',
              base64: 'REVG',
              mediaType: 'image/jpeg',
            },
          ],
        },
      } as never,
      command: {} as never,
      checkpoints: checkpoints().port as never,
      signal: new AbortController().signal,
    });

    expect(invokeModel.mock.calls[0][2]).toEqual([
      { base64: 'QUJD', mediaType: 'image/png' },
      { base64: 'REVG', mediaType: 'image/jpeg' },
    ]);
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
        promptInputs: {
          userPrompt: 'A timecard approval queue',
          targetRoute: null,
          designSystemName: 'APEX',
          skillMarkdown: '# UI Lab',
          componentIndex: '- AppHeader',
          existingPageContext: '',
        },
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

  /**
   * Both prototype prompts answer the same subject kind, so the kind alone
   * cannot pick between them. Answering a project that has its own design
   * system with the MaxView prompt produces output that looks finished and
   * is built against the wrong design system.
   */
  it('builds the project prompt for a project that resolved its own design system', async () => {
    const invokeModel = jest.fn().mockResolvedValue('<html/>');
    const execute = createVisualExecute({ invokeModel });

    await execute({
      specification: {
        ...spec,
        prototypePrompt: {
          branch: 'project-design-system',
          appName: 'Apex',
          designSystemMarkdown: '## Apex tokens',
          extendMode: false,
        },
      } as never,
      command: {} as never,
      checkpoints: checkpoints().port as never,
      signal: new AbortController().signal,
    });

    const [prompt] = invokeModel.mock.calls[0];
    expect(prompt).toContain('You are a world-class product designer');
    expect(prompt).toContain('## Apex Design System (AUTHORITATIVE');
    expect(prompt).not.toContain('MaxView');
  });

  it('refuses a prototype run that never said which prompt to build', async () => {
    const invokeModel = jest.fn();
    const execute = createVisualExecute({ invokeModel });
    const { prototypePrompt, ...withoutBranch } = spec;
    expect(prototypePrompt).toBeDefined();

    await expect(
      execute({
        specification: withoutBranch as never,
        command: {} as never,
        checkpoints: checkpoints().port as never,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('visual specification');
    expect(invokeModel).not.toHaveBeenCalled();
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

  /**
   * A truncated document is well-formed enough to upload and reads as a
   * finished prototype once it is on the row. The client refuses it, and
   * nothing here may turn that refusal back into an artifact.
   */
  it('produces no artifact when the model call was cut off at the ceiling', async () => {
    const execute = createVisualExecute({
      invokeModel: async () => {
        throw new VisualModelTruncatedError('<html><body><table', 8_000);
      },
    });

    const outcome = execute({
      specification: spec as never,
      command: {} as never,
      checkpoints: checkpoints().port as never,
      signal: new AbortController().signal,
    });

    // No `ExecutionOutcome` means no files, and the worker uploads nothing.
    await expect(outcome).rejects.toBeInstanceOf(VisualModelTruncatedError);
    await expect(outcome).rejects.toThrow('truncated at 8000 output tokens');
  });
});
