import { RFP_APPS_ADO_PROJECT } from '../../shared/types/rfpIntake';
import { completePlainTextWithBedrock, type BedrockUsageContext } from './bedrockService';
import { AzureDevOpsService } from './azureDevOps';
import { ProductFoundationError, requireOpenProductSetup } from './productSetupService';

const ANSWER_COUNT = 4;
const MAX_ANSWER_LENGTH = 4000;
const MAX_CHANGE_LENGTH = 4000;
const MAX_DRAFT_LENGTH = 20000;
const DRAFT_MAX_TOKENS = 4096;

const ANSWER_LABELS = [
  'Product and audience',
  'Problem',
  'In scope for the first release',
  'Success criteria',
] as const;

const DOCUMENT_RULES = [
  'Use only what the person stated. Do not add features, users, or success criteria they did not state.',
  'If an answer is vague, says they are not sure, or says they have nothing in mind, write "None specified" for that section.',
  'Keep the document to about two pages.',
  'Use these sections, in this order: # Product Foundation, ## Product, ## Problem, ## First release, ## Success criteria, ## Record.',
  'Record must name who answered and the date given below.',
  'Return only the markdown document. No code fence. No questions. No confirmation prompt.',
].join('\n');

export interface ProductFoundationDeps {
  openSetup: (project: string, userId: string) => Promise<{ repoName: string }>;
  complete: (prompt: string, usage: BedrockUsageContext) => Promise<string>;
  writeProduct: (repoName: string, markdown: string) => Promise<void>;
  now: () => Date;
}

const defaultDeps: ProductFoundationDeps = {
  openSetup: requireOpenProductSetup,
  complete: (prompt, usage) => completePlainTextWithBedrock(prompt, usage, { maxTokens: DRAFT_MAX_TOKENS }),
  writeProduct: (repoName, markdown) => new AzureDevOpsService(RFP_APPS_ADO_PROJECT).pushRepositoryFiles(
    RFP_APPS_ADO_PROJECT,
    repoName,
    'main',
    'Add PRODUCT.md',
    [{ path: 'PRODUCT.md', content: markdown }],
  ),
  now: () => new Date(),
};

export interface ProductFoundationRequest {
  project: string;
  userId: string;
  answeredBy: string;
}

function usage(project: string, userId: string): BedrockUsageContext {
  return { feature: 'product-foundation', project, userId, entityType: 'product-foundation' };
}

export function assertFoundationAnswers(answers: unknown): string[] {
  if (!Array.isArray(answers) || answers.length !== ANSWER_COUNT) {
    throw new ProductFoundationError('Four answers are required.', 400, 'INVALID_ANSWERS');
  }
  return answers.map((answer, index) => {
    if (typeof answer !== 'string' || !answer.trim()) {
      throw new ProductFoundationError(`Answer ${index + 1} is required.`, 400, 'INVALID_ANSWERS');
    }
    const trimmed = answer.trim();
    if (trimmed.length > MAX_ANSWER_LENGTH) {
      throw new ProductFoundationError(`Answer ${index + 1} is too long.`, 400, 'INVALID_ANSWERS');
    }
    return trimmed;
  });
}

export function productMarkdownFromModel(text: string): string {
  const trimmed = text.trim().replace(/^>\s*Auto routed to[^\n]*\n+/i, '');
  const fence = trimmed.match(/^```(?:markdown|md)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i);
  const body = (fence ? fence[1] : trimmed)
    .replace(/\n+[^\n]*(please confirm|confirm or correct)[\s\S]*$/i, '')
    .trim();
  if (!/^#\s+\S/m.test(body)) {
    throw new ProductFoundationError('The draft did not come back as a product document.', 502, 'INVALID_DRAFT');
  }
  if (body.length > MAX_DRAFT_LENGTH) {
    throw new ProductFoundationError('The draft is too long.', 502, 'INVALID_DRAFT');
  }
  return `${body}\n`;
}

function answerLines(answers: string[]): string {
  return answers.map((answer, index) => `${index + 1}. ${ANSWER_LABELS[index]}: ${answer}`).join('\n');
}

export function buildProductDraftPrompt(answers: string[], answeredBy: string, date: string): string {
  return [
    'Write PRODUCT.md for a new product.',
    DOCUMENT_RULES,
    '',
    `Answered by: ${answeredBy}`,
    `Date: ${date}`,
    '',
    answerLines(answers),
  ].join('\n');
}

export function buildProductRevisionPrompt(draft: string, changes: string, date: string): string {
  return [
    'Revise this PRODUCT.md. Apply only the requested change. Leave every other section as written.',
    DOCUMENT_RULES,
    '',
    `Date: ${date}`,
    '',
    'Requested change:',
    changes,
    '',
    'Current draft:',
    draft,
  ].join('\n');
}

function dateStamp(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export async function draftProductFoundation(
  request: ProductFoundationRequest & { answers: unknown },
  deps: ProductFoundationDeps = defaultDeps,
): Promise<string> {
  const answers = assertFoundationAnswers(request.answers);
  await deps.openSetup(request.project, request.userId);
  const text = await deps.complete(
    buildProductDraftPrompt(answers, request.answeredBy, dateStamp(deps.now())),
    usage(request.project, request.userId),
  );
  return productMarkdownFromModel(text);
}

export async function reviseProductFoundation(
  request: ProductFoundationRequest & { draft: unknown; changes: unknown },
  deps: ProductFoundationDeps = defaultDeps,
): Promise<string> {
  if (typeof request.draft !== 'string' || !request.draft.trim()) {
    throw new ProductFoundationError('A draft is required.', 400, 'INVALID_DRAFT');
  }
  if (typeof request.changes !== 'string' || !request.changes.trim()) {
    throw new ProductFoundationError('Say what should change.', 400, 'INVALID_CHANGES');
  }
  const changes = request.changes.trim();
  if (changes.length > MAX_CHANGE_LENGTH) {
    throw new ProductFoundationError('The change request is too long.', 400, 'INVALID_CHANGES');
  }
  const draft = productMarkdownFromModel(request.draft);
  await deps.openSetup(request.project, request.userId);
  const text = await deps.complete(
    buildProductRevisionPrompt(draft, changes, dateStamp(deps.now())),
    usage(request.project, request.userId),
  );
  return productMarkdownFromModel(text);
}

export async function saveProductFoundation(
  request: ProductFoundationRequest & { markdown: unknown },
  deps: ProductFoundationDeps = defaultDeps,
): Promise<void> {
  if (typeof request.markdown !== 'string' || !request.markdown.trim()) {
    throw new ProductFoundationError('A draft is required.', 400, 'INVALID_DRAFT');
  }
  const markdown = productMarkdownFromModel(request.markdown);
  const { repoName } = await deps.openSetup(request.project, request.userId);
  await deps.writeProduct(repoName, markdown);
}
