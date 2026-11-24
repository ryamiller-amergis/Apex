const invokeBedrockText = jest.fn();
const listBedrockModels = jest.fn();
jest.mock('../services/bedrockService', () => ({
  invokeBedrockText: (...args: unknown[]) => invokeBedrockText(...args),
  listAvailableBedrockModels: (...args: unknown[]) => listBedrockModels(...args),
}));

// pdfjs loads its worker with a dynamic import, which Jest refuses without --experimental-vm-modules.
const pdfGetText = jest.fn();
const pdfDestroy = jest.fn();
jest.mock('pdf-parse', () => ({
  PDFParse: jest.fn().mockImplementation(() => ({ getText: pdfGetText, destroy: pdfDestroy })),
}));

import { PDFParse } from 'pdf-parse';
import {
  ProjectSkillDraftError,
  extractSkillFileText,
  generateProjectSkillDraft,
} from '../services/playbookSkillDraftService';

describe('project skill drafts', () => {
  beforeEach(() => {
    invokeBedrockText.mockReset();
    listBedrockModels.mockReset();
    listBedrockModels.mockResolvedValue([{ id: 'us.anthropic.claude-sonnet-4-6', label: 'Claude Sonnet 4.6' }]);
  });

  it('sends the picked model to Bedrock and leaves it unset for the default', async () => {
    invokeBedrockText.mockResolvedValue('{"description":"d","instructions":"i"}');
    await generateProjectSkillDraft({
      project: 'Apex', userId: 'u', title: 'T', skillType: 'autonomous', request: 'Do it',
      modelId: 'us.anthropic.claude-sonnet-4-6',
    });
    expect(invokeBedrockText).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.anything(),
      expect.objectContaining({ modelId: 'us.anthropic.claude-sonnet-4-6' }),
    );

    await generateProjectSkillDraft({
      project: 'Apex', userId: 'u', title: 'T', skillType: 'autonomous', request: 'Do it',
    });
    expect(invokeBedrockText).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.anything(),
      expect.objectContaining({ modelId: undefined }),
    );
  });

  it('refuses a model that is not on the draft list', async () => {
    await expect(generateProjectSkillDraft({
      project: 'Apex', userId: 'u', title: 'T', skillType: 'autonomous', request: 'Do it',
      modelId: 'made-up-model',
    })).rejects.toThrow('not available for drafts');
    expect(invokeBedrockText).not.toHaveBeenCalled();
  });

  it('returns the description and instructions without frontmatter', async () => {
    invokeBedrockText.mockResolvedValue(
      '```json\n{"description":"Writes release notes.","instructions":"---\\nname: x\\n---\\n1. Read the PRs."}\n```',
    );
    const draft = await generateProjectSkillDraft({
      project: 'Apex',
      userId: 'user-1',
      title: 'Release notes',
      skillType: 'autonomous',
      request: 'Write release notes from merged PRs.',
    });
    expect(draft).toEqual({ description: 'Writes release notes.', instructions: '1. Read the PRs.' });
    expect(invokeBedrockText).toHaveBeenCalledWith(
      expect.stringContaining('Skill title: Release notes'),
      expect.objectContaining({ project: 'Apex', userId: 'user-1', entityType: 'playbook-skill-draft' }),
      expect.anything(),
    );
  });

  it('refuses a missing request and an unusable reply', async () => {
    await expect(generateProjectSkillDraft({
      project: 'Apex', userId: 'u', title: 'T', skillType: 'interactive', request: '  ',
    })).rejects.toBeInstanceOf(ProjectSkillDraftError);
    invokeBedrockText.mockResolvedValue('no json here');
    await expect(generateProjectSkillDraft({
      project: 'Apex', userId: 'u', title: 'T', skillType: 'interactive', request: 'Do it',
    })).rejects.toBeInstanceOf(ProjectSkillDraftError);
  });
});

describe('reading the model reply', () => {
  const base = { project: 'Apex', userId: 'u', title: 'T', skillType: 'interactive' as const, request: 'Do it' };

  beforeEach(() => {
    invokeBedrockText.mockReset();
    listBedrockModels.mockReset();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('reads the tagged shape the prompt asks for, keeping code fences and quotes in the body', async () => {
    invokeBedrockText.mockResolvedValue([
      '<description>Writes "customer" release notes.</description>',
      '<instructions>',
      '1. Read the PRs.',
      '',
      '```',
      'Release 1.2 — "Highlights"',
      '```',
      '</instructions>',
    ].join('\n'));
    const draft = await generateProjectSkillDraft(base);
    expect(draft.description).toBe('Writes "customer" release notes.');
    expect(draft.instructions).toBe('1. Read the PRs.\n\n```\nRelease 1.2 — "Highlights"\n```');
  });

  it('ignores a code fence around the tagged reply and text before it', async () => {
    invokeBedrockText.mockResolvedValue(
      'Here you go:\n```xml\n<description>d</description>\n<instructions>\nStep one\n</instructions>\n```',
    );
    await expect(generateProjectSkillDraft(base)).resolves.toEqual({ description: 'd', instructions: 'Step one' });
  });

  it('accepts a tagged reply with no closing instructions tag', async () => {
    invokeBedrockText.mockResolvedValue('<description>d</description>\n<instructions>\nStep one');
    await expect(generateProjectSkillDraft(base)).resolves.toEqual({ description: 'd', instructions: 'Step one' });
  });

  it('still accepts JSON whose instructions hold a code fence', async () => {
    invokeBedrockText.mockResolvedValue(
      '```json\n{"description":"d","instructions":"1. Do it\\n```\\ncode\\n```\\n2. Done"}\n```',
    );
    const draft = await generateProjectSkillDraft(base);
    expect(draft.description).toBe('d');
    expect(draft.instructions).toBe('1. Do it\n```\ncode\n```\n2. Done');
  });

  it('accepts bare JSON with text around it', async () => {
    invokeBedrockText.mockResolvedValue('Sure. {"description":"d","instructions":"i"} Hope that helps.');
    await expect(generateProjectSkillDraft(base)).resolves.toEqual({ description: 'd', instructions: 'i' });
  });

  it('says the reply was unreadable when it has neither shape', async () => {
    invokeBedrockText.mockResolvedValue('I cannot help with that.');
    await expect(generateProjectSkillDraft(base)).rejects.toThrow('could not read');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('unreadable reply'));
  });

  it('names the missing part when the reply is half there', async () => {
    invokeBedrockText.mockResolvedValue('<description>d</description><instructions>  </instructions>');
    await expect(generateProjectSkillDraft(base)).rejects.toThrow('no instructions');
    invokeBedrockText.mockResolvedValue('{"description":"","instructions":"i"}');
    await expect(generateProjectSkillDraft(base)).rejects.toThrow('no description');
  });

  it('turns a truncated reply into advice the author can act on', async () => {
    const truncated = Object.assign(new Error('Model response was truncated'), { name: 'BedrockModelTruncatedError' });
    invokeBedrockText.mockRejectedValue(truncated);
    await expect(generateProjectSkillDraft(base)).rejects.toThrow('cut off');
  });

  it('passes other model errors through', async () => {
    invokeBedrockText.mockRejectedValue(new Error('throttled'));
    await expect(generateProjectSkillDraft(base)).rejects.toThrow('throttled');
  });
});
describe('skill file conversion', () => {
  it('reads the text of a PDF, closes the parser, and adds .txt to the name', async () => {
    pdfGetText.mockResolvedValue({ text: 'Restart the queue worker\n' });
    const bytes = Buffer.from('%PDF-1.4 stand-in');
    const result = await extractSkillFileText({ fileName: 'runbook.pdf', base64: bytes.toString('base64') });
    expect(result).toEqual({ fileName: 'runbook.pdf.txt', content: 'Restart the queue worker' });
    expect(PDFParse).toHaveBeenCalledWith({ data: bytes });
    expect(pdfDestroy).toHaveBeenCalled();
  });

  it('reports a PDF it cannot parse', async () => {
    pdfGetText.mockRejectedValue(new Error('bad xref'));
    await expect(extractSkillFileText({ fileName: 'a.pdf', base64: Buffer.from('x').toString('base64') }))
      .rejects.toThrow('could not be read as a PDF file');
  });

  it('refuses other file types and empty files', async () => {
    await expect(extractSkillFileText({ fileName: 'a.png', base64: 'AAAA' }))
      .rejects.toBeInstanceOf(ProjectSkillDraftError);
    await expect(extractSkillFileText({ fileName: 'a.pdf', base64: '' }))
      .rejects.toThrow('is empty');
    await expect(extractSkillFileText({ fileName: 'a.docx', base64: Buffer.from('not a zip').toString('base64') }))
      .rejects.toThrow('could not be read as a Word file');
  });
});
