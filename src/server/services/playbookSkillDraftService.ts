import * as mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import { invokeBedrockText, listAvailableBedrockModels } from './bedrockService';

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
    'Reply in exactly this shape and write nothing before or after it:',
    '<description>one sentence saying what the skill does and when to use it</description>',
    '<instructions>',
    'the skill body in Markdown, written as plain text with real line breaks',
    '</instructions>',
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

const UNREADABLE_REPLY =
  'The AI answered in a form Apex could not read. Try again, or pick a different model.';

/** Parses an object from a reply that holds JSON, bare or inside a Markdown code fence. */
function parseJsonObject(text: string): Record<string, unknown> | null {
  const candidates: string[] = [text.trim()];
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(text.trim());
  if (fenced) candidates.push(fenced[1]);
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next shape.
    }
  }
  return null;
}

/**
 * Reads the model's reply. The prompt asks for tagged text because Markdown inside a JSON string
 * breaks easily: raw line breaks, unescaped quotes and code fences all defeat a JSON parse.
 * A JSON reply is still accepted, since some models answer that way regardless.
 */
function parseDraftReply(text: string): { description: string; instructions: string } | null {
  const description = /<description>([\s\S]*?)<\/description>/i.exec(text)?.[1];
  const opened = /<instructions>/i.exec(text);
  if (description !== undefined && opened) {
    const rest = text.slice(opened.index + opened[0].length);
    const closed = rest.search(/<\/instructions>\s*$/i);
    return {
      description: description.trim(),
      instructions: (closed >= 0 ? rest.slice(0, closed) : rest.replace(/<\/instructions>[\s\S]*$/i, '')).trim(),
    };
  }
  const parsed = parseJsonObject(text);
  if (!parsed) return null;
  return {
    description: typeof parsed.description === 'string' ? parsed.description.trim() : '',
    instructions: typeof parsed.instructions === 'string' ? parsed.instructions.trim() : '',
  };
}
function stripFrontmatter(body: string): string {
  return body.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
}

/** The Bedrock models an author can pick for a draft. The service default is used when none is picked. */
export async function listSkillDraftModels(): Promise<{ id: string; label: string }[]> {
  return (await listAvailableBedrockModels()).map((model) => ({ id: model.id, label: model.label }));
}

/** A draft for the author to edit. Nothing is saved here. */
export async function generateProjectSkillDraft(input: {
  project: string;
  userId: string;
  title: string;
  skillType: 'autonomous' | 'interactive';
  request: string;
  /** A Bedrock model id from listSkillDraftModels(). Blank uses the service default. */
  modelId?: string;
}): Promise<ProjectSkillDraft> {
  const title = input.title.trim();
  const request = input.request.trim();
  if (!title) throw new ProjectSkillDraftError('A title is required.');
  if (!request) throw new ProjectSkillDraftError('Say what the skill should do.');
  if (request.length > MAX_REQUEST_LENGTH) {
    throw new ProjectSkillDraftError(`Keep the request under ${MAX_REQUEST_LENGTH} characters.`);
  }
  const modelId = input.modelId?.trim() || undefined;
  if (modelId && !(await listSkillDraftModels()).some((model) => model.id === modelId)) {
    throw new ProjectSkillDraftError('That model is not available for drafts. Pick another and try again.');
  }

  let reply: string;
  try {
    reply = await invokeBedrockText(
      buildPrompt({ title, skillType: input.skillType, request }),
      {
        feature: 'other',
        project: input.project,
        entityType: 'playbook-skill-draft',
        userId: input.userId,
      },
      { maxTokens: 8192, modelId },
    );
  } catch (error) {
    // Matched by name so this file does not need the Bedrock error class at import time.
    if (error instanceof Error && error.name === 'BedrockModelTruncatedError') {
      throw new ProjectSkillDraftError('The draft was cut off because it ran too long. Narrow the request and try again.');
    }
    throw error;
  }
  if (!reply.trim()) {
    throw new ProjectSkillDraftError('The AI sent back an empty reply. Try again, or pick a different model.');
  }
  const parsed = parseDraftReply(reply);
  if (!parsed) {
    console.warn(
      `[playbook-skill-draft] unreadable reply (${reply.length} chars): ${JSON.stringify(reply.slice(0, 200))}`,
    );
    throw new ProjectSkillDraftError(UNREADABLE_REPLY);
  }
  const description = parsed.description;
  const instructions = stripFrontmatter(parsed.instructions);
  if (!description || !instructions) {
    console.warn(
      `[playbook-skill-draft] reply missing ${description ? 'instructions' : 'description'} (${reply.length} chars)`,
    );
    throw new ProjectSkillDraftError(
      `The AI reply had no ${description ? 'instructions' : 'description'}. Try again, or add more detail to the request.`,
    );
  }  if (Buffer.byteLength(instructions, 'utf8') > MAX_INSTRUCTIONS_BYTES) {
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
