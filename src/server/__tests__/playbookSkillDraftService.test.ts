const invokeBedrockText = jest.fn();
jest.mock('../services/bedrockService', () => ({
  invokeBedrockText: (...args: unknown[]) => invokeBedrockText(...args),
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
  beforeEach(() => invokeBedrockText.mockReset());

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
