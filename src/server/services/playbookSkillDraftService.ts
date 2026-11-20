import * as mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import { invokeBedrockText } from './bedrockService';

const MAX_REQUEST_LENGTH = 4_000;
const MAX_DESCRIPTION_LENGTH = 300;
const MAX_INSTRUCTIONS_BYTES = 150_000;
const MAX_FILE_TEXT_BYTES = 1_000_000;
const MAX_CONVERTED_FILE_BYTES = 5_000_000;

export class ProjectSkillDraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectSkillDraftError';
  }
}

export interface ProjectSkillDraft {
  description: string;
  instructions: string;
}

function buildPrompt(input: {
  title: string;
  skillType: 'autonomous' | 'interactive';
  request: string;
}): string {
  const mode = input.skillType === 'interactive'
    ? 'The agent chats with a person during a Playbook run, then proposes a final result for that person to approve.'
    : 'The agent runs on its own inside a Playbook run and returns its result when it is done.';
  return [
    'You write SKILL.md instructions for an AI coding agent that runs inside an Apex Playbook.',
    mode,
    'The agent can read the project repository. It cannot write files, call cloud tools, or reach the internet.',
    '',
    'Return JSON only, with this exact shape:',
    '{"description":"one sentence saying what the skill does and when to use it","instructions":"the skill body in Markdown"}',
    '',
    'Rules for the instructions:',
    '- Start with a short purpose, then numbered steps the agent follows, then what the final answer must contain.',
    '- Write plain, direct sentences addressed to the agent.',
    '- Do not include YAML frontmatter, a title line that repeats the skill name, secrets, or placeholder credentials.',
    '- Do not ask for capabilities or tools the agent does not have.',
    '',
    `Skill title: ${input.title}`,
    `What the skill should do: ${input.request}`,
  ].join('\n');
}

function extractJson(text: string): Record<string, unknown> {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1] ?? text;
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  if (first < 0 || last <= first) {
    throw new ProjectSkillDraftError('The AI reply did not contain a draft. Try again.');
  }
  try {
    const parsed = JSON.parse(candidate.slice(first, last + 1)) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Reported below.
  }
  throw new ProjectSkillDraftError('The AI reply did not contain a draft. Try again.');
}

function stripFrontmatter(body: string): string {
  return body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
}

/** A draft for the author to edit. Nothing is saved here. */
export async function generateProjectSkillDraft(input: {
  project: string;
  userId: string;
  title: string;
  skillType: 'autonomous' | 'interactive';
  request: string;
}): Promise<ProjectSkillDraft> {
  const title = input.title.trim();
  const request = input.request.trim();
  if (!title) throw new ProjectSkillDraftError('A title is required.');
  if (!request) throw new ProjectSkillDraftError('Say what the skill should do.');
  if (request.length > MAX_REQUEST_LENGTH) {
    throw new ProjectSkillDraftError(`Keep the request under ${MAX_REQUEST_LENGTH} characters.`);
  }

  const reply = await invokeBedrockText(
    buildPrompt({ title, skillType: input.skillType, request }),
    {
      feature: 'other',
      project: input.project,
      entityType: 'playbook-skill-draft',
      userId: input.userId,
    },
    { maxTokens: 8192 },
  );
  const parsed = extractJson(reply);
  const description = typeof parsed.description === 'string' ? parsed.description.trim() : '';
  const instructions = typeof parsed.instructions === 'string' ? stripFrontmatter(parsed.instructions) : '';
  if (!description || !instructions) {
    throw new ProjectSkillDraftError('The AI reply did not contain a draft. Try again.');
  }
  if (Buffer.byteLength(instructions, 'utf8') > MAX_INSTRUCTIONS_BYTES) {
    throw new ProjectSkillDraftError('The draft came back too long. Narrow the request and try again.');
  }
  return {
    description: description.slice(0, MAX_DESCRIPTION_LENGTH),
    instructions,
  };
}

async function pdfText(bytes: Buffer): Promise<string> {
  const parser = new PDFParse({ data: bytes });
  try {
    return (await parser.getText()).text;
  } finally {
    await parser.destroy();
  }
}

/** Word and PDF files are stored as their text, under the original name with `.txt` added. */
export async function extractSkillFileText(input: {
  fileName: string;
  base64: string;
}): Promise<{ fileName: string; content: string }> {
  const kind = /\.docx$/i.test(input.fileName) ? 'Word' : /\.pdf$/i.test(input.fileName) ? 'PDF' : null;
  if (!kind) {
    throw new ProjectSkillDraftError('Only Word (.docx) and PDF files are converted here.');
  }
  const bytes = Buffer.from(input.base64, 'base64');
  if (bytes.byteLength === 0) throw new ProjectSkillDraftError(`"${input.fileName}" is empty.`);
  if (bytes.byteLength > MAX_CONVERTED_FILE_BYTES) {
    throw new ProjectSkillDraftError(`"${input.fileName}" is over 5 MB.`);
  }
  let content: string;
  try {
    content = kind === 'Word'
      ? (await mammoth.extractRawText({ buffer: bytes })).value.trim()
      : (await pdfText(bytes)).trim();
  } catch {
    throw new ProjectSkillDraftError(`"${input.fileName}" could not be read as a ${kind} file.`);
  }
  if (!content) throw new ProjectSkillDraftError(`"${input.fileName}" has no text.`);
  const textBytes = Buffer.byteLength(content, 'utf8');
  if (textBytes > MAX_FILE_TEXT_BYTES) {
    throw new ProjectSkillDraftError(
      `The text in "${input.fileName}" is ${(textBytes / 1_000_000).toFixed(1)} MB after conversion. The limit is 1 MB.`,
    );
  }
  return { fileName: `${input.fileName}.txt`, content };
}
