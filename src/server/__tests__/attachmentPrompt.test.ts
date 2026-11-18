import {
  buildPromptWithAttachments,
  promptWithAttachments,
} from '../services/attachmentPrompt';

const imagePath = '.ai-pilot/attachments/turn-1/screenshot.png';
const notesPath = '.ai-pilot/attachments/turn-1/notes.txt';

describe('attachment prompt builders', () => {
  it('points the agent at an image file and does not mark a text file as an image', () => {
    const prompt = buildPromptWithAttachments('See the screenshot', [
      {
        id: 'img',
        name: 'screenshot.png',
        type: 'image/png',
        size: 12,
        path: imagePath,
      },
      {
        id: 'notes',
        name: 'notes.txt',
        type: 'text/plain',
        size: 4,
        path: notesPath,
      },
    ]);

    const imageLine = prompt
      .split('\n')
      .find((line) => line.includes('screenshot.png'));
    const notesLine = prompt
      .split('\n')
      .find((line) => line.includes('notes.txt'));

    expect(imageLine).toContain(imagePath);
    expect(imageLine).toContain(
      '[IMAGE -- use the Read tool to view this file]'
    );
    expect(notesLine).toContain(notesPath);
    expect(notesLine).not.toContain('[IMAGE');
    expect(prompt).toContain('See the screenshot');
  });

  it('marks a durable image attachment with [IMAGE] and leaves other files unmarked', () => {
    const prompt = promptWithAttachments('See the screenshot', [
      {
        name: 'screenshot.png',
        contentType: 'image/png',
        sizeBytes: 12,
        materializedPath: imagePath,
      },
      {
        name: 'notes.txt',
        contentType: 'text/plain',
        sizeBytes: 4,
        materializedPath: notesPath,
      },
    ]);

    const imageLine = prompt
      .split('\n')
      .find((line) => line.includes('screenshot.png'));
    const notesLine = prompt
      .split('\n')
      .find((line) => line.includes('notes.txt'));

    expect(imageLine).toContain(imagePath);
    expect(imageLine).toContain('[IMAGE]');
    expect(imageLine).not.toContain(
      '[IMAGE -- use the Read tool to view this file]'
    );
    expect(notesLine).toContain(notesPath);
    expect(notesLine).not.toContain('[IMAGE');
  });

  it('returns the original text when a chat turn has no attachments', () => {
    expect(buildPromptWithAttachments('hello', [])).toBe('hello');
    expect(promptWithAttachments('hello', [])).toBe('hello');
    expect(promptWithAttachments('   ', [])).toBe(
      'Please use the uploaded files as additional context.'
    );
  });
});
