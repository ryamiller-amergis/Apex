import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { asc, eq } from 'drizzle-orm';
import { db } from '../db/drizzle';
import { chatThreads, designModules } from '../db/schema';
import { getDefaultModel } from './appSettingsService';
import { createThread, isThreadIdle, sendMessage } from './chatAgentService';
import { resolveSkillConfig } from './projectSettingsService';
import {
  DESIGN_MODULE_ICON_KEYS,
  type CreateDesignModuleInput,
  type DesignModule,
  type DesignModuleSummary,
  type RegenerateDesignModuleResult,
  type UpdateDesignModuleInput,
} from '../../shared/types/designModule';

const DESIGN_MODULE_SKILL_PATH = '.cursor/skills/design-module-doc/SKILL.md';
const OUTPUT_FILE = 'design-module.md';
const WATCHER_INTERVAL_MS = 5_000;
const WATCHER_MAX_ATTEMPTS = 720;
const activeWatchers = new Map<string, ReturnType<typeof setInterval>>();
const ignoredDirectories = new Set([
  '.git',
  'node_modules',
  'dist',
  'coverage',
  'data',
]);

interface FingerprintResult {
  fingerprint: string | null;
  sourceAvailable: boolean;
  files: string[];
}

function serviceError(message: string, status: number): Error {
  const error = new Error(message);
  (error as Error & { status?: number }).status = status;
  return error;
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

function validateSourceGlobs(
  sourceGlobs: unknown
): asserts sourceGlobs is string[] {
  if (!Array.isArray(sourceGlobs) || sourceGlobs.length === 0) {
    throw serviceError('sourceGlobs must be a non-empty string array', 400);
  }
  for (const glob of sourceGlobs) {
    if (typeof glob !== 'string' || !glob.trim()) {
      throw serviceError('sourceGlobs must contain non-empty strings', 400);
    }
    const normalized = normalizeRelativePath(glob.trim());
    if (
      path.isAbsolute(glob) ||
      normalized === '..' ||
      normalized.startsWith('../')
    ) {
      throw serviceError('sourceGlobs must stay within the repository', 400);
    }
  }
}

function validateInput(
  input: CreateDesignModuleInput | UpdateDesignModuleInput,
  creating: boolean
): void {
  if (creating || input.slug !== undefined) {
    if (!input.slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.slug)) {
      throw serviceError(
        'slug must use lowercase letters, numbers, and single hyphens',
        400
      );
    }
  }
  if (creating || input.label !== undefined) {
    if (!input.label?.trim()) throw serviceError('label is required', 400);
  }
  if (creating || input.iconKey !== undefined) {
    if (!input.iconKey || !DESIGN_MODULE_ICON_KEYS.includes(input.iconKey)) {
      throw serviceError('iconKey is not supported', 400);
    }
  }
  if (creating || input.sourceGlobs !== undefined)
    validateSourceGlobs(input.sourceGlobs);
  if (
    input.sortOrder !== undefined &&
    (!Number.isInteger(input.sortOrder) || input.sortOrder < 0)
  ) {
    throw serviceError('sortOrder must be a non-negative integer', 400);
  }
}

function globToRegExp(glob: string): RegExp {
  const normalized = normalizeRelativePath(glob);
  let pattern = '^';
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === '*' && normalized[index + 1] === '*') {
      if (normalized[index + 2] === '/') {
        pattern += '(?:.*/)?';
        index += 2;
      } else {
        pattern += '.*';
        index += 1;
      }
    } else if (character === '*') {
      pattern += '[^/]*';
    } else if (character === '?') {
      pattern += '[^/]';
    } else {
      pattern += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    }
  }
  return new RegExp(`${pattern}$`);
}

function walkRepository(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolutePath);
      else if (entry.isFile())
        files.push(normalizeRelativePath(path.relative(root, absolutePath)));
    }
  };
  visit(root);
  return files;
}

export function computeFingerprint(
  sourceGlobs: string[],
  repositoryRoot = process.cwd()
): FingerprintResult {
  validateSourceGlobs(sourceGlobs);
  const matchers = sourceGlobs.map((glob) => globToRegExp(glob.trim()));
  const files = walkRepository(repositoryRoot)
    .filter((file) => matchers.some((matcher) => matcher.test(file)))
    .sort((a, b) => a.localeCompare(b));

  if (files.length === 0)
    return { fingerprint: null, sourceAvailable: false, files: [] };

  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(file);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(repositoryRoot, file)));
    hash.update('\0');
  }
  return { fingerprint: hash.digest('hex'), sourceAvailable: true, files };
}

export function getSourceCommit(repositoryRoot = process.cwd()): string | null {
  try {
    return (
      execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

function withStaleness(row: typeof designModules.$inferSelect): DesignModule {
  const current = computeFingerprint(row.sourceGlobs);
  const currentCommit = current.sourceAvailable ? null : getSourceCommit();
  const sourceChanged = current.sourceAvailable
    ? current.fingerprint !== row.sourceFingerprint
    : Boolean(
        row.sourceCommit && currentCommit && row.sourceCommit !== currentCommit
      );

  return {
    ...row,
    iconKey: row.iconKey,
    hasContent: Boolean(row.content?.trim()),
    isStale: !row.content?.trim() || sourceChanged,
    sourceAvailable: current.sourceAvailable,
  };
}

function toSummary(module: DesignModule): DesignModuleSummary {
  const {
    content: _content,
    sourceFingerprint: _sourceFingerprint,
    sourceCommit: _sourceCommit,
    createdBy: _createdBy,
    updatedBy: _updatedBy,
    ...summary
  } = module;
  return summary;
}

export async function listModules(): Promise<DesignModuleSummary[]> {
  const rows = await db
    .select()
    .from(designModules)
    .orderBy(asc(designModules.sortOrder), asc(designModules.label));
  return rows.map((row) => toSummary(withStaleness(row)));
}

export async function getModule(slug: string): Promise<DesignModule | null> {
  const row = await db.query.designModules.findFirst({
    where: eq(designModules.slug, slug),
  });
  return row ? withStaleness(row) : null;
}

export async function createModule(
  input: CreateDesignModuleInput,
  actorId: string
): Promise<DesignModule> {
  validateInput(input, true);
  const fingerprint = computeFingerprint(input.sourceGlobs);
  try {
    const [created] = await db
      .insert(designModules)
      .values({
        slug: input.slug,
        label: input.label.trim(),
        description: input.description?.trim() || null,
        iconKey: input.iconKey,
        sourceGlobs: input.sourceGlobs.map((glob) =>
          normalizeRelativePath(glob.trim())
        ),
        sourceFingerprint: fingerprint.fingerprint,
        sourceCommit: getSourceCommit(),
        sortOrder: input.sortOrder ?? 0,
        createdBy: actorId,
        updatedBy: actorId,
      })
      .returning();
    return withStaleness(created);
  } catch (error) {
    if ((error as { code?: string }).code === '23505')
      throw serviceError('A module with that slug already exists', 409);
    throw error;
  }
}

export async function updateModule(
  slug: string,
  input: UpdateDesignModuleInput,
  actorId: string
): Promise<DesignModule> {
  validateInput(input, false);
  const patch: Partial<typeof designModules.$inferInsert> = {
    updatedBy: actorId,
    updatedAt: new Date().toISOString(),
  };
  if (input.slug !== undefined) patch.slug = input.slug;
  if (input.label !== undefined) patch.label = input.label.trim();
  if (input.description !== undefined)
    patch.description = input.description?.trim() || null;
  if (input.iconKey !== undefined) patch.iconKey = input.iconKey;
  if (input.sourceGlobs !== undefined) {
    patch.sourceGlobs = input.sourceGlobs.map((glob) =>
      normalizeRelativePath(glob.trim())
    );
  }
  if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;

  try {
    const [updated] = await db
      .update(designModules)
      .set(patch)
      .where(eq(designModules.slug, slug))
      .returning();
    if (!updated) throw serviceError('Design module not found', 404);
    return withStaleness(updated);
  } catch (error) {
    if ((error as { code?: string }).code === '23505')
      throw serviceError('A module with that slug already exists', 409);
    throw error;
  }
}

export async function deleteModule(slug: string): Promise<boolean> {
  const deleted = await db
    .delete(designModules)
    .where(eq(designModules.slug, slug))
    .returning({ id: designModules.id });
  return deleted.length > 0;
}

async function getWorkspaceDir(threadId: string): Promise<string | null> {
  const row = await db.query.chatThreads.findFirst({
    where: eq(chatThreads.id, threadId),
    columns: { workspaceDir: true },
  });
  return row?.workspaceDir ?? null;
}

function startRegenerationWatcher(
  moduleId: string,
  threadId: string,
  fingerprint: string | null,
  sourceCommit: string | null,
  model: string
): void {
  const existing = activeWatchers.get(moduleId);
  if (existing) clearInterval(existing);
  let attempts = 0;
  let workspaceDir: string | null = null;

  const interval = setInterval(async () => {
    attempts += 1;
    if (attempts > WATCHER_MAX_ATTEMPTS) {
      clearInterval(interval);
      activeWatchers.delete(moduleId);
      return;
    }
    if (!workspaceDir) workspaceDir = await getWorkspaceDir(threadId);
    if (!workspaceDir) return;

    const outputPath = path.join(
      workspaceDir,
      '.ai-pilot',
      'output',
      OUTPUT_FILE
    );
    if (!fs.existsSync(outputPath)) {
      if (isThreadIdle(threadId)) {
        clearInterval(interval);
        activeWatchers.delete(moduleId);
      }
      return;
    }

    const content = fs.readFileSync(outputPath, 'utf8').trim();
    if (!content) return;
    clearInterval(interval);
    activeWatchers.delete(moduleId);
    await db
      .update(designModules)
      .set({
        content,
        sourceFingerprint: fingerprint,
        sourceCommit,
        lastGeneratedAt: new Date().toISOString(),
        generatedByModel: model,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(designModules.id, moduleId));
    try {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    } catch {
      // Workspace cleanup is best-effort.
    }
  }, WATCHER_INTERVAL_MS);

  activeWatchers.set(moduleId, interval);
}

export async function regenerateModule(
  slug: string,
  options: { force?: boolean; project: string; actorId: string }
): Promise<RegenerateDesignModuleResult> {
  const row = await db.query.designModules.findFirst({
    where: eq(designModules.slug, slug),
  });
  if (!row) throw serviceError('Design module not found', 404);

  const module = withStaleness(row);
  if (!options.force && !module.isStale)
    return { started: false, reason: 'not-stale' };

  const skillConfig = await resolveSkillConfig({ project: options.project });
  if (!skillConfig)
    throw serviceError(
      `No repository skill configuration exists for ${options.project}`,
      409
    );

  const fingerprint = computeFingerprint(row.sourceGlobs);
  const sourceCommit = getSourceCommit();
  const model =
    skillConfig.designDocModel ??
    skillConfig.defaultModel ??
    (await getDefaultModel());
  const freeformContext = [
    `Module slug: ${row.slug}`,
    `Module label: ${row.label}`,
    `Module description: ${row.description ?? ''}`,
    'Allowed source globs:',
    ...row.sourceGlobs.map((glob) => `- ${glob}`),
    '',
    `Write the completed architecture document to .ai-pilot/output/${OUTPUT_FILE}.`,
  ].join('\n');

  const thread = await createThread(
    options.actorId,
    {
      project: options.project,
      repo: skillConfig.skillRepo,
      branch: skillConfig.skillBranch ?? 'main',
      skillProvider: skillConfig.skillProvider,
      skillPath: DESIGN_MODULE_SKILL_PATH,
      freeformContext,
      model,
    },
    { skipAutoKickoff: true }
  );

  startRegenerationWatcher(
    row.id,
    thread.id,
    fingerprint.fingerprint,
    sourceCommit,
    model
  );
  sendMessage(
    thread.id,
    `Generate the ${row.label} architecture document from the allowed source globs. Write only ${OUTPUT_FILE} in .ai-pilot/output/.`,
    undefined,
    [],
    { hidden: true }
  ).catch((error: Error) => {
    console.error(
      `[designModule] Regeneration failed for ${row.slug}:`,
      error.message
    );
  });

  return { started: true, threadId: thread.id };
}
