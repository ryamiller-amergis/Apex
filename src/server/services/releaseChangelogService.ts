import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import type { ToolName } from '@cursor/sdk';
import { AzureDevOpsService } from './azureDevOps';
import { getProjectReleasePlatformsState } from './releasePlatformService';
import { resolveSkillConfig } from './projectSettingsService';
import { getDefaultModel } from './appSettingsService';
import { getSkillFile } from './skillCatalogFacade';
import {
  requestModelAvailabilityProbe,
  resolveCursorModelChoice,
} from './modelsService';
import { buildCursorModelSelection } from './agentEffortResolver';
import { computeCost, recordAiUsage } from './aiUsageService';
import { isCursorModelBlockedMessage } from '../../shared/utils/modelAvailability';
import type { EffortLevel } from '../../shared/types/effort';
import type { ProjectSkillConfig } from '../../shared/types/projectSettings';
import {
  matchPlatformsFromTags,
  resolveWorkItemPlatforms,
  type ProjectReleasePlatformsState,
  type ReleasePlatform,
} from '../../shared/types/releasePlatforms';
import {
  RELEASE_CHANGELOG_SKILL_PATH,
  type GenerateReleaseChangelogResponse,
  type ReleaseChangelogItemNode,
} from '../../shared/types/releaseChangelog';

const MAX_DESCRIPTION_EXCERPT_CHARS = 150;
const DEFAULT_BEDROCK_CHANGELOG_MODEL = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
/** In-memory failover chain. A live Bedrock or Cursor catalog lookup is not on the click path. */
const STATIC_BEDROCK_HAIKU_MODELS = [
  DEFAULT_BEDROCK_CHANGELOG_MODEL,
  'us.anthropic.claude-3-5-haiku-20241022-v1:0',
];
const STATIC_BEDROCK_SONNET_MODELS = [
  'us.anthropic.claude-sonnet-4-6',
  'us.anthropic.claude-sonnet-4-5-20251001-v1:0',
];
const DEFAULT_CURSOR_CHANGELOG_MODEL = 'composer-2.5';
const SKILL_FETCH_BUDGET_MS = 400;
const CURSOR_AUTO_FALLBACK_MODEL = 'default';
const ADO_CONTEXT_CACHE_TTL_MS = 45_000;
const REPO_SKILL_CACHE_TTL_MS = 5 * 60_000;
const RETIRED_BEDROCK_MODEL_TTL_MS = 30 * 60_000;
const WARM_AGENT_IDLE_TTL_MS = 5 * 60_000;

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const guarded = work.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const timeout = new Promise<{ ok: false; error: Error }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: new Error('timed out') }), ms);
    timer.unref?.();
  });
  return Promise.race([guarded, timeout]).then((result) => {
    if (timer) clearTimeout(timer);
    if (result.ok) return result.value;
    throw result.error;
  });
}

export class ReleaseChangelogError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'ReleaseChangelogError';
    this.statusCode = statusCode;
  }
}

export interface ResolvedReleaseChangelogConfig {
  skillPath: string;
  skillMarkdown: string;
  cursorModel: string;
  cursorEffort?: EffortLevel;
  preferCursorSidecar: boolean;
  configuredBedrockModelId: string | null;
}

export interface ReleaseChangelogAiGenerationOutput {
  markdown: string;
  modelUsed: string;
}

export interface ReleaseChangelogAiProvider {
  generateMarkdown(input: {
    prompt: string;
    project: string;
    epicId: number;
    itemCount: number;
    timeoutMs: number;
    userId?: string;
    resolvedConfig: ResolvedReleaseChangelogConfig;
  }): Promise<ReleaseChangelogAiGenerationOutput | string | null>;
}

let aiProviderOverride: ReleaseChangelogAiProvider | null = null;
const inflightReleaseChangelogs = new Map<string, Promise<GenerateReleaseChangelogResponse>>();
let skillMarkdownOverride: string | null = null;
let cachedBundledSkillMarkdown: string | null = null;

type AdoChangelogContext = NonNullable<
  Awaited<ReturnType<AzureDevOpsService['getReleaseEpicChangelogContext']>>
>;

const adoContextCache = new Map<
  string,
  { expiresAt: number; value: AdoChangelogContext }
>();

const repoSkillCache = new Map<
  string,
  { expiresAt: number; content: string }
>();

const unavailableBedrockModels = new Map<string, number>();

export function setReleaseChangelogAiProviderForTests(
  provider: ReleaseChangelogAiProvider | null,
): void {
  aiProviderOverride = provider;
}

export function setReleaseChangelogSkillMarkdownForTests(
  markdown: string | null,
): void {
  skillMarkdownOverride = markdown;
}

export function clearReleaseChangelogCachesForTests(): void {
  adoContextCache.clear();
  repoSkillCache.clear();
  unavailableBedrockModels.clear();
  inflightReleaseChangelogs.clear();
}

export function loadReleaseChangelogSkillMarkdown(): string {
  if (skillMarkdownOverride !== null) {
    return skillMarkdownOverride;
  }
  if (cachedBundledSkillMarkdown !== null) {
    return cachedBundledSkillMarkdown;
  }
  const fullPath = path.join(process.cwd(), RELEASE_CHANGELOG_SKILL_PATH);
  cachedBundledSkillMarkdown = fs.readFileSync(fullPath, 'utf8');
  return cachedBundledSkillMarkdown;
}

export function parseSkillFrontmatterModel(markdown: string): string | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown.trim());
  if (!match) return null;
  const modelLine = /^\s*model\s*:\s*['"]?([A-Za-z0-9._:-]+)['"]?\s*$/m.exec(match[1]);
  return modelLine?.[1]?.trim() || null;
}

async function loadConfiguredSkillMarkdown(
  project: string,
  skillConfig: ProjectSkillConfig | null,
): Promise<{ skillPath: string; skillMarkdown: string }> {
  if (skillMarkdownOverride !== null) {
    return {
      skillPath: skillConfig?.releaseChangelogSkillPath?.trim() || RELEASE_CHANGELOG_SKILL_PATH,
      skillMarkdown: skillMarkdownOverride,
    };
  }

  const configuredPath = skillConfig?.releaseChangelogSkillPath?.trim();
  if (!configuredPath) {
    return {
      skillPath: RELEASE_CHANGELOG_SKILL_PATH,
      skillMarkdown: loadReleaseChangelogSkillMarkdown(),
    };
  }

  // 1. Try reading from the project's configured repository (cached 5m)
  if (skillConfig?.skillRepo?.trim()) {
    const provider = skillConfig.skillProvider ?? 'ado';
    const branch = skillConfig.skillBranch || 'main';
    const cacheKey = `${provider}:${project}:${skillConfig.skillRepo}@${branch}:${configuredPath}`;
    const now = Date.now();
    const cached = repoSkillCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return { skillPath: configuredPath, skillMarkdown: cached.content };
    }

    try {
      const content = await withDeadline(
        getSkillFile(project, skillConfig.skillRepo, configuredPath, branch, provider),
        SKILL_FETCH_BUDGET_MS,
      );
      if (content && content.trim()) {
        const trimmed = content.trim();
        repoSkillCache.set(cacheKey, {
          expiresAt: now + REPO_SKILL_CACHE_TTL_MS,
          content: trimmed,
        });
        return { skillPath: configuredPath, skillMarkdown: trimmed };
      }
    } catch (err) {
      console.warn(
        `[releaseChangelogService] Could not load configured skill "${configuredPath}" from ${provider}:${skillConfig.skillRepo}@${branch}, checking local/bundled fallback:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // 2. Check if the configured relative path exists in Apex's local bundle
  const normalizedRel = configuredPath.replace(/^[/\\]+/, '');
  const candidateAbs = path.resolve(process.cwd(), normalizedRel);
  if (candidateAbs.startsWith(path.resolve(process.cwd())) && fs.existsSync(candidateAbs)) {
    try {
      const localContent = fs.readFileSync(candidateAbs, 'utf8').trim();
      if (localContent) {
        return { skillPath: configuredPath, skillMarkdown: localContent };
      }
    } catch {
      // fall through to bundled default
    }
  }

  // 3. Fall back to Apex's bundled release-changelog skill
  return {
    skillPath: RELEASE_CHANGELOG_SKILL_PATH,
    skillMarkdown: loadReleaseChangelogSkillMarkdown(),
  };
}

/**
 * Resolves the effective Release Changelog Sidecar configuration for a project.
 * Uses the saved model id directly. A retired Cursor model is retried as Auto during
 * the run, inside the speed budget. This does not call Cursor.models.list(), which
 * also starts a probe that creates an agent for every catalog model.
 */
export async function resolveProjectReleaseChangelogConfig(
  project: string,
  preloadedSkillConfig?: ProjectSkillConfig | null,
): Promise<ResolvedReleaseChangelogConfig> {
  let skillConfig = preloadedSkillConfig;
  if (skillConfig === undefined) {
    try {
      skillConfig = await resolveSkillConfig({ project });
    } catch {
      skillConfig = null;
    }
  }

  const { skillPath, skillMarkdown } = await loadConfiguredSkillMarkdown(
    project,
    skillConfig ?? null,
  );

  const explicitSidecarCursorModel = skillConfig?.releaseChangelogModel?.trim() || null;
  const explicitBedrockModel =
    skillConfig?.releaseChangelogBedrockModelId?.trim() ||
    process.env.BEDROCK_CHANGELOG_MODEL_ID?.trim() ||
    null;

  const frontmatterModel = parseSkillFrontmatterModel(skillMarkdown);
  let globalDefault = DEFAULT_CURSOR_CHANGELOG_MODEL;
  if (!explicitSidecarCursorModel && !frontmatterModel && !skillConfig?.defaultModel) {
    try {
      globalDefault = (await getDefaultModel()) || DEFAULT_CURSOR_CHANGELOG_MODEL;
    } catch {
      globalDefault = DEFAULT_CURSOR_CHANGELOG_MODEL;
    }
  }

  const requestedCursorModel =
    explicitSidecarCursorModel ||
    frontmatterModel ||
    skillConfig?.defaultModel?.trim() ||
    globalDefault;

  const requestedEffort: EffortLevel | undefined =
    skillConfig?.releaseChangelogEffort ?? skillConfig?.defaultEffort ?? undefined;

  return {
    skillPath,
    skillMarkdown,
    cursorModel: requestedCursorModel,
    cursorEffort: requestedEffort,
    // Honour the admin's Sidecar Cursor model choice first when explicitly set (unless they also pinned a Bedrock changelog model)
    preferCursorSidecar: Boolean(
      explicitSidecarCursorModel && !skillConfig?.releaseChangelogBedrockModelId?.trim(),
    ),
    configuredBedrockModelId: explicitBedrockModel,
  };
}

/**
 * Computes the strict AI latency budget in milliseconds based on root item count
 * so total response time stays aligned with executive UX expectations
 * (~1s for 1 item, ~2s for 5 items, ~3.5–4s for 10+ items).
 */
export function computeChangelogSlaBudgetMs(itemCount: number): number {
  const clamped = Math.max(1, Math.min(25, itemCount));
  return Math.min(3_800, 1_150 + clamped * 200);
}

export function stripHtmlToExcerpt(
  rawHtml: string | null | undefined,
  maxChars = MAX_DESCRIPTION_EXCERPT_CHARS,
): string {
  if (!rawHtml) return '';
  const plain = rawHtml
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();

  if (plain.length <= maxChars) return plain;
  return `${plain.slice(0, maxChars - 1).trimEnd()}…`;
}

export function buildChangelogFilename(version: string): string {
  const slug = version
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'release'}-changelog.md`;
}

export function stripOuterMarkdownFence(raw: string): string {
  const trimmed = raw.trim();
  const match = /^```(?:markdown|md)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/i.exec(trimmed);
  return (match ? match[1] : trimmed).trim();
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Evaluates unmistakable platform keywords in a work item's title/description
 * against the project's configured platforms when no explicit or tag platform is present.
 */
export function inferSmartPlatformsFromText(
  text: string,
  platforms: readonly ReleasePlatform[],
): ReleasePlatform[] {
  if (!text.trim() || platforms.length === 0) return [];

  const slugSet = new Set(platforms.map((p) => p.slug));
  const matched: ReleasePlatform[] = [];

  for (const platform of platforms) {
    const patterns: RegExp[] = [];
    if (platform.name.trim().length >= 2) {
      patterns.push(new RegExp(`\\b${escapeRegExp(platform.name.trim())}\\b`, 'i'));
    }
    if (platform.slug.trim().length >= 2 && platform.slug !== platform.name.toLowerCase()) {
      patterns.push(new RegExp(`\\b${escapeRegExp(platform.slug.trim())}\\b`, 'i'));
    }

    if (platform.slug === 'mobile') {
      const mobileExtras = ['mobile', 'push notification', 'offline sync', 'tablet'];
      if (!slugSet.has('ios')) mobileExtras.push('ios', 'iphone', 'ipad');
      if (!slugSet.has('android')) mobileExtras.push('android');
      patterns.push(new RegExp(`\\b(${mobileExtras.map(escapeRegExp).join('|')})\\b`, 'i'));
    } else if (platform.slug === 'ios') {
      patterns.push(/\b(ios|iphone|ipad|ipados|testflight|app store)\b/i);
    } else if (platform.slug === 'android') {
      patterns.push(/\b(android|apk|play store)\b/i);
    } else if (platform.slug === 'desktop') {
      patterns.push(/\b(desktop|windows|macos|electron|installer|system tray)\b/i);
    } else if (platform.slug === 'web') {
      patterns.push(/\b(web app|browser|web portal)\b/i);
    }

    if (patterns.some((re) => re.test(text))) {
      matched.push(platform);
    }
  }

  return matched.sort((a, b) => a.sortOrder - b.sortOrder);
}

interface RawAdoChangelogNode {
  id: number;
  title: string;
  workItemType: string;
  state: string;
  tags: string;
  description: string;
  ancestorIds: number[];
  ancestorTags: string;
  children: RawAdoChangelogNode[];
}

export function annotateChangelogTreeWithPlatforms(options: {
  rawItems: readonly RawAdoChangelogNode[];
  epicId: number;
  epicTags: string;
  platformState: ProjectReleasePlatformsState;
}): {
  items: ReleaseChangelogItemNode[];
  platformsIncluded: string[];
  leafItemCount: number;
} {
  const { rawItems, epicId, epicTags, platformState } = options;
  const { platforms, epicPlatformIds, workItemPlatformIds } = platformState;

  const epicLevelIds = new Set<string>([
    ...(epicPlatformIds[epicId] ?? []),
    ...matchPlatformsFromTags(epicTags, platforms),
  ]);
  const epicDefaultPlatforms = platforms
    .filter((p) => epicLevelIds.has(p.id))
    .sort((a, b) => a.sortOrder - b.sortOrder);

  const discoveredPlatformNames = new Set<string>(epicDefaultPlatforms.map((p) => p.name));
  let leafItemCount = 0;

  const annotateNode = (node: RawAdoChangelogNode): ReleaseChangelogItemNode => {
    const descriptionExcerpt = stripHtmlToExcerpt(node.description);
    const annotatedChildren = node.children.map(annotateNode);

    const directOrInherited = resolveWorkItemPlatforms(
      {
        id: node.id,
        tags: node.tags,
        ancestorIds: node.ancestorIds,
        ancestorTags: node.ancestorTags,
      },
      platforms,
      workItemPlatformIds,
    );

    let platformsNames = directOrInherited.map((p) => p.name);
    let inferredNames: string[] | undefined;

    if (platformsNames.length === 0 && annotatedChildren.length > 0) {
      const childUnion = new Set<string>();
      const childInferredUnion = new Set<string>();
      for (const child of annotatedChildren) {
        for (const p of child.platforms) childUnion.add(p);
        for (const p of child.inferredPlatforms ?? []) childInferredUnion.add(p);
      }
      if (childUnion.size > 0) {
        platformsNames = platforms
          .filter((p) => childUnion.has(p.name))
          .map((p) => p.name);
      } else if (childInferredUnion.size > 0) {
        inferredNames = platforms
          .filter((p) => childInferredUnion.has(p.name))
          .map((p) => p.name);
      }
    }

    if (platformsNames.length === 0 && (!inferredNames || inferredNames.length === 0)) {
      const smartMatched = inferSmartPlatformsFromText(
        `${node.title} ${descriptionExcerpt}`,
        platforms,
      );
      if (smartMatched.length > 0) {
        inferredNames = smartMatched.map((p) => p.name);
      } else if (epicDefaultPlatforms.length > 0) {
        platformsNames = epicDefaultPlatforms.map((p) => p.name);
      }
    }

    for (const name of platformsNames) discoveredPlatformNames.add(name);
    for (const name of inferredNames ?? []) discoveredPlatformNames.add(name);

    const isContainerWithChildren =
      (node.workItemType === 'Epic' || node.workItemType === 'Feature') &&
      annotatedChildren.length > 0;
    if (!isContainerWithChildren) {
      leafItemCount += 1;
    }

    return {
      id: node.id,
      title: node.title,
      workItemType: node.workItemType,
      state: node.state,
      tags: node.tags,
      descriptionExcerpt,
      platforms: platformsNames,
      ...(inferredNames && inferredNames.length > 0 ? { inferredPlatforms: inferredNames } : {}),
      children: annotatedChildren,
    };
  };

  const items = rawItems.map(annotateNode);
  const platformsIncluded = platforms
    .filter((p) => discoveredPlatformNames.has(p.name))
    .map((p) => p.name);

  return { items, platformsIncluded, leafItemCount };
}

function serializeCompactNode(node: ReleaseChangelogItemNode): Record<string, unknown> {
  const effectivePlats =
    node.platforms.length > 0 ? node.platforms : (node.inferredPlatforms ?? []);
  const out: Record<string, unknown> = {
    type: node.workItemType,
    title: node.title,
  };
  if (effectivePlats.length > 0) {
    out.platforms = effectivePlats;
  }
  if (node.descriptionExcerpt) {
    out.summary = node.descriptionExcerpt;
  }
  if (node.children.length > 0) {
    out.children = node.children.slice(0, 15).map((child) => {
      const childPlats =
        child.platforms.length > 0 ? child.platforms : (child.inferredPlatforms ?? []);
      return childPlats.length > 0
        ? { type: child.workItemType, title: child.title, platforms: childPlats }
        : { type: child.workItemType, title: child.title };
    });
    if (node.children.length > 15) {
      out.additionalChildrenCount = node.children.length - 15;
    }
  }
  return out;
}

export function buildReleaseChangelogSkillPrompt(input: {
  skillMarkdown: string;
  project: string;
  epic: {
    id: number;
    version: string;
    status: string;
    startDate?: string;
    targetDate?: string;
    descriptionExcerpt: string;
  };
  configuredPlatforms: readonly ReleasePlatform[];
  platformsIncluded: readonly string[];
  items: readonly ReleaseChangelogItemNode[];
}): string {
  const { skillMarkdown, project, epic, configuredPlatforms, platformsIncluded, items } = input;
  const compactItems = items.map(serializeCompactNode);

  return [
    skillMarkdown,
    '',
    '## Input',
    `Project: ${project} | Version: ${epic.version} | Target Date: ${epic.targetDate ?? 'TBD'}`,
    `Configured Platforms: ${configuredPlatforms.length > 0 ? configuredPlatforms.map((p) => p.name).join(', ') : 'none'}`,
    `Detected Platforms: ${platformsIncluded.length > 0 ? platformsIncluded.join(', ') : 'none'}`,
    ...(epic.descriptionExcerpt ? [`Release Summary: ${epic.descriptionExcerpt}`] : []),
    'Items:',
    JSON.stringify(compactItems),
    '',
    'Output ONLY the finished executive Markdown (no outer code fences, no preamble).',
  ].join('\n');
}

function effectiveItemPlatforms(node: ReleaseChangelogItemNode): string[] {
  if (node.platforms.length > 0) return node.platforms;
  if (node.inferredPlatforms && node.inferredPlatforms.length > 0) {
    return node.inferredPlatforms;
  }
  return [];
}

function formatRolledUpBullet(node: ReleaseChangelogItemNode): string {
  const cleanTitle = node.title.trim();
  if (
    (node.workItemType === 'Epic' || node.workItemType === 'Feature') &&
    node.children.length > 0
  ) {
    if (node.descriptionExcerpt) {
      return `- **${cleanTitle}** — ${node.descriptionExcerpt}`;
    }
    const topChildTitles = node.children
      .slice(0, 3)
      .map((c) => c.title.trim().replace(/\.$/, ''));
    const remainder = node.children.length - topChildTitles.length;
    const summaryClause =
      remainder > 0
        ? `Includes ${topChildTitles.join(', ')}, and ${remainder} additional deliverable${remainder === 1 ? '' : 's'}.`
        : `Delivers ${topChildTitles.join('; ')}.`;
    return `- **${cleanTitle}** — ${summaryClause}`;
  }

  if (node.descriptionExcerpt) {
    return `- **${cleanTitle}** — ${node.descriptionExcerpt}`;
  }
  return `- **${cleanTitle}**`;
}

/**
 * Deterministic executive Markdown rollup used when upstream AI is unconfigured or exceeds
 * the strict UX latency budget, preserving hierarchical Feature/Epic rollup and platform grouping.
 */
export function buildFallbackReleaseChangelogMarkdown(input: {
  epic: {
    version: string;
    targetDate?: string;
    descriptionExcerpt: string;
  };
  configuredPlatforms: readonly ReleasePlatform[];
  platformsIncluded: readonly string[];
  items: readonly ReleaseChangelogItemNode[];
}): string {
  const { epic, configuredPlatforms, platformsIncluded, items } = input;
  const headerMetaParts: string[] = [
    `**Target Date:** ${epic.targetDate ?? 'TBD'}`,
  ];
  if (configuredPlatforms.length > 0 && platformsIncluded.length > 0) {
    const label = platformsIncluded.length === 1 ? 'Target Platform' : 'Platforms';
    headerMetaParts.push(`**${label}:** ${platformsIncluded.join(', ')}`);
  }

  const lines: string[] = [
    `# ${epic.version} — Release Notes`,
    '',
    headerMetaParts.join(' | '),
    '',
  ];

  if (items.length === 0) {
    lines.push(
      epic.descriptionExcerpt ||
        'No work items are currently associated with this release.',
    );
    return lines.join('\n').trim();
  }

  if (epic.descriptionExcerpt) {
    lines.push(epic.descriptionExcerpt, '');
  } else {
    const platformSuffix =
      platformsIncluded.length > 0 ? ` across ${platformsIncluded.join(' and ')}` : '';
    lines.push(
      `High-level summary of capabilities, enhancements, and fixes scheduled for **${epic.version}**${platformSuffix}.`,
      '',
    );
  }

  const renderCategoryBullets = (
    bucketItems: readonly ReleaseChangelogItemNode[],
    useSubheadings: boolean,
  ): string[] => {
    const highlights = bucketItems.filter(
      (i) => i.workItemType !== 'Bug' && i.workItemType !== 'Technical Backlog Item',
    );
    const fixesAndTech = bucketItems.filter(
      (i) => i.workItemType === 'Bug' || i.workItemType === 'Technical Backlog Item',
    );

    const out: string[] = [];
    const hPrefix = useSubheadings ? '###' : '##';

    if (highlights.length > 0) {
      if (!useSubheadings || fixesAndTech.length > 0) {
        out.push(`${hPrefix} Highlights`, '');
      }
      for (const item of highlights) {
        out.push(formatRolledUpBullet(item));
      }
      out.push('');
    }

    if (fixesAndTech.length > 0) {
      out.push(`${hPrefix} Fixes & Reliability`, '');
      for (const item of fixesAndTech) {
        out.push(formatRolledUpBullet(item));
      }
      out.push('');
    }

    return out;
  };

  if (configuredPlatforms.length === 0 || platformsIncluded.length <= 1) {
    lines.push(...renderCategoryBullets(items, false));
    return lines.join('\n').trim();
  }

  const sharedItems: ReleaseChangelogItemNode[] = [];
  const generalItems: ReleaseChangelogItemNode[] = [];
  const byPlatform = new Map<string, ReleaseChangelogItemNode[]>();
  for (const p of configuredPlatforms) {
    byPlatform.set(p.name, []);
  }

  for (const item of items) {
    const itemPlats = effectiveItemPlatforms(item);
    if (itemPlats.length === 0) {
      generalItems.push(item);
    } else if (itemPlats.length > 1) {
      if (
        (item.workItemType === 'Epic' || item.workItemType === 'Feature') &&
        item.children.length > 0
      ) {
        const childrenHaveSinglePlatforms = item.children.every(
          (c) => effectiveItemPlatforms(c).length === 1,
        );
        if (childrenHaveSinglePlatforms) {
          for (const platformName of itemPlats) {
            const matchingChildren = item.children.filter(
              (c) => effectiveItemPlatforms(c)[0] === platformName,
            );
            if (matchingChildren.length > 0) {
              byPlatform.get(platformName)?.push({
                ...item,
                children: matchingChildren,
                descriptionExcerpt: '',
              });
            }
          }
          continue;
        }
      }
      sharedItems.push(item);
    } else {
      const targetList = byPlatform.get(itemPlats[0]);
      if (targetList) {
        targetList.push(item);
      } else {
        generalItems.push(item);
      }
    }
  }

  if (sharedItems.length > 0) {
    lines.push('## Cross-Platform / Shared', '');
    lines.push(...renderCategoryBullets(sharedItems, true));
  }

  for (const platform of configuredPlatforms) {
    const platItems = byPlatform.get(platform.name) ?? [];
    if (platItems.length === 0) continue;
    lines.push(`## ${platform.name}`, '');
    lines.push(...renderCategoryBullets(platItems, true));
  }

  if (generalItems.length > 0) {
    lines.push('## General', '');
    lines.push(...renderCategoryBullets(generalItems, true));
  }

  return lines.join('\n').trim();
}

// ── Dynamic Catalog Model Failover (Bedrock + Cursor Sidecar) ─────────────────

/**
 * True only when Bedrock can authenticate without walking the default credential
 * chain. A local ~/.aws/config file makes that chain look configured, then
 * InvokeModel stalls on IMDS before the request abort can fire.
 */
function hasConfiguredAwsCredentials(): boolean {
  return Boolean(
    process.env.AWS_ACCESS_KEY_ID ||
      process.env.AWS_WEB_IDENTITY_TOKEN_FILE ||
      process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI ||
      process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI,
  );
}

let bedrockFastClient: BedrockRuntimeClient | null = null;

function getFastBedrockClient(): BedrockRuntimeClient {
  if (!bedrockFastClient) {
    bedrockFastClient = new BedrockRuntimeClient({
      region: process.env.AWS_REGION ?? 'us-east-1',
      maxAttempts: 1,
    });
  }
  return bedrockFastClient;
}

function isBedrockModelUnavailableError(err: unknown): boolean {
  const e = err as {
    name?: string;
    message?: string;
    statusCode?: number;
    $metadata?: { httpStatusCode?: number };
  } | null;
  if (!e) return false;
  const name = e.name ?? '';
  if (
    name === 'ResourceNotFoundException' ||
    name === 'ValidationException' ||
    name === 'AccessDeniedException' ||
    name === 'ModelNotReadyException'
  ) {
    return true;
  }
  const status = e.statusCode ?? e.$metadata?.httpStatusCode;
  if (status === 400 || status === 403 || status === 404) return true;
  return /model .* (not found|deprecated|legacy|retired|end of life|access)/i.test(
    e.message ?? '',
  );
}

/**
 * Builds an ordered, deduplicated list of Bedrock candidate models from the
 * configured id and a static Haiku/Sonnet chain. A retired id is skipped for
 * 30 minutes after InvokeModel reports it unavailable. This does not call
 * ListInferenceProfiles.
 */
export function resolveBedrockCandidateModels(configuredModelId: string | null): string[] {
  const now = Date.now();
  const rawCandidates = [
    configuredModelId,
    ...STATIC_BEDROCK_HAIKU_MODELS,
    process.env.BEDROCK_MODEL_ID?.trim() || null,
    ...STATIC_BEDROCK_SONNET_MODELS,
  ].filter((id): id is string => Boolean(id && id.trim()));

  const unique: string[] = [];
  for (const id of rawCandidates) {
    if (unique.includes(id)) continue;
    const retiredUntil = unavailableBedrockModels.get(id);
    if (retiredUntil && retiredUntil > now) continue;
    unique.push(id);
  }

  return unique.length > 0 ? unique : [DEFAULT_BEDROCK_CHANGELOG_MODEL];
}

async function invokeFastBedrockChangelog(input: {
  prompt: string;
  project: string;
  epicId: number;
  itemCount: number;
  timeoutMs: number;
  configuredModelId: string | null;
  userId?: string;
}): Promise<ReleaseChangelogAiGenerationOutput | null> {
  if (!hasConfiguredAwsCredentials()) return null;

  const candidates = resolveBedrockCandidateModels(input.configuredModelId);
  const maxTokens = Math.min(1_100, 220 + input.itemCount * 65);
  const deadline = Date.now() + input.timeoutMs;

  for (const modelId of candidates) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 250) break;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remainingMs);
    timer.unref?.();

    const startedAt = Date.now();
    try {
      const command = new InvokeModelCommand({
        modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          anthropic_version: 'bedrock-2023-05-31',
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: input.prompt }],
        }),
      });

      const response = await getFastBedrockClient().send(command, {
        abortSignal: controller.signal,
      });

      const body = JSON.parse(new TextDecoder().decode(response.body)) as {
        content?: Array<{ type: string; text: string }>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };

      const text = stripOuterMarkdownFence(body.content?.[0]?.text ?? '');
      if (!text) continue;

      const inputTokens = body.usage?.input_tokens ?? 0;
      const outputTokens = body.usage?.output_tokens ?? 0;
      const durationMs = Date.now() - startedAt;
      void computeCost({
        provider: 'bedrock',
        modelId,
        inputTokens,
        outputTokens,
      })
        .then((costUsd) =>
          recordAiUsage({
            provider: 'bedrock',
            modelId,
            feature: 'other',
            project: input.project,
            entityType: 'release-changelog',
            entityId: String(input.epicId),
            userId: input.userId,
            inputTokens,
            outputTokens,
            tokenSource: 'exact',
            costUsd,
            costSource: 'computed',
            durationMs,
            status: 'success',
          }),
        )
        .catch(() => {});

      return { markdown: text, modelUsed: modelId };
    } catch (err) {
      if (isBedrockModelUnavailableError(err)) {
        unavailableBedrockModels.set(modelId, Date.now() + RETIRED_BEDROCK_MODEL_TTL_MS);
        console.warn(
          `[releaseChangelogService] Bedrock model "${modelId}" unavailable; trying next active catalog model.`,
        );
        continue;
      }
      // Timeout or network error — break out so cross-provider fallback can run
      break;
    } finally {
      clearTimeout(timer);
    }
  }

  return null;
}

interface WarmCursorChangelogAgent {
  key: string;
  modelId: string;
  agent: Awaited<ReturnType<typeof import('@cursor/sdk')['Agent']['create']>>;
  emptyDir: string;
}

let warmCursorAgentPromise: Promise<WarmCursorChangelogAgent | null> | null = null;
let warmCursorAgentKey: string | null = null;
let warmIdleTimer: NodeJS.Timeout | null = null;

function warmKeyFor(modelId: string, effort?: EffortLevel): string {
  return `${modelId}::${effort ?? ''}`;
}

async function disposeWarmAgent(entry: WarmCursorChangelogAgent | null): Promise<void> {
  if (!entry) return;
  const dispose = entry.agent?.[Symbol.asyncDispose];
  if (typeof dispose === 'function') {
    await dispose.call(entry.agent).catch(() => {});
  }
  await fs.promises.rm(entry.emptyDir, { recursive: true, force: true }).catch(() => {});
}

function scheduleWarmAgentIdleExpiry(): void {
  if (warmIdleTimer) clearTimeout(warmIdleTimer);
  warmIdleTimer = setTimeout(() => {
    const pending = warmCursorAgentPromise;
    warmCursorAgentPromise = null;
    warmCursorAgentKey = null;
    warmIdleTimer = null;
    if (pending) {
      void pending.then((entry) => disposeWarmAgent(entry));
    }
  }, WARM_AGENT_IDLE_TTL_MS);
  warmIdleTimer.unref?.();
}

async function createIsolatedHeadlessCursorAgent(
  modelId: string,
  effort?: EffortLevel,
): Promise<WarmCursorChangelogAgent | null> {
  const apiKey = process.env.CURSOR_API_KEY?.trim();
  if (
    !apiKey ||
    process.env.NODE_ENV === 'test' ||
    process.env.E2E_MODE === 'true'
  ) {
    return null;
  }

  let emptyDir: string | undefined;
  try {
    emptyDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'apex-rel-changelog-'));
    const { Agent } = await import('@cursor/sdk');
    const modelChoice = await resolveCursorModelChoice(modelId, effort);
    const agent = await Agent.create({
      apiKey,
      model: buildCursorModelSelection(modelChoice.model, modelChoice.effort, {
        modelParams: modelChoice.modelParams,
      }),
      local: {
        cwd: emptyDir,
        settingSources: [],
      },
      mcpServers: {},
      tools: [] as ToolName[],
    });
    return {
      key: warmKeyFor(modelId, effort),
      modelId,
      agent,
      emptyDir,
    };
  } catch (err) {
    if (emptyDir) {
      await fs.promises.rm(emptyDir, { recursive: true, force: true }).catch(() => {});
    }
    const msg = err instanceof Error ? err.message : String(err ?? '');
    if (isCursorModelBlockedMessage(msg)) {
      requestModelAvailabilityProbe();
    }
    return null;
  }
}

/**
 * Pre-warms a lightweight, zero-tool headless Cursor agent for the project's resolved
 * Release Changelog Sidecar model when a user visits the Releases tab.
 */
export function warmReleaseChangelogAgent(project?: string): void {
  if (
    process.env.NODE_ENV === 'test' ||
    process.env.E2E_MODE === 'true' ||
    !process.env.CURSOR_API_KEY?.trim()
  ) {
    return;
  }

  void (async () => {
    const resolved = project
      ? await resolveProjectReleaseChangelogConfig(project).catch(() => null)
      : null;

    if (hasConfiguredAwsCredentials() && !resolved?.preferCursorSidecar) {
      return;
    }

    const modelId = resolved?.cursorModel ?? DEFAULT_CURSOR_CHANGELOG_MODEL;
    const effort = resolved?.cursorEffort;
    const targetKey = warmKeyFor(modelId, effort);

    if (warmCursorAgentPromise && warmCursorAgentKey === targetKey) {
      return;
    }

    const stale = warmCursorAgentPromise;
    warmCursorAgentKey = targetKey;
    warmCursorAgentPromise = createIsolatedHeadlessCursorAgent(modelId, effort);
    scheduleWarmAgentIdleExpiry();

    if (stale) {
      void stale.then((entry) => disposeWarmAgent(entry));
    }
  })();
}

async function acquireCursorChangelogAgent(
  modelId: string,
  effort?: EffortLevel,
): Promise<WarmCursorChangelogAgent | null> {
  const targetKey = warmKeyFor(modelId, effort);
  const existing = warmCursorAgentPromise;
  const existingKey = warmCursorAgentKey;

  warmCursorAgentPromise = null;
  warmCursorAgentKey = null;
  if (warmIdleTimer) {
    clearTimeout(warmIdleTimer);
    warmIdleTimer = null;
  }

  // Replenish a warm agent for the next request
  warmCursorAgentKey = targetKey;
  warmCursorAgentPromise = createIsolatedHeadlessCursorAgent(modelId, effort);
  scheduleWarmAgentIdleExpiry();

  if (existing) {
    const resolved = await existing;
    if (resolved && existingKey === targetKey) {
      return resolved;
    }
    void disposeWarmAgent(resolved);
  }
  return createIsolatedHeadlessCursorAgent(modelId, effort);
}

async function runSingleCursorAttempt(input: {
  prompt: string;
  modelId: string;
  effort?: EffortLevel;
  deadline: number;
}): Promise<{ output: ReleaseChangelogAiGenerationOutput | null; retryWithAuto: boolean }> {
  let acquired: WarmCursorChangelogAgent | null = null;
  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const remainingMs = input.deadline - Date.now();
  if (remainingMs <= 250) {
    return { output: null, retryWithAuto: false };
  }

  const timeoutPromise = new Promise<{ output: null; retryWithAuto: false }>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve({ output: null, retryWithAuto: false });
    }, remainingMs);
    timer.unref?.();
  });

  const attemptPromise = (async (): Promise<{
    output: ReleaseChangelogAiGenerationOutput | null;
    retryWithAuto: boolean;
  }> => {
    try {
      acquired = await acquireCursorChangelogAgent(input.modelId, input.effort);
      if (!acquired || timedOut) {
        return {
          output: null,
          retryWithAuto: !timedOut && input.modelId !== CURSOR_AUTO_FALLBACK_MODEL,
        };
      }

      const run = await acquired.agent.send(input.prompt);
      let text = '';
      if (run.supports('stream')) {
        for await (const event of run.stream()) {
          if (timedOut) break;
          if (event.type === 'assistant') {
            for (const block of event.message.content) {
              if (block.type === 'text') {
                text += block.text;
              }
            }
          }
        }
      } else {
        await run.wait();
      }

      if (timedOut) return { output: null, retryWithAuto: false };
      const cleaned = stripOuterMarkdownFence(text);
      if (!cleaned) {
        return {
          output: null,
          retryWithAuto: input.modelId !== CURSOR_AUTO_FALLBACK_MODEL,
        };
      }
      return {
        output: { markdown: cleaned, modelUsed: input.modelId },
        retryWithAuto: false,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err ?? '');
      if (isCursorModelBlockedMessage(msg) || /model|not found|unsupported|invalid/i.test(msg)) {
        requestModelAvailabilityProbe();
        return {
          output: null,
          retryWithAuto: !timedOut && input.modelId !== CURSOR_AUTO_FALLBACK_MODEL,
        };
      }
      return { output: null, retryWithAuto: false };
    } finally {
      void disposeWarmAgent(acquired);
    }
  })();

  try {
    return await Promise.race([attemptPromise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function invokeFastCursorChangelog(input: {
  prompt: string;
  modelId: string;
  effort?: EffortLevel;
  timeoutMs: number;
}): Promise<ReleaseChangelogAiGenerationOutput | null> {
  if (!process.env.CURSOR_API_KEY?.trim()) return null;

  const deadline = Date.now() + input.timeoutMs;
  const primary = await runSingleCursorAttempt({
    prompt: input.prompt,
    modelId: input.modelId,
    effort: input.effort,
    deadline,
  });
  if (primary.output) return primary.output;

  // If the primary Cursor model was newly blocked or retired, fall back to Cursor's evergreen 'default' (Auto)
  if (primary.retryWithAuto && input.modelId !== CURSOR_AUTO_FALLBACK_MODEL) {
    const autoAttempt = await runSingleCursorAttempt({
      prompt: input.prompt,
      modelId: CURSOR_AUTO_FALLBACK_MODEL,
      effort: undefined,
      deadline,
    });
    if (autoAttempt.output) return autoAttempt.output;
  }

  return null;
}

function createDefaultAiProvider(): ReleaseChangelogAiProvider {
  return {
    async generateMarkdown({
      prompt,
      project,
      epicId,
      itemCount,
      timeoutMs,
      userId,
      resolvedConfig,
    }) {
      if (process.env.NODE_ENV === 'test' || process.env.E2E_MODE === 'true') {
        return null;
      }

      const started = Date.now();
      const remainingTimeout = () => Math.max(0, timeoutMs - (Date.now() - started));

      // When an admin explicitly chose a Sidecar Cursor model in Project Settings, run it first
      if (resolvedConfig.preferCursorSidecar) {
        const cursorOut = await invokeFastCursorChangelog({
          prompt,
          modelId: resolvedConfig.cursorModel,
          effort: resolvedConfig.cursorEffort,
          timeoutMs: remainingTimeout(),
        });
        if (cursorOut) return cursorOut;

        const leftForBedrock = remainingTimeout();
        if (leftForBedrock > 300) {
          return invokeFastBedrockChangelog({
            prompt,
            project,
            epicId,
            itemCount,
            timeoutMs: leftForBedrock,
            configuredModelId: resolvedConfig.configuredBedrockModelId,
            userId,
          });
        }
        return null;
      }

      // Otherwise try direct HTTPS Bedrock first (when AWS credentials exist), then Cursor Sidecar
      const bedrockOut = await invokeFastBedrockChangelog({
        prompt,
        project,
        epicId,
        itemCount,
        timeoutMs: remainingTimeout(),
        configuredModelId: resolvedConfig.configuredBedrockModelId,
        userId,
      });
      if (bedrockOut) return bedrockOut;

      const leftForCursor = remainingTimeout();
      if (leftForCursor <= 250) return null;

      return invokeFastCursorChangelog({
        prompt,
        modelId: resolvedConfig.cursorModel,
        effort: resolvedConfig.cursorEffort,
        timeoutMs: leftForCursor,
      });
    },
  };
}

async function getAdoContextWithCache(options: {
  ado: AzureDevOpsService;
  cacheKey: string;
  epicId: number;
  forceRefresh?: boolean;
}): Promise<AdoChangelogContext | null> {
  const { ado, cacheKey, epicId, forceRefresh } = options;
  const now = Date.now();

  if (!forceRefresh) {
    const cached = adoContextCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }
  }

  const fetched = await ado.getReleaseEpicChangelogContext(epicId);
  if (fetched) {
    adoContextCache.set(cacheKey, {
      expiresAt: now + ADO_CONTEXT_CACHE_TTL_MS,
      value: fetched,
    });
  }
  return fetched;
}

/**
 * React Strict Mode fires two changelog requests for one click. A second ADO
 * walk started while the first is still running does not come back, and the
 * modal stays on the spinner. Join the in-flight promise instead.
 */
export function generateReleaseChangelog(options: {
  epicId: number;
  project: string;
  areaPath?: string;
  userId?: string;
  forceRefresh?: boolean;
  adoService?: AzureDevOpsService;
}): Promise<GenerateReleaseChangelogResponse> {
  if (options.adoService) {
    return runGenerateReleaseChangelog(options);
  }

  const joinKey = `${(options.project ?? '').trim()}:${options.areaPath ?? ''}:${options.epicId}:${options.forceRefresh ? '1' : '0'}`;
  const existing = inflightReleaseChangelogs.get(joinKey);
  if (existing) return existing;

  const work = runGenerateReleaseChangelog(options).finally(() => {
    if (inflightReleaseChangelogs.get(joinKey) === work) {
      inflightReleaseChangelogs.delete(joinKey);
    }
  });
  inflightReleaseChangelogs.set(joinKey, work);
  return work;
}

async function runGenerateReleaseChangelog(options: {
  epicId: number;
  project: string;
  areaPath?: string;
  userId?: string;
  forceRefresh?: boolean;
  adoService?: AzureDevOpsService;
}): Promise<GenerateReleaseChangelogResponse> {
  const startedAt = Date.now();
  const { epicId, project, areaPath, userId, forceRefresh } = options;
  const trimmedProject = (project ?? '').trim();
  if (!trimmedProject) {
    throw new ReleaseChangelogError('project is required', 400);
  }
  if (!Number.isInteger(epicId) || epicId <= 0) {
    throw new ReleaseChangelogError('Invalid epic ID', 400);
  }

  const ado =
    options.adoService ??
    new AzureDevOpsService(trimmedProject, areaPath, { socketTimeout: 8_000 });
  const cacheKey = `${trimmedProject}:${areaPath ?? ''}:${epicId}`;

  // Fetch ADO context, project platforms, and Project Settings Sidecar config concurrently
  const [adoContext, platformState, resolvedConfig] = await Promise.all([
    options.adoService
      ? ado.getReleaseEpicChangelogContext(epicId)
      : getAdoContextWithCache({ ado, cacheKey, epicId, forceRefresh }),
    getProjectReleasePlatformsState(trimmedProject),
    resolveProjectReleaseChangelogConfig(trimmedProject),
  ]);

  if (!adoContext) {
    throw new ReleaseChangelogError(`Release epic #${epicId} was not found`, 404);
  }

  const epicDescriptionExcerpt = stripHtmlToExcerpt(adoContext.epic.description, 240);
  const { items, platformsIncluded, leafItemCount } = annotateChangelogTreeWithPlatforms({
    rawItems: adoContext.items,
    epicId,
    epicTags: adoContext.epic.tags,
    platformState,
  });

  const filename = buildChangelogFilename(adoContext.epic.version);

  if (items.length === 0) {
    const emptyMarkdown = buildFallbackReleaseChangelogMarkdown({
      epic: {
        version: adoContext.epic.version,
        targetDate: adoContext.epic.targetDate,
        descriptionExcerpt: epicDescriptionExcerpt,
      },
      configuredPlatforms: platformState.platforms,
      platformsIncluded,
      items,
    });
    return {
      epicId,
      version: adoContext.epic.version,
      filename,
      markdown: emptyMarkdown,
      itemCount: 0,
      leafItemCount: 0,
      platformsIncluded,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      modelUsed: null,
      skillPathUsed: resolvedConfig.skillPath,
      source: 'fallback',
    };
  }

  const prompt = buildReleaseChangelogSkillPrompt({
    skillMarkdown: resolvedConfig.skillMarkdown,
    project: trimmedProject,
    epic: {
      id: adoContext.epic.id,
      version: adoContext.epic.version,
      status: adoContext.epic.status,
      startDate: adoContext.epic.startDate,
      targetDate: adoContext.epic.targetDate,
      descriptionExcerpt: epicDescriptionExcerpt,
    },
    configuredPlatforms: platformState.platforms,
    platformsIncluded,
    items,
  });

  const prepMs = Date.now() - startedAt;
  const slaBudgetMs = Math.max(250, computeChangelogSlaBudgetMs(items.length) - prepMs);
  const provider = aiProviderOverride ?? createDefaultAiProvider();

  let timeoutHandle: NodeJS.Timeout | undefined;
  const slaGuard = new Promise<null>((resolve) => {
    timeoutHandle = setTimeout(() => resolve(null), slaBudgetMs);
    timeoutHandle.unref?.();
  });

  let rawResult: ReleaseChangelogAiGenerationOutput | string | null = null;
  try {
    rawResult = await Promise.race([
      provider.generateMarkdown({
        prompt,
        project: trimmedProject,
        epicId,
        itemCount: items.length,
        timeoutMs: slaBudgetMs,
        userId,
        resolvedConfig,
      }),
      slaGuard,
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }

  const aiMarkdown =
    typeof rawResult === 'string'
      ? rawResult
      : rawResult?.markdown ?? null;
  const modelUsed =
    typeof rawResult === 'object' && rawResult !== null
      ? rawResult.modelUsed
      : resolvedConfig.cursorModel;

  if (aiMarkdown && aiMarkdown.trim().length > 0) {
    return {
      epicId,
      version: adoContext.epic.version,
      filename,
      markdown: stripOuterMarkdownFence(aiMarkdown),
      itemCount: items.length,
      leafItemCount,
      platformsIncluded,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      modelUsed,
      skillPathUsed: resolvedConfig.skillPath,
      source: 'ai',
    };
  }

  const fallbackMarkdown = buildFallbackReleaseChangelogMarkdown({
    epic: {
      version: adoContext.epic.version,
      targetDate: adoContext.epic.targetDate,
      descriptionExcerpt: epicDescriptionExcerpt,
    },
    configuredPlatforms: platformState.platforms,
    platformsIncluded,
    items,
  });

  return {
    epicId,
    version: adoContext.epic.version,
    filename,
    markdown: fallbackMarkdown,
    itemCount: items.length,
    leafItemCount,
    platformsIncluded,
    generatedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    modelUsed: null,
    skillPathUsed: resolvedConfig.skillPath,
    source: 'fallback',
  };
}
