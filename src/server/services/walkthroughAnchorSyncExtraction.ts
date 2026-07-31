/**
 * Deterministic walkthrough-anchor repository sync extraction (Phase 3).
 *
 * Scans client TS/TSX for literal `data-testid` values and `anchorTestIdProps(...)`.
 * Diffs discoveries against an injected catalog snapshot.
 * Persistence is owned by walkthroughAnchorRegistryService.syncExtractAndPersistAnchors
 * (Wave 2 Track A) — call that for extract+persist; this module stays DB-free.
 *
 * Providers:
 * - `local`: scan cwd / `repositoryRoot` (includes uncommitted WIP — for local authoring).
 * - `github` | `ado`: scan a pre-materialized `repositoryRoot` (committed branch tip)
 *   or accept optional pre-fetched `files`. Callers materialize Apex's skill repo
 *   via repo cache — this module stays DB-free.
 */

import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  WalkthroughAnchorKeys,
  getWalkthroughAnchor,
} from '../../shared/walkthroughAnchors';
import type {
  WalkthroughAnchorReviewStatus,
  WalkthroughAnchorSourceKind,
  WalkthroughAnchorSourceLocation,
} from '../../shared/types/walkthroughAnchorRegistry';
import { isCoachableWalkthroughDiscovery } from './walkthroughAnchorCoachableFilter';

// ── Public types ──────────────────────────────────────────────────────────────

export type WalkthroughAnchorScanProvider = 'local' | 'github' | 'ado';

/** Minimal catalog row shape accepted for test-ID comparison (injected; no DB). */
export interface WalkthroughAnchorCatalogSnapshotEntry {
  testId: string;
  anchorKey?: string;
  reviewStatus?: WalkthroughAnchorReviewStatus;
  isActive?: boolean;
  deletedAt?: string | null;
}

export interface WalkthroughAnchorSourceFile {
  /** Repository-relative posix path (e.g. src/client/components/Foo.tsx). */
  path: string;
  content: string;
}

export interface WalkthroughAnchorLiteralOccurrence {
  testId: string;
  filePath: string;
  line: number | null;
  discoveryKind: Extract<
    WalkthroughAnchorSourceKind,
    'explicit' | 'data_testid'
  >;
  /** When discoveryKind is explicit, the registry / authoring key if known. */
  suggestedAnchorKey?: string | null;
}

export interface WalkthroughAnchorUnsupportedPattern {
  filePath: string;
  line: number | null;
  snippet: string;
  reason: 'dynamic_template' | 'expression' | 'unresolved_anchor_key';
}

export interface WalkthroughAnchorDiscovery {
  testId: string;
  suggestedAnchorKey: string | null;
  sourceKind: Extract<WalkthroughAnchorSourceKind, 'explicit' | 'data_testid'>;
  sourceLocations: WalkthroughAnchorSourceLocation[];
  sourceHash: string;
  /** Wave 2 persistence defaults for newly found candidates. */
  proposedReviewStatus: 'pending';
  proposedIsActive: false;
}

export interface WalkthroughAnchorDuplicateGroup {
  testId: string;
  locations: WalkthroughAnchorSourceLocation[];
}

export interface WalkthroughAnchorMissingWarning {
  testId: string;
  catalogEntry: WalkthroughAnchorCatalogSnapshotEntry;
}

export interface WalkthroughAnchorScanDiagnostics {
  provider: WalkthroughAnchorScanProvider;
  rootPath: string;
  filesScanned: number;
  filesSkipped: number;
  bytesRead: number;
  durationMs: number;
  truncatedFiles: string[];
  errors: Array<{ filePath: string; message: string }>;
  /**
   * Configured branch tip when scanning Apex's skill repo (committed truth).
   * Null for local / in-memory fixtures.
   */
  branch: string | null;
  /**
   * True when the scan used Apex's remote skill-repo checkout (committed branch),
   * not the server's local working tree WIP.
   */
  committedTruth: boolean;
}

export interface WalkthroughAnchorSyncExtractionResult {
  /** Aggregated discoveries (new + existing), prior to catalog partitioning helpers. */
  discoveries: WalkthroughAnchorDiscovery[];
  newCandidates: WalkthroughAnchorDiscovery[];
  existingMatches: WalkthroughAnchorDiscovery[];
  missingWarnings: WalkthroughAnchorMissingWarning[];
  duplicates: WalkthroughAnchorDuplicateGroup[];
  unsupportedDynamicPatterns: WalkthroughAnchorUnsupportedPattern[];
  diagnostics: WalkthroughAnchorScanDiagnostics;
}

export interface ExtractWalkthroughAnchorsOptions {
  provider?: WalkthroughAnchorScanProvider;
  catalogSnapshot?: readonly WalkthroughAnchorCatalogSnapshotEntry[];
  /** Page roots whose transitive client imports are eligible for discovery. */
  pageEntryComponents?: readonly string[];
  /** Soft byte cap per file (default 512 KiB). Oversized files are skipped. */
  maxFileBytes?: number;
  rootPath?: string;
  /** Branch tip label for diagnostics (remote / committed scans). */
  branch?: string | null;
  /** Override committedTruth diagnostic (defaults from provider). */
  committedTruth?: boolean;
}

export interface ScanLocalWalkthroughAnchorsOptions extends ExtractWalkthroughAnchorsOptions {
  /** Absolute repository root (defaults to process.cwd()). */
  repositoryRoot?: string;
  /** Repo-relative client tree to scan (default src/client). */
  clientRelativeRoot?: string;
  maxFiles?: number;
}

export interface SyncExtractWalkthroughAnchorsInput extends ScanLocalWalkthroughAnchorsOptions {
  provider: WalkthroughAnchorScanProvider;
  /**
   * Optional pre-fetched client sources for github | ado (tests / injectors).
   * When omitted for remote providers, callers must supply a materialized `repositoryRoot`.
   */
  files?: readonly WalkthroughAnchorSourceFile[];
}

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_MAX_FILE_BYTES = 512 * 1024;
const DEFAULT_MAX_FILES = 8_000;
const CLIENT_SOURCE_EXT_RE = /\.(tsx?)$/i;
const CLIENT_TEST_PATH_RE =
  /(?:^|\/)(?:__tests__|tests)\/|\.(?:test|spec)\.tsx?$/i;
const IGNORED_DIR_NAMES = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.git',
  '.next',
  'build',
]);

const KEY_BY_CONST_MEMBER = new Map<string, string>(
  Object.entries(WalkthroughAnchorKeys).map(([member, key]) => [member, key])
);

// ── Helpers ───────────────────────────────────────────────────────────────────

function toPosix(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

function lineNumberAtIndex(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source[i] === '\n') line += 1;
  }
  return line;
}

function snippetAt(source: string, index: number, length = 80): string {
  const start = Math.max(0, index);
  return source
    .slice(start, start + length)
    .replace(/\s+/g, ' ')
    .trim();
}

function computeSourceHash(
  testId: string,
  locations: readonly WalkthroughAnchorSourceLocation[]
): string {
  const payload = [
    testId,
    ...locations.map(
      (loc) => `${loc.filePath}:${loc.line ?? ''}:${loc.discoveryKind ?? ''}`
    ),
  ].join('|');
  return createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

function isClientSourcePath(repoRelativePath: string): boolean {
  const posix = toPosix(repoRelativePath);
  if (!CLIENT_SOURCE_EXT_RE.test(posix)) return false;
  if (CLIENT_TEST_PATH_RE.test(posix)) return false;
  return true;
}

const CLIENT_MODULE_EXTENSIONS = ['.ts', '.tsx'] as const;
const MODULE_SPECIFIER_RE =
  /(?:\b(?:import|export)\s+(?:type\s+)?(?:[\w*\s{},]*?\s+from\s+)?|\bimport\s*\(\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/g;

function resolveClientImportPath(
  importerPath: string,
  specifier: string,
  filesByPath: ReadonlyMap<string, WalkthroughAnchorSourceFile>
): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = path.posix.normalize(
    path.posix.join(path.posix.dirname(importerPath), specifier)
  );
  const candidates = [
    base,
    ...CLIENT_MODULE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...CLIENT_MODULE_EXTENSIONS.map((extension) => `${base}/index${extension}`),
  ];
  return candidates.find((candidate) => filesByPath.has(candidate)) ?? null;
}

/**
 * Resolve the transitive import graph from configured page roots. This keeps
 * Sync candidates inside enabled Apex modules before AI batching begins.
 */
export function collectReachableClientSourcePaths(
  files: readonly WalkthroughAnchorSourceFile[],
  pageEntryComponents: readonly string[]
): Set<string> {
  const filesByPath = new Map(
    files.map((file) => [
      toPosix(file.path),
      { ...file, path: toPosix(file.path) },
    ])
  );
  const reachable = new Set<string>();
  const queue = pageEntryComponents
    .map(toPosix)
    .filter((entry) => filesByPath.has(entry));

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (reachable.has(current)) continue;
    reachable.add(current);

    const file = filesByPath.get(current);
    if (!file) continue;
    MODULE_SPECIFIER_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = MODULE_SPECIFIER_RE.exec(file.content)) !== null) {
      const resolved = resolveClientImportPath(current, match[1], filesByPath);
      if (resolved && !reachable.has(resolved)) queue.push(resolved);
    }
  }

  return reachable;
}

function resolveExplicitTestId(anchorKey: string): {
  testId: string | null;
  reason?: WalkthroughAnchorUnsupportedPattern['reason'];
} {
  const entry = getWalkthroughAnchor(anchorKey);
  if (entry) return { testId: entry.testId };
  // Allow fixtures / future keys where key === testId until catalog cutover.
  if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(anchorKey)) {
    return { testId: anchorKey };
  }
  return { testId: null, reason: 'unresolved_anchor_key' };
}

/**
 * AppSidebar convention: module buttons use `nav-item-${item.view}` (optional
 * `testId` override on the same nav-item object). Sync resolves string-literal
 * `view:` / `testId:` fields so catalog presence does not require a static id map.
 */
export function isAppSidebarSourcePath(filePath: string): boolean {
  return /(^|\/)AppSidebar\.tsx$/i.test(toPosix(filePath));
}

const APP_SIDEBAR_NAV_ITEM_PREFIX = 'nav-item-';
const APP_SIDEBAR_VIEW_CONVENTION_RE =
  /navItemTestIdProps\s*\(|['"]data-testid['"]\s*:\s*(?:(?:item\.)?testId\s*\?\?\s*)?`nav-item-\$\{(?:item\.)?view\}|data-testid\s*=\s*\{\s*(?:(?:item\.)?testId\s*\?\?\s*)?`nav-item-\$\{(?:item\.)?view\}/;

/**
 * Resolve AppSidebar nav discoveries from literal `view:` / `testId:` fields.
 * Returns [] when the file is not AppSidebar or the nav-item convention is absent.
 */
export function extractAppSidebarPrefixedViewOccurrences(
  source: string,
  filePath: string
): WalkthroughAnchorLiteralOccurrence[] {
  const posixPath = toPosix(filePath);
  if (!isAppSidebarSourcePath(posixPath)) return [];
  if (!APP_SIDEBAR_VIEW_CONVENTION_RE.test(source)) return [];

  const occurrences: WalkthroughAnchorLiteralOccurrence[] = [];
  const seen = new Set<string>();
  const viewRe = /\bview:\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;

  while ((match = viewRe.exec(source)) !== null) {
    const view = match[1]?.trim();
    if (!view) continue;

    // Prefer an explicit testId on the same object (look ahead until next view:).
    const after = source.slice(match.index, match.index + 500);
    const nextViewOffset = after.slice(1).search(/\bview:\s*['"]/);
    const region =
      nextViewOffset >= 0 ? after.slice(0, nextViewOffset + 1) : after;
    const override = region.match(/\btestId:\s*['"]([^'"]+)['"]/);
    const testId = (override?.[1] ?? `${APP_SIDEBAR_NAV_ITEM_PREFIX}${view}`).trim();
    if (!testId || seen.has(testId)) continue;
    seen.add(testId);

    occurrences.push({
      testId,
      filePath: posixPath,
      line: lineNumberAtIndex(source, match.index),
      discoveryKind: 'data_testid',
      suggestedAnchorKey: testId,
    });
  }

  return occurrences;
}

function isResolvedAppSidebarNavTemplate(
  snippet: string,
  filePath: string
): boolean {
  if (!isAppSidebarSourcePath(filePath)) return false;
  return (
    /nav-item-\$\{(?:item\.)?view\}/.test(snippet) ||
    /navItemTestIdProps\s*\(/.test(snippet)
  );
}

/**
 * Literal-pattern extraction for a single source file.
 * Discovers static test IDs only; records dynamic forms as unsupported.
 * AppSidebar additionally resolves `view:` → `nav-item-${view}` (see above).
 */
export function extractWalkthroughAnchorCandidatesFromSource(
  source: string,
  filePath: string
): {
  literalOccurrences: WalkthroughAnchorLiteralOccurrence[];
  unsupported: WalkthroughAnchorUnsupportedPattern[];
} {
  const posixPath = toPosix(filePath);
  const occurrences: WalkthroughAnchorLiteralOccurrence[] = [];
  const unsupported: WalkthroughAnchorUnsupportedPattern[] = [];
  const seenAt = new Set<string>();

  const pushOccurrence = (occ: WalkthroughAnchorLiteralOccurrence) => {
    const key = `${occ.testId}@${occ.line ?? 0}@${occ.discoveryKind}`;
    if (seenAt.has(key)) return;
    seenAt.add(key);
    occurrences.push(occ);
  };

  const pushUnsupported = (
    index: number,
    reason: WalkthroughAnchorUnsupportedPattern['reason']
  ) => {
    const snippet = snippetAt(source, index);
    if (isResolvedAppSidebarNavTemplate(snippet, posixPath)) {
      return;
    }
    unsupported.push({
      filePath: posixPath,
      line: lineNumberAtIndex(source, index),
      snippet,
      reason,
    });
  };

  // Explicit: anchorTestIdProps(WalkthroughAnchorKeys.FOO) / anchorTestIdProps('key')
  const explicitKeyConstRe =
    /anchorTestIdProps\s*\(\s*WalkthroughAnchorKeys\.([A-Z0-9_]+)\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = explicitKeyConstRe.exec(source)) !== null) {
    const member = match[1];
    const anchorKey = KEY_BY_CONST_MEMBER.get(member);
    if (!anchorKey) {
      pushUnsupported(match.index, 'unresolved_anchor_key');
      continue;
    }
    const resolved = resolveExplicitTestId(anchorKey);
    if (!resolved.testId) {
      pushUnsupported(match.index, resolved.reason ?? 'unresolved_anchor_key');
      continue;
    }
    pushOccurrence({
      testId: resolved.testId,
      filePath: posixPath,
      line: lineNumberAtIndex(source, match.index),
      discoveryKind: 'explicit',
      suggestedAnchorKey: anchorKey,
    });
  }

  const explicitLiteralRe = /anchorTestIdProps\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
  while ((match = explicitLiteralRe.exec(source)) !== null) {
    const anchorKey = match[2];
    const resolved = resolveExplicitTestId(anchorKey);
    if (!resolved.testId) {
      pushUnsupported(match.index, resolved.reason ?? 'unresolved_anchor_key');
      continue;
    }
    pushOccurrence({
      testId: resolved.testId,
      filePath: posixPath,
      line: lineNumberAtIndex(source, match.index),
      discoveryKind: 'explicit',
      suggestedAnchorKey: anchorKey,
    });
  }

  // Dynamic object / spread forms: 'data-testid': `...${...}` or expression
  const dynamicTemplateRe = /['"]data-testid['"]\s*:\s*`[^`]*\$\{[^`]*`/g;
  while ((match = dynamicTemplateRe.exec(source)) !== null) {
    pushUnsupported(match.index, 'dynamic_template');
  }

  const dynamicExprRe =
    /['"]data-testid['"]\s*:\s*(?!['"`])([A-Za-z_$][\w.$]*)/g;
  while ((match = dynamicExprRe.exec(source)) !== null) {
    pushUnsupported(match.index, 'expression');
  }

  // Legacy JSX attribute dynamics: data-testid={`...${}`} or data-testid={expr}
  const legacyDynamicTemplateRe =
    /\bdata-testid\s*=\s*\{\s*`[^`]*\$\{[^`]*`\s*\}/g;
  while ((match = legacyDynamicTemplateRe.exec(source)) !== null) {
    pushUnsupported(match.index, 'dynamic_template');
  }

  const legacyDynamicExprRe =
    /\bdata-testid\s*=\s*\{\s*(?!['"`])([A-Za-z_$][\w.$]*)/g;
  while ((match = legacyDynamicExprRe.exec(source)) !== null) {
    pushUnsupported(match.index, 'expression');
  }

  // Static literals — object / spread form
  const staticObjectRes: RegExp[] = [
    /['"]data-testid['"]\s*:\s*'([^'\\]+)'/g,
    /['"]data-testid['"]\s*:\s*"([^"\\]+)"/g,
    /['"]data-testid['"]\s*:\s*`([^`${]+)`/g,
  ];
  for (const re of staticObjectRes) {
    re.lastIndex = 0;
    while ((match = re.exec(source)) !== null) {
      const testId = match[1]?.trim();
      if (!testId) continue;
      pushOccurrence({
        testId,
        filePath: posixPath,
        line: lineNumberAtIndex(source, match.index),
        discoveryKind: 'data_testid',
      });
    }
  }

  // Static literals — legacy JSX attribute form
  const staticAttrRes: RegExp[] = [
    /\bdata-testid\s*=\s*"([^"\\]+)"/g,
    /\bdata-testid\s*=\s*'([^'\\]+)'/g,
    /\bdata-testid\s*=\s*\{\s*'([^'\\]+)'\s*\}/g,
    /\bdata-testid\s*=\s*\{\s*"([^"\\]+)"\s*\}/g,
    /\bdata-testid\s*=\s*\{\s*`([^`${]+)`\s*\}/g,
  ];
  for (const re of staticAttrRes) {
    re.lastIndex = 0;
    while ((match = re.exec(source)) !== null) {
      const testId = match[1]?.trim();
      if (!testId) continue;
      pushOccurrence({
        testId,
        filePath: posixPath,
        line: lineNumberAtIndex(source, match.index),
        discoveryKind: 'data_testid',
      });
    }
  }

  for (const occ of extractAppSidebarPrefixedViewOccurrences(source, posixPath)) {
    pushOccurrence(occ);
  }

  return { literalOccurrences: occurrences, unsupported };
}

function aggregateOccurrences(
  occurrences: readonly WalkthroughAnchorLiteralOccurrence[]
): WalkthroughAnchorDiscovery[] {
  const byTestId = new Map<
    string,
    {
      locations: WalkthroughAnchorSourceLocation[];
      suggestedKeys: string[];
      hasExplicit: boolean;
    }
  >();

  for (const occ of occurrences) {
    let bucket = byTestId.get(occ.testId);
    if (!bucket) {
      bucket = { locations: [], suggestedKeys: [], hasExplicit: false };
      byTestId.set(occ.testId, bucket);
    }
    bucket.locations.push({
      filePath: occ.filePath,
      line: occ.line,
      discoveryKind: occ.discoveryKind,
    });
    if (occ.discoveryKind === 'explicit') {
      bucket.hasExplicit = true;
      if (occ.suggestedAnchorKey)
        bucket.suggestedKeys.push(occ.suggestedAnchorKey);
    }
  }

  const discoveries: WalkthroughAnchorDiscovery[] = [];
  for (const [testId, bucket] of [...byTestId.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  )) {
    // Stable location order for deterministic hashes
    bucket.locations.sort((a, b) => {
      const byPath = a.filePath.localeCompare(b.filePath);
      if (byPath !== 0) return byPath;
      return (a.line ?? 0) - (b.line ?? 0);
    });

    const sourceKind: WalkthroughAnchorDiscovery['sourceKind'] =
      bucket.hasExplicit ? 'explicit' : 'data_testid';
    const suggestedAnchorKey =
      bucket.suggestedKeys[0] ?? (sourceKind === 'explicit' ? testId : null);

    discoveries.push({
      testId,
      suggestedAnchorKey,
      sourceKind,
      sourceLocations: bucket.locations,
      sourceHash: computeSourceHash(testId, bucket.locations),
      proposedReviewStatus: 'pending',
      proposedIsActive: false,
    });
  }

  return discoveries.filter((d) =>
    isCoachableWalkthroughDiscovery({
      testId: d.testId,
      sourceKind: d.sourceKind,
      sourceLocations: d.sourceLocations,
    })
  );
}

function buildDuplicates(
  discoveries: readonly WalkthroughAnchorDiscovery[]
): WalkthroughAnchorDuplicateGroup[] {
  return discoveries
    .filter((d) => d.sourceLocations.length > 1)
    .map((d) => ({ testId: d.testId, locations: d.sourceLocations }));
}

/**
 * Compare discoveries to an injected catalog snapshot by test ID.
 * Soft-deleted catalog rows are ignored for missing warnings.
 */
export function diffDiscoveriesAgainstCatalog(
  discoveries: readonly WalkthroughAnchorDiscovery[],
  catalogSnapshot: readonly WalkthroughAnchorCatalogSnapshotEntry[] = []
): {
  newCandidates: WalkthroughAnchorDiscovery[];
  existingMatches: WalkthroughAnchorDiscovery[];
  missingWarnings: WalkthroughAnchorMissingWarning[];
} {
  const activeCatalog = catalogSnapshot.filter((row) => row.deletedAt == null);
  const catalogByTestId = new Map(
    activeCatalog.map((row) => [row.testId, row])
  );
  const seenTestIds = new Set(discoveries.map((d) => d.testId));

  const newCandidates: WalkthroughAnchorDiscovery[] = [];
  const existingMatches: WalkthroughAnchorDiscovery[] = [];

  for (const discovery of discoveries) {
    if (catalogByTestId.has(discovery.testId)) {
      existingMatches.push(discovery);
    } else {
      newCandidates.push(discovery);
    }
  }

  const missingWarnings: WalkthroughAnchorMissingWarning[] = [];
  for (const entry of activeCatalog) {
    if (!seenTestIds.has(entry.testId)) {
      missingWarnings.push({ testId: entry.testId, catalogEntry: entry });
    }
  }

  return { newCandidates, existingMatches, missingWarnings };
}

function isRemoteProvider(
  provider: WalkthroughAnchorScanProvider
): provider is 'github' | 'ado' {
  return provider === 'github' || provider === 'ado';
}

function emptyDiagnostics(
  provider: WalkthroughAnchorScanProvider,
  rootPath: string,
  startedAt: number,
  options?: { branch?: string | null; committedTruth?: boolean }
): WalkthroughAnchorScanDiagnostics {
  return {
    provider,
    rootPath,
    filesScanned: 0,
    filesSkipped: 0,
    bytesRead: 0,
    durationMs: Math.max(0, Date.now() - startedAt),
    truncatedFiles: [],
    errors: [],
    branch: options?.branch ?? null,
    committedTruth:
      options?.committedTruth ?? isRemoteProvider(provider),
  };
}

/**
 * Core extraction over an in-memory file list (fixture-friendly; no I/O).
 */
export function extractWalkthroughAnchorsFromFiles(
  files: readonly WalkthroughAnchorSourceFile[],
  options: ExtractWalkthroughAnchorsOptions = {}
): WalkthroughAnchorSyncExtractionResult {
  const startedAt = Date.now();
  const provider = options.provider ?? 'local';
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const diagnostics = emptyDiagnostics(
    provider,
    options.rootPath ?? '(memory)',
    startedAt,
    {
      branch: options.branch ?? null,
      committedTruth: options.committedTruth,
    }
  );

  const allOccurrences: WalkthroughAnchorLiteralOccurrence[] = [];
  const unsupported: WalkthroughAnchorUnsupportedPattern[] = [];

  const scopedPaths = options.pageEntryComponents?.length
    ? collectReachableClientSourcePaths(files, options.pageEntryComponents)
    : null;
  const scopedFiles = scopedPaths
    ? files.filter((file) => scopedPaths.has(toPosix(file.path)))
    : files;

  for (const file of scopedFiles) {
    const posixPath = toPosix(file.path);
    if (CLIENT_TEST_PATH_RE.test(posixPath)) {
      diagnostics.filesSkipped += 1;
      continue;
    }

    const byteLength = Buffer.byteLength(file.content, 'utf8');
    if (byteLength > maxFileBytes) {
      diagnostics.filesSkipped += 1;
      diagnostics.truncatedFiles.push(posixPath);
      continue;
    }

    diagnostics.filesScanned += 1;
    diagnostics.bytesRead += byteLength;

    const extracted = extractWalkthroughAnchorCandidatesFromSource(
      file.content,
      posixPath
    );
    allOccurrences.push(...extracted.literalOccurrences);
    unsupported.push(...extracted.unsupported);
  }

  const discoveries = aggregateOccurrences(allOccurrences);
  const duplicates = buildDuplicates(discoveries);
  const diff = diffDiscoveriesAgainstCatalog(
    discoveries,
    options.catalogSnapshot ?? []
  );

  diagnostics.durationMs = Math.max(0, Date.now() - startedAt);

  return {
    discoveries,
    newCandidates: diff.newCandidates,
    existingMatches: diff.existingMatches,
    missingWarnings: diff.missingWarnings,
    duplicates,
    unsupportedDynamicPatterns: unsupported,
    diagnostics,
  };
}

function walkClientSourceFiles(
  absoluteClientRoot: string,
  repositoryRoot: string,
  maxFiles: number
): { files: string[]; truncatedListing: boolean } {
  const files: string[] = [];
  let truncatedListing = false;

  const visit = (directory: string): void => {
    if (truncatedListing) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (truncatedListing) return;
      if (entry.isDirectory()) {
        if (IGNORED_DIR_NAMES.has(entry.name)) continue;
        if (entry.name === '__tests__' || entry.name === 'tests') continue;
        visit(path.join(directory, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (!CLIENT_SOURCE_EXT_RE.test(entry.name)) continue;
      if (/\.(?:test|spec)\.tsx?$/i.test(entry.name)) continue;

      const absolute = path.join(directory, entry.name);
      const rel = toPosix(path.relative(repositoryRoot, absolute));
      files.push(rel);
      if (files.length >= maxFiles) {
        truncatedListing = true;
        return;
      }
    }
  };

  if (fs.existsSync(absoluteClientRoot)) {
    visit(absoluteClientRoot);
  }
  files.sort((a, b) => a.localeCompare(b));
  return { files, truncatedListing };
}

/** Scan a checkout's src/client tree (ts/tsx) with bounded reads. */
export function scanLocalWalkthroughAnchors(
  options: ScanLocalWalkthroughAnchorsOptions = {}
): WalkthroughAnchorSyncExtractionResult {
  const startedAt = Date.now();
  const provider = options.provider ?? 'local';
  const repositoryRoot = path.resolve(options.repositoryRoot ?? process.cwd());
  const clientRelativeRoot = toPosix(
    options.clientRelativeRoot ?? 'src/client'
  );
  const absoluteClientRoot = path.join(
    repositoryRoot,
    ...clientRelativeRoot.split('/')
  );
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  const { files: relativePaths, truncatedListing } = walkClientSourceFiles(
    absoluteClientRoot,
    repositoryRoot,
    maxFiles
  );

  const loaded: WalkthroughAnchorSourceFile[] = [];
  const diagnostics = emptyDiagnostics(provider, repositoryRoot, startedAt, {
    branch: options.branch ?? null,
    committedTruth: options.committedTruth,
  });
  if (truncatedListing) {
    diagnostics.errors.push({
      filePath: clientRelativeRoot,
      message: `File listing truncated at maxFiles=${maxFiles}`,
    });
  }

  for (const rel of relativePaths) {
    const absolute = path.join(repositoryRoot, ...rel.split('/'));
    try {
      const stat = fs.statSync(absolute);
      if (stat.size > maxFileBytes) {
        diagnostics.filesSkipped += 1;
        diagnostics.truncatedFiles.push(rel);
        continue;
      }
      const content = fs.readFileSync(absolute, 'utf8');
      loaded.push({ path: rel, content });
    } catch (err) {
      diagnostics.filesSkipped += 1;
      diagnostics.errors.push({
        filePath: rel,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const result = extractWalkthroughAnchorsFromFiles(loaded, {
    provider,
    catalogSnapshot: options.catalogSnapshot,
    pageEntryComponents: options.pageEntryComponents,
    maxFileBytes,
    rootPath: repositoryRoot,
    branch: options.branch ?? null,
    committedTruth: options.committedTruth,
  });

  // Preserve listing-level skip/truncation diagnostics from the walker.
  result.diagnostics.truncatedFiles = [
    ...new Set([
      ...diagnostics.truncatedFiles,
      ...result.diagnostics.truncatedFiles,
    ]),
  ];
  result.diagnostics.filesSkipped += diagnostics.filesSkipped;
  result.diagnostics.errors = [
    ...diagnostics.errors,
    ...result.diagnostics.errors,
  ];
  result.diagnostics.rootPath = repositoryRoot;
  result.diagnostics.branch = diagnostics.branch;
  result.diagnostics.committedTruth = diagnostics.committedTruth;
  result.diagnostics.durationMs = Math.max(0, Date.now() - startedAt);
  return result;
}

/**
 * Provider-aware sync extraction entry point.
 *
 * - `local`: walks the current checkout (or `repositoryRoot`)
 * - `github` | `ado`: scans a pre-materialized `repositoryRoot`, or uses
 *   pre-fetched `files`. Callers (registry sync) materialize Apex's skill repo
 *   via repo cache before invoking this — extraction stays DB-free.
 *
 * Returns a structured diff only. Prefer
 * `walkthroughAnchorRegistryService.syncExtractAndPersistAnchors` for Super Admin sync
 * (persist before AI tagging).
 */
export async function syncExtractWalkthroughAnchors(
  input: SyncExtractWalkthroughAnchorsInput
): Promise<WalkthroughAnchorSyncExtractionResult> {
  if (input.provider === 'local') {
    return scanLocalWalkthroughAnchors({
      ...input,
      provider: 'local',
      committedTruth: input.committedTruth ?? false,
    });
  }

  if (input.files) {
    return extractWalkthroughAnchorsFromFiles(input.files, {
      provider: input.provider,
      catalogSnapshot: input.catalogSnapshot,
      pageEntryComponents: input.pageEntryComponents,
      maxFileBytes: input.maxFileBytes,
      rootPath: input.repositoryRoot ?? input.provider,
      branch: input.branch ?? null,
      committedTruth: input.committedTruth ?? true,
    });
  }

  if (!input.repositoryRoot) {
    throw new Error(
      `Provider "${input.provider}" requires a materialized repositoryRoot or pre-fetched files`
    );
  }

  return scanLocalWalkthroughAnchors({
    ...input,
    provider: input.provider,
    repositoryRoot: input.repositoryRoot,
    committedTruth: input.committedTruth ?? true,
  });
}

/** @internal test seam — re-export path helpers */
export const __test = {
  isClientSourcePath,
  computeSourceHash,
  toPosix,
};
