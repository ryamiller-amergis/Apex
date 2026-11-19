/**
 * TBI-016 DoD-0..2, PBI-010 AC-3, VT-35, VT-48:
 * Chat-harness governance, Cursor SDK import boundary, and docs checks.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../../..');
const SRC_ROOT = resolve(REPO_ROOT, 'src');
const SERVICES_ROOT = resolve(SRC_ROOT, 'server/services');
const ADAPTER_ROOT = resolve(SERVICES_ROOT, 'cursorSdkAdapter');
const RULE_PATH = resolve(REPO_ROOT, '.cursor/rules/chat-harness.mdc');
const AGENTS_MD_PATH = resolve(REPO_ROOT, 'AGENTS.md');
const CONTEXT_MD_PATH = resolve(REPO_ROOT, 'context.md');
const SKILLS_DIR = resolve(REPO_ROOT, '.cursor/skills');

const V2_HOST_DIRS = [
  resolve(SERVICES_ROOT, 'interactiveActorHost'),
  resolve(SERVICES_ROOT, 'aiRunsV2Worker'),
  resolve(SERVICES_ROOT, 'aiRunsWorker'),
  resolve(SERVICES_ROOT, 'aiRunV2'),
];

const SDK_IMPORT_RE =
  /(?:from\s+['"]@cursor\/sdk(?:\/[^'"]*)?['"]|import\s*\(\s*['"]@cursor\/sdk(?:\/[^'"]*)?['"]\s*\)|require\s*\(\s*['"]@cursor\/sdk(?:\/[^'"]*)?['"]\s*\))/;

const REQUIRED_TERMS = [
  'area profile',
  'session binding',
  'acquisition mode',
  'steer',
] as const;

function toPosixRepoPath(absPath: string): string {
  return relative(REPO_ROOT, absPath).split('\\').join('/');
}

function collectSourceFiles(dir: string, excludeTests = true): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (excludeTests && entry.name === '__tests__') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSourceFiles(full, excludeTests));
    } else if (entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name)) {
      if (excludeTests && /\.(?:test|spec)\.(?:ts|tsx)$/.test(entry.name)) {
        continue;
      }
      out.push(full);
    }
  }
  return out;
}

function extractMarkdownSection(markdown: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const startMatch = new RegExp(`^##\\s+${escaped}\\s*$`, 'im').exec(markdown);
  if (!startMatch) return '';
  const bodyStart = startMatch.index + startMatch[0].length;
  const rest = markdown.slice(bodyStart);
  const nextHeading = /^##\s+/m.exec(rest);
  return nextHeading ? rest.slice(0, nextHeading.index) : rest;
}

function extractBacktickedServicePaths(section: string): string[] {
  const matches = [...section.matchAll(/`(src\/server\/services\/[^`\s]+\.ts)`/g)];
  return [...new Set(matches.map((m) => m[1]))];
}

describe('Chat harness governance and SDK boundary (TBI-016 / PBI-010 / VT-35 / VT-48)', () => {
  describe('VT-35 / DoD-0 / PBI-010 AC-3 — chat-harness Cursor rule & @cursor/sdk import scan', () => {
    it('DoD-0 / PBI-010 AC-3 / VT-35: .cursor/rules/chat-harness.mdc exists and states required behavior and allowed exceptions', () => {
      expect(existsSync(RULE_PATH)).toBe(true);
      const ruleText = readFileSync(RULE_PATH, 'utf8');

      // Frontmatter
      expect(ruleText).toMatch(/^---\r?\n[\s\S]*?description:/);
      expect(ruleText).toMatch(/globs:\s*.*chatHarness/);
      expect(ruleText).toMatch(/alwaysApply:\s*false/);

      // Core requirements for new chat areas
      expect(ruleText).toMatch(/area profile/i);
      expect(ruleText).toMatch(/src\/server\/services\/chatHarness\/areaProfiles\.ts/);
      expect(ruleText).toMatch(/src\/server\/services\/cursorSdkAdapter\//);
      expect(ruleText).toMatch(/harness panel/i);

      // Forbids direct @cursor/sdk imports outside the adapter
      expect(ruleText).toMatch(/@cursor\/sdk/);
      expect(ruleText).toMatch(/v2-worker-no-policy\.mdc/);
      expect(ruleText).toMatch(/\.cursor\/skills\//);

      // Lists non-chat App Service exceptions separately from temporary legacy chat files
      const nonChatSection = extractMarkdownSection(
        ruleText,
        'Allowed non-chat App Service exceptions',
      );
      expect(nonChatSection.length).toBeGreaterThan(0);
      const nonChatExceptions = extractBacktickedServicePaths(nonChatSection);
      expect(nonChatExceptions).toEqual(
        expect.arrayContaining([
          'src/server/services/modelsService.ts',
          'src/server/services/cursorCloudAgentClient.ts',
          'src/server/services/releaseChangelogService.ts',
          'src/server/services/apexWorkItemService.ts',
          'src/server/services/walkthroughAiDraftService.ts',
          'src/server/services/groundingImpactEvaluatorService.ts',
        ]),
      );

      for (const relPath of nonChatExceptions) {
        expect(existsSync(resolve(REPO_ROOT, relPath))).toBe(true);
      }

      const legacySection = extractMarkdownSection(
        ruleText,
        'Temporary legacy chat files (removed in FEAT-003)',
      );
      expect(legacySection.length).toBeGreaterThan(0);
      expect(legacySection).toMatch(/FEAT-003/);
      const legacyChatFiles = extractBacktickedServicePaths(legacySection);
      expect(legacyChatFiles).toEqual(
        expect.arrayContaining([
          'src/server/services/chatAgentService.ts',
          'src/server/services/askApexService.ts',
        ]),
      );
    });

    it('VT-35 / PBI-010 AC-3: zero files in V2 host directories import @cursor/sdk directly', () => {
      const hostFiles = V2_HOST_DIRS.flatMap((dir) => collectSourceFiles(dir));
      expect(hostFiles.length).toBeGreaterThan(10);

      const violations = hostFiles
        .filter((file) => SDK_IMPORT_RE.test(readFileSync(file, 'utf8')))
        .map(toPosixRepoPath);

      expect(violations).toEqual([]);
    });

    it('VT-35 / DoD-0: every @cursor/sdk import in src/ is inside cursorSdkAdapter/ or explicitly listed in chat-harness.mdc', () => {
      expect(existsSync(RULE_PATH)).toBe(true);
      const ruleText = readFileSync(RULE_PATH, 'utf8');

      const nonChatExceptions = extractBacktickedServicePaths(
        extractMarkdownSection(ruleText, 'Allowed non-chat App Service exceptions'),
      );
      const legacyChatFiles = extractBacktickedServicePaths(
        extractMarkdownSection(
          ruleText,
          'Temporary legacy chat files (removed in FEAT-003)',
        ),
      );
      const allowedOutsideAdapter = new Set([
        ...nonChatExceptions,
        ...legacyChatFiles,
      ]);

      const adapterFiles = new Set(
        collectSourceFiles(ADAPTER_ROOT).map(toPosixRepoPath),
      );
      expect(adapterFiles.size).toBeGreaterThan(0);

      const allProdFiles = collectSourceFiles(SRC_ROOT, true);
      const importers = allProdFiles
        .filter((file) => SDK_IMPORT_RE.test(readFileSync(file, 'utf8')))
        .map(toPosixRepoPath);

      // Adapter itself must actually contain at least one @cursor/sdk import
      expect(importers.some((file) => adapterFiles.has(file))).toBe(true);

      // No file inside chatHarness/ imports @cursor/sdk directly
      expect(
        importers.filter((file) =>
          file.startsWith('src/server/services/chatHarness/'),
        ),
      ).toEqual([]);

      // Every importer outside the adapter must be listed in chat-harness.mdc
      const unlisted = importers.filter(
        (file) => !adapterFiles.has(file) && !allowedOutsideAdapter.has(file),
      );
      expect(unlisted).toEqual([]);
    });
  });

  describe('VT-48 / DoD-1 / DoD-2 — AGENTS.md, context.md, and no new chat-harness Skill', () => {
    it('DoD-1 / VT-48: AGENTS.md includes the Chat Harness feature-map row and all four terms', () => {
      const agentsMd = readFileSync(AGENTS_MD_PATH, 'utf8');

      // Feature Map row
      const featureMapSection = extractMarkdownSection(agentsMd, 'Feature Map');
      const chatHarnessRow = featureMapSection
        .split(/\r?\n/)
        .find((line) => /^\|\s*Chat Harness\s*\|/i.test(line));
      expect(chatHarnessRow).toBeDefined();
      expect(chatHarnessRow).toMatch(/areaProfiles\.ts/);
      expect(chatHarnessRow).toMatch(/areaProfileResolver\.ts/);
      expect(chatHarnessRow).toMatch(/cursorSdkAdapter\//);
      expect(chatHarnessRow).toMatch(/chatHarness\.ts/);

      // Key Terminology table has all four required terms
      const terminologySection = extractMarkdownSection(
        agentsMd,
        'Key Terminology',
      );
      for (const term of REQUIRED_TERMS) {
        const termRowRe = new RegExp(`^\\|\\s*\\*\\*${term}\\*\\*\\s*\\|`, 'im');
        expect(terminologySection).toMatch(termRowRe);
      }
    });

    it('DoD-2 / VT-48: context.md includes a Chat Harness description and all four terms', () => {
      const contextMd = readFileSync(CONTEXT_MD_PATH, 'utf8');

      // Chat Harness feature description
      expect(contextMd).toMatch(/^###\s+.*Chat Harness/im);
      expect(contextMd).toMatch(/area profile/i);
      expect(contextMd).toMatch(/cursorSdkAdapter|SDK adapter/i);

      // All four required terms defined in context.md
      for (const term of REQUIRED_TERMS) {
        const termHeadingOrBullet = new RegExp(
          `(?:^###\\s+${term}\\b|\\*\\*${term}\\*\\*)`,
          'im',
        );
        expect(contextMd).toMatch(termHeadingOrBullet);
      }
    });

    it('TBI-016 / VT-48: no new Skill file was added under .cursor/skills/ for chat-harness', () => {
      const skillDirs = readdirSync(SKILLS_DIR, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);

      const chatHarnessSkills = skillDirs.filter((name) =>
        /chat[-_]?harness|harness/i.test(name),
      );
      expect(chatHarnessSkills).toEqual([]);
    });
  });
});
