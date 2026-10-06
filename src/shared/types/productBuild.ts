/**
 * Contracts for a product build.
 * PRODUCT.md is the broad product. The build brief is one pull request.
 */

import type { RunCheckResult } from './agentRunLifecycle';

export const PRODUCT_BUILD_KINDS = ['initial', 'feature', 'bug', 'refinement'] as const;
export type ProductBuildKind = (typeof PRODUCT_BUILD_KINDS)[number];

export const PRODUCT_BUILD_STATUSES = [
  'discovery',
  'brief-confirmed',
  'prototype',
  'approved',
  'building',
  'pr-open',
  'merged',
  'failed',
] as const;
export type ProductBuildStatus = (typeof PRODUCT_BUILD_STATUSES)[number];

/** Plain words for a product-build status on the product home. */
export function productBuildStatusLabel(status: ProductBuildStatus): string {
  switch (status) {
    case 'discovery':
    case 'brief-confirmed':
      return 'Planning';
    case 'prototype':
      return 'Preview ready';
    case 'approved':
    case 'building':
      return 'Building';
    case 'pr-open':
      return 'Ready for review';
    case 'merged':
      return 'Live';
    case 'failed':
      return 'Needs attention';
    default: {
      const unreachable: never = status;
      return unreachable;
    }
  }
}

export const PRODUCT_BUILD_BRIEF_VERSION = 1;

export const PRODUCT_MARKDOWN_PATH = 'PRODUCT.md' as const;
export const BUILD_BRIEF_MARKDOWN_PATH = 'docs/product/BUILD_BRIEF.md' as const;
export const BUILD_MANIFEST_PATH = 'docs/product/build-manifest.json' as const;
export const PRODUCT_BUILD_AGENT_OUTPUT_PATH = '.ai-pilot/output/product-build-brief.json' as const;

/** First line of a product-build prototype prompt. UI generation uses it to skip another product's design system. */
export const NEW_PRODUCT_PROTOTYPE_MARKER = 'This prototype is a new application named "';

export const PRODUCT_BUILD_DEFAULT_STACK = {
  client: 'React + TypeScript + Vite',
  server: 'Express',
  database: 'PostgreSQL',
} as const;

const SHORT = 120;
const MEDIUM = 400;
const LONG = 2000;
const SCOPE = 4000;

const SLICE_KINDS: ReadonlySet<ProductBuildKind> = new Set(['initial', 'feature']);

export class ProductBuildBriefParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProductBuildBriefParseError';
  }
}

export interface ProductBuildPersona {
  name: string;
  goal: string;
}

export interface ProductBuildScreen {
  name: string;
  purpose: string;
}

export interface ProductBuildDataEntity {
  name: string;
  fields: string[];
}

export interface ProductBuildIntegration {
  name: string;
  purpose: string;
}

export interface ProductBuildAcceptanceCriterion {
  id: string;
  statement: string;
}

export interface ProductBuildProductContext {
  name: string;
  audience: string;
  problem: string;
  scopeSummary: string;
  successCriteria: string[];
}

/** The slice that ships in one pull request. It is not the whole product. */
export interface ProductBuildInitialSlice {
  summary: string;
  coreWorkflow: string;
  personas: ProductBuildPersona[];
  screens: ProductBuildScreen[];
  data: ProductBuildDataEntity[];
  integrations: ProductBuildIntegration[];
  auth: string;
  visualDirection: string;
  nonFunctionalRequirements: string[];
  acceptanceCriteria: ProductBuildAcceptanceCriterion[];
  outOfScope: string[];
  deferred: string[];
}

export interface ProductBuildStack {
  client: string;
  server: string;
  database: string;
  overrideReason: string | null;
}

export interface ProductBuildDeployment {
  localSetup: string;
  migrations: string;
  ci: string;
  hosting: string;
}

export interface ProductBuildSinglePrAssessment {
  fitsSinglePr: true;
  rationale: string;
}

export interface ProductBuildBrief {
  version: typeof PRODUCT_BUILD_BRIEF_VERSION;
  kind: ProductBuildKind;
  product: ProductBuildProductContext;
  initialBuild: ProductBuildInitialSlice;
  stack: ProductBuildStack;
  deployment: ProductBuildDeployment;
  singlePr: ProductBuildSinglePrAssessment;
  confirmedBy: string | null;
  confirmedAt: string | null;
}

export interface ProductBuild {
  id: string;
  kind: ProductBuildKind;
  status: ProductBuildStatus;
  project: string;
  rfpRequestId: string | null;
  chatThreadId: string | null;
  uiLabDesignId: string | null;
  prototypeVersion: number | null;
  devSessionId: string | null;
  agentRunId: string | null;
  brief: ProductBuildBrief | null;
  requesterId: string;
  reviewerId: string | null;
  adoWorkItemId: number | null;
  prUrl: string | null;
  errorMessage: string | null;
  approvedAt: string | null;
  prOpenedAt: string | null;
  mergedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One row on the product home build list. Newest first. */
export interface ProductBuildSummary {
  id: string;
  kind: ProductBuildKind;
  status: ProductBuildStatus;
  /** The first visible request, or the brief summary when the person did not type one. */
  request: string;
  summary: string;
  createdAt: string;
  mergedAt: string | null;
  outOfScope: string[];
  deferred: string[];
  designId: string | null;
  chatThreadId: string | null;
  adoWorkItemId: number | null;
  agentRunId: string | null;
  prUrl: string | null;
  checks: RunCheckResult[];
}

export interface ProductBuildStatusResponse {
  id: string;
  project: string;
  kind: ProductBuildKind;
  status: ProductBuildStatus;
  briefReady: boolean;
  prototypeReady: boolean;
  approved: boolean;
  adoWorkItemId: number | null;
  prUrl: string | null;
  errorMessage: string | null;
  updatedAt: string;
}

export interface ProductBuildArtifacts {
  [PRODUCT_MARKDOWN_PATH]: string;
  [BUILD_BRIEF_MARKDOWN_PATH]: string;
  [BUILD_MANIFEST_PATH]: string;
}

export function toProductBuildStatusResponse(build: ProductBuild): ProductBuildStatusResponse {
  return {
    id: build.id,
    project: build.project,
    kind: build.kind,
    status: build.status,
    briefReady: build.brief !== null,
    prototypeReady: build.uiLabDesignId !== null,
    approved: build.approvedAt !== null,
    adoWorkItemId: build.adoWorkItemId,
    prUrl: build.prUrl,
    errorMessage: build.errorMessage,
    updatedAt: build.updatedAt,
  };
}

export function parseProductBuildBrief(raw: unknown): ProductBuildBrief {
  const value = typeof raw === 'string' ? parseJson(raw) : raw;
  const brief = requireRecord(value, 'brief');
  assertKeys(brief, [
    'version',
    'kind',
    'product',
    'initialBuild',
    'stack',
    'deployment',
    'singlePr',
    'confirmedBy',
    'confirmedAt',
  ], [], 'brief');

  if (brief.version !== PRODUCT_BUILD_BRIEF_VERSION) {
    throw new ProductBuildBriefParseError('brief.version must be 1');
  }

  const kind = parseKind(brief.kind);
  const confirmed = parseConfirmed(brief.confirmedBy, brief.confirmedAt);
  return {
    version: PRODUCT_BUILD_BRIEF_VERSION,
    kind,
    product: parseProduct(brief.product),
    initialBuild: parseInitialBuild(brief.initialBuild, kind),
    stack: parseStack(brief.stack),
    deployment: parseDeployment(brief.deployment),
    singlePr: parseSinglePr(brief.singlePr),
    confirmedBy: confirmed.confirmedBy,
    confirmedAt: confirmed.confirmedAt,
  };
}

export function renderProductMarkdown(brief: ProductBuildBrief): string {
  const criteria = bulletList(brief.product.successCriteria);
  const record = brief.confirmedBy && brief.confirmedAt
    ? `Confirmed by ${brief.confirmedBy} on ${brief.confirmedAt}.`
    : 'Not yet confirmed.';
  return finish([
    '# Product',
    '',
    `${brief.product.name}. It is for ${brief.product.audience}.`,
    '',
    '# Problem',
    '',
    brief.product.problem,
    '',
    '# Product scope',
    '',
    brief.product.scopeSummary,
    '',
    `This file is the product north star. It is broader than any one pull request. The scope of one pull request is \`${BUILD_BRIEF_MARKDOWN_PATH}\`.`,
    '',
    '# Success criteria',
    '',
    criteria,
    '',
    '# Record',
    '',
    record,
  ]);
}

export function renderBuildBriefMarkdown(brief: ProductBuildBrief): string {
  const { initialBuild } = brief;
  const override = brief.stack.overrideReason
    ? `\n- Override: ${brief.stack.overrideReason}`
    : '';
  return finish([
    '# Build brief',
    '',
    'This file is the scope for one pull request. It is a subset of PRODUCT.md. Anything not listed here is outside this pull request.',
    '',
    `**Kind:** ${brief.kind}`,
    '',
    '## Summary',
    '',
    initialBuild.summary,
    '',
    '## Core workflow',
    '',
    initialBuild.coreWorkflow,
    '',
    '## Personas',
    '',
    namedList(initialBuild.personas, (item) => `**${item.name}.** ${item.goal}`),
    '',
    '## Screens',
    '',
    namedList(initialBuild.screens, (item) => `**${item.name}.** ${item.purpose}`),
    '',
    '## Data',
    '',
    namedList(initialBuild.data, (item) => `**${item.name}:** ${item.fields.join(', ')}`),
    '',
    '## Integrations',
    '',
    namedList(initialBuild.integrations, (item) => `**${item.name}.** ${item.purpose}`),
    '',
    '## Auth',
    '',
    initialBuild.auth,
    '',
    '## Visual direction',
    '',
    initialBuild.visualDirection,
    '',
    '## Non-functional requirements',
    '',
    bulletList(initialBuild.nonFunctionalRequirements),
    '',
    '## Acceptance criteria',
    '',
    namedList(initialBuild.acceptanceCriteria, (item) => `**${item.id}.** ${item.statement}`),
    '',
    '## Out of scope',
    '',
    bulletList(initialBuild.outOfScope),
    '',
    '## Deferred',
    '',
    'These stay in the product and are not part of this pull request.',
    '',
    bulletList(initialBuild.deferred),
    '',
    '## Stack',
    '',
    [
      `- Client: ${brief.stack.client}`,
      `- Server: ${brief.stack.server}`,
      `- Database: ${brief.stack.database}`,
    ].join('\n') + override,
    '',
    '## Deployment',
    '',
    [
      `- Local setup: ${brief.deployment.localSetup}`,
      `- Migrations: ${brief.deployment.migrations}`,
      `- CI: ${brief.deployment.ci}`,
      `- Hosting: ${brief.deployment.hosting}`,
    ].join('\n'),
    '',
    '## Single-PR assessment',
    '',
    'Fits one pull request: yes.',
    '',
    brief.singlePr.rationale,
  ]);
}

export function renderBuildManifest(brief: ProductBuildBrief): string {
  return `${JSON.stringify({
    version: brief.version,
    kind: brief.kind,
    artifacts: {
      productMarkdown: PRODUCT_MARKDOWN_PATH,
      buildBriefMarkdown: BUILD_BRIEF_MARKDOWN_PATH,
    },
    product: brief.product,
    initialBuild: brief.initialBuild,
    stack: brief.stack,
    deployment: brief.deployment,
    singlePr: brief.singlePr,
    confirmedBy: brief.confirmedBy,
    confirmedAt: brief.confirmedAt,
  }, null, 2)}\n`;
}

export function renderProductBuildArtifacts(brief: ProductBuildBrief): ProductBuildArtifacts {
  return {
    [PRODUCT_MARKDOWN_PATH]: renderProductMarkdown(brief),
    [BUILD_BRIEF_MARKDOWN_PATH]: renderBuildBriefMarkdown(brief),
    [BUILD_MANIFEST_PATH]: renderBuildManifest(brief),
  };
}

function parseJson(raw: string): unknown {
  // Agents on Windows often write a UTF-8 byte-order mark. JSON.parse rejects it.
  const text = raw.replace(/^\uFEFF/, '');
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProductBuildBriefParseError('The brief is not valid JSON');
  }
}

function parseKind(value: unknown): ProductBuildKind {
  if (typeof value === 'string' && (PRODUCT_BUILD_KINDS as readonly string[]).includes(value)) {
    return value as ProductBuildKind;
  }
  throw new ProductBuildBriefParseError('brief.kind must be initial, feature, bug, or refinement');
}

function parseProduct(value: unknown): ProductBuildProductContext {
  const product = requireRecord(value, 'product');
  assertKeys(product, ['name', 'audience', 'problem', 'scopeSummary', 'successCriteria'], [], 'product');
  const successCriteria = requireStringList(product.successCriteria, 'product.successCriteria', 6, MEDIUM);
  if (successCriteria.length < 1) {
    throw new ProductBuildBriefParseError('product.successCriteria needs at least one item');
  }
  return {
    name: requireText(product.name, 'product.name', SHORT),
    audience: requireText(product.audience, 'product.audience', SHORT),
    problem: requireText(product.problem, 'product.problem', LONG),
    scopeSummary: requireText(product.scopeSummary, 'product.scopeSummary', SCOPE),
    successCriteria,
  };
}

function parseInitialBuild(value: unknown, kind: ProductBuildKind): ProductBuildInitialSlice {
  const slice = requireRecord(value, 'initialBuild');
  assertKeys(slice, [
    'summary',
    'coreWorkflow',
    'personas',
    'screens',
    'data',
    'integrations',
    'auth',
    'visualDirection',
    'nonFunctionalRequirements',
    'acceptanceCriteria',
    'outOfScope',
    'deferred',
  ], [], 'initialBuild');

  const personas = parseNamedList(slice.personas, 'initialBuild.personas', 4, [
    ['name', SHORT],
    ['goal', MEDIUM],
  ]);
  const screens = parseNamedList(slice.screens, 'initialBuild.screens', 6, [
    ['name', SHORT],
    ['purpose', MEDIUM],
  ]);
  const data = parseData(slice.data);
  const integrations = parseNamedList(slice.integrations, 'initialBuild.integrations', 3, [
    ['name', SHORT],
    ['purpose', MEDIUM],
  ]);
  const acceptanceCriteria = parseAcceptanceCriteria(slice.acceptanceCriteria);

  if (SLICE_KINDS.has(kind) && personas.length < 1) {
    throw new ProductBuildBriefParseError(`A ${kind} build needs at least one persona`);
  }
  if (SLICE_KINDS.has(kind) && screens.length < 1) {
    throw new ProductBuildBriefParseError(`A ${kind} build needs at least one screen`);
  }

  rejectDuplicate(personas.map((item) => item.name), 'persona');
  rejectDuplicate(screens.map((item) => item.name), 'screen');
  rejectDuplicate(data.map((item) => item.name), 'data entity');

  return {
    summary: requireText(slice.summary, 'initialBuild.summary', MEDIUM),
    coreWorkflow: requireText(slice.coreWorkflow, 'initialBuild.coreWorkflow', LONG),
    personas,
    screens,
    data,
    integrations,
    auth: requireText(slice.auth, 'initialBuild.auth', LONG),
    visualDirection: requireText(slice.visualDirection, 'initialBuild.visualDirection', LONG),
    nonFunctionalRequirements: requireStringList(
      slice.nonFunctionalRequirements,
      'initialBuild.nonFunctionalRequirements',
      5,
      MEDIUM,
    ),
    acceptanceCriteria,
    outOfScope: requireStringList(slice.outOfScope, 'initialBuild.outOfScope', 8, MEDIUM),
    deferred: requireStringList(slice.deferred, 'initialBuild.deferred', 8, MEDIUM),
  };
}

function parseStack(value: unknown): ProductBuildStack {
  const stack = requireRecord(value, 'stack');
  assertKeys(stack, ['client', 'server', 'database'], ['overrideReason'], 'stack');
  const client = requireText(stack.client, 'stack.client', SHORT);
  const server = requireText(stack.server, 'stack.server', SHORT);
  const database = requireText(stack.database, 'stack.database', SHORT);
  const overrideReason = stack.overrideReason === undefined
    ? null
    : nullableText(stack.overrideReason, 'stack.overrideReason', MEDIUM);
  const isDefault = client === PRODUCT_BUILD_DEFAULT_STACK.client
    && server === PRODUCT_BUILD_DEFAULT_STACK.server
    && database === PRODUCT_BUILD_DEFAULT_STACK.database;
  if (!isDefault && !overrideReason) {
    throw new ProductBuildBriefParseError('stack.overrideReason is required when the stack is not the default');
  }
  if (isDefault && overrideReason) {
    throw new ProductBuildBriefParseError('stack.overrideReason must be empty when the stack is the default');
  }
  return { client, server, database, overrideReason };
}

function parseDeployment(value: unknown): ProductBuildDeployment {
  const deployment = requireRecord(value, 'deployment');
  assertKeys(deployment, ['localSetup', 'migrations', 'ci', 'hosting'], [], 'deployment');
  return {
    localSetup: requireText(deployment.localSetup, 'deployment.localSetup', MEDIUM),
    migrations: requireText(deployment.migrations, 'deployment.migrations', MEDIUM),
    ci: requireText(deployment.ci, 'deployment.ci', MEDIUM),
    hosting: requireText(deployment.hosting, 'deployment.hosting', MEDIUM),
  };
}

function parseSinglePr(value: unknown): ProductBuildSinglePrAssessment {
  const singlePr = requireRecord(value, 'singlePr');
  assertKeys(singlePr, ['fitsSinglePr', 'rationale'], [], 'singlePr');
  if (typeof singlePr.fitsSinglePr !== 'boolean') {
    throw new ProductBuildBriefParseError('singlePr.fitsSinglePr must be true or false');
  }
  if (!singlePr.fitsSinglePr) {
    throw new ProductBuildBriefParseError('Trim the brief until it fits one pull request');
  }
  return {
    fitsSinglePr: true,
    rationale: requireText(singlePr.rationale, 'singlePr.rationale', LONG),
  };
}

function parseConfirmed(by: unknown, at: unknown): { confirmedBy: string | null; confirmedAt: string | null } {
  const confirmedBy = nullableText(by, 'confirmedBy', SHORT);
  const confirmedAt = nullableText(at, 'confirmedAt', 40);
  if ((confirmedBy === null) !== (confirmedAt === null)) {
    throw new ProductBuildBriefParseError('confirmedBy and confirmedAt must both be set or both be null');
  }
  if (confirmedAt !== null && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(confirmedAt)) {
    throw new ProductBuildBriefParseError('confirmedAt must be a UTC timestamp');
  }
  return { confirmedBy, confirmedAt };
}

function parseData(value: unknown): ProductBuildDataEntity[] {
  const items = requireArray(value, 'initialBuild.data');
  if (items.length > 6) {
    throw new ProductBuildBriefParseError('initialBuild.data has too many items');
  }
  return items.map((item, index) => {
    const where = `initialBuild.data[${index}]`;
    const record = requireRecord(item, where);
    assertKeys(record, ['name', 'fields'], [], where);
    const fields = requireStringList(record.fields, `${where}.fields`, 12, MEDIUM);
    if (fields.length < 1) {
      throw new ProductBuildBriefParseError(`${where}.fields needs at least one field`);
    }
    return { name: requireText(record.name, `${where}.name`, SHORT), fields };
  });
}

function parseAcceptanceCriteria(value: unknown): ProductBuildAcceptanceCriterion[] {
  const items = requireArray(value, 'initialBuild.acceptanceCriteria');
  if (items.length < 1) {
    throw new ProductBuildBriefParseError('initialBuild.acceptanceCriteria needs at least one acceptance criterion');
  }
  if (items.length > 8) {
    throw new ProductBuildBriefParseError('initialBuild.acceptanceCriteria has too many items');
  }
  const criteria = items.map((item, index) => {
    const where = `initialBuild.acceptanceCriteria[${index}]`;
    const record = requireRecord(item, where);
    assertKeys(record, ['id', 'statement'], [], where);
    const id = requireText(record.id, `${where}.id`, SHORT);
    if (!/^AC-[1-9][0-9]*$/.test(id)) {
      throw new ProductBuildBriefParseError(`${where}.id must look like AC-1`);
    }
    return { id, statement: requireText(record.statement, `${where}.statement`, MEDIUM) };
  });
  rejectDuplicate(criteria.map((item) => item.id), 'acceptance criterion id');
  return criteria;
}

function parseNamedList<K extends string>(
  value: unknown,
  where: string,
  max: number,
  fields: ReadonlyArray<readonly [K, number]>,
): Array<Record<K, string>> {
  const items = requireArray(value, where);
  if (items.length > max) {
    throw new ProductBuildBriefParseError(`${where} has too many items`);
  }
  const keys = fields.map(([key]) => key);
  return items.map((item, index) => {
    const itemWhere = `${where}[${index}]`;
    const record = requireRecord(item, itemWhere);
    assertKeys(record, keys, [], itemWhere);
    const parsed = {} as Record<K, string>;
    for (const [key, limit] of fields) {
      parsed[key] = requireText(record[key], `${itemWhere}.${key}`, limit);
    }
    return parsed;
  });
}

function requireStringList(value: unknown, where: string, max: number, itemMax: number): string[] {
  const items = requireArray(value, where);
  if (items.length > max) {
    throw new ProductBuildBriefParseError(`${where} has too many items`);
  }
  return items.map((item, index) => requireText(item, `${where}[${index}]`, itemMax));
}

function rejectDuplicate(values: string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) {
      throw new ProductBuildBriefParseError(`${label} "${value}" is duplicated`);
    }
    seen.add(key);
  }
}

function requireRecord(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProductBuildBriefParseError(`${where} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ProductBuildBriefParseError(`${where} must be a list`);
  }
  return value;
}

function assertKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  where: string,
): void {
  const allowed = new Set<string>([...required, ...optional]);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new ProductBuildBriefParseError(`${where} has unknown field "${key}"`);
    }
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new ProductBuildBriefParseError(`${where}.${key} is required`);
    }
  }
}

function requireText(value: unknown, where: string, max: number): string {
  if (typeof value !== 'string') {
    throw new ProductBuildBriefParseError(`${where} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ProductBuildBriefParseError(`${where} is required`);
  }
  if (trimmed.length > max) {
    throw new ProductBuildBriefParseError(`${where} is too long`);
  }
  if (/[\r\n]/.test(trimmed)) {
    throw new ProductBuildBriefParseError(`${where} must be a single line`);
  }
  return trimmed;
}

function nullableText(value: unknown, where: string, max: number): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new ProductBuildBriefParseError(`${where} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > max) {
    throw new ProductBuildBriefParseError(`${where} is too long`);
  }
  if (/[\r\n]/.test(trimmed)) {
    throw new ProductBuildBriefParseError(`${where} must be a single line`);
  }
  return trimmed;
}

function bulletList(items: string[]): string {
  if (items.length === 0) return 'None.';
  return items.map((item) => `- ${item}`).join('\n');
}

function namedList<T>(items: T[], format: (item: T) => string): string {
  if (items.length === 0) return 'None.';
  return items.map((item) => `- ${format(item)}`).join('\n');
}

function finish(lines: string[]): string {
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}
