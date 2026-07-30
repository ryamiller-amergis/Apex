/**
 * Deterministic sync-time metadata for newly discovered walkthrough anchors.
 *
 * Applied during Track A persist so Sync review is usable immediately.
 * Track B AI smart-tagging may overwrite these fields when it completes.
 */

import {
  isValidSmartTag,
  normalizeSmartTags,
  type WalkthroughAnchorAiProvenance,
  type WalkthroughAnchorSourceKind,
  type WalkthroughAnchorSourceLocation,
} from '../../shared/types/walkthroughAnchorRegistry';
import type { WalkthroughRegistryPlacement } from '../../shared/walkthroughAnchors';
import { WALKTHROUGH_REGISTRY_PLACEMENTS } from '../../shared/walkthroughAnchors';
import { isWalkthroughRoute, listWalkthroughRoutes } from '../../shared/walkthroughRoutes';

export const SYNC_HEURISTIC_MODEL = 'sync-heuristic';
export const SYNC_HEURISTIC_SKILL_PATH = 'walkthrough-anchor-sync-heuristic';
/** Conservative confidence for deterministic suggestions Super Admins should review. */
export const SYNC_HEURISTIC_CONFIDENCE = 0.42;

const TOKEN_SPLIT = /[^a-z0-9]+/g;

const ACTION_TOKENS = new Set([
  'open',
  'edit',
  'save',
  'dismiss',
  'close',
  'cancel',
  'navigate',
  'filter',
  'create',
  'add',
  'approve',
  'reject',
  'submit',
  'delete',
  'remove',
  'search',
  'select',
  'toggle',
  'upload',
  'download',
  'export',
  'import',
  'sync',
  'refresh',
]);

const UI_TOKENS = new Set([
  'button',
  'btn',
  'menu',
  'item',
  'modal',
  'dialog',
  'section',
  'tab',
  'input',
  'field',
  'avatar',
  'header',
  'nav',
  'sidebar',
  'fab',
  'toast',
  'banner',
  'table',
  'row',
  'card',
  'panel',
  'form',
  'checkbox',
  'radio',
  'select',
  'dropdown',
  'link',
  'icon',
  'trigger',
]);

const DOMAIN_HINTS: Array<{ match: RegExp; tag: string }> = [
  { match: /\bprofile\b/, tag: 'profile' },
  { match: /\bnotification/, tag: 'notifications' },
  { match: /\bstandup\b/, tag: 'standup' },
  { match: /\bcalendar\b/, tag: 'calendar' },
  { match: /\bbacklog\b|\bprd\b|\binterview\b/, tag: 'backlog' },
  { match: /\badmin\b|\brbac\b|\broles?\b|\busers?\b|\bgroups?\b/, tag: 'admin' },
  { match: /\bwalkthrough\b|\bcoachmark\b|\btour\b/, tag: 'walkthrough' },
  { match: /\bchangelog\b|\bwhats-?new\b/, tag: 'changelog' },
  { match: /\bado\b|azure.?devops|work.?item/, tag: 'ado' },
  { match: /\bfeature.?request/, tag: 'feature-requests' },
  { match: /\bdesign.?module/, tag: 'design-module' },
  { match: /\bload.?test/, tag: 'load-tests' },
  { match: /\bai.?cost|cost.?analytics/, tag: 'ai-cost' },
  { match: /\bhome\b|agent.?home|ask.?apex/, tag: 'home' },
  { match: /\bplanning\b|roadmap|dev.?stats/, tag: 'planning' },
];

const PATH_ROUTE_HINTS: Array<{ match: RegExp; route: string }> = [
  { match: /ProfilePage|UserMenu|AvatarEditor/i, route: '/profile' },
  { match: /Notification/i, route: '/notifications' },
  { match: /Standup/i, route: '/standup' },
  { match: /ScrumCalendar|UnscheduledList/i, route: '/calendar' },
  { match: /Backlog|PrdReview|Interview/i, route: '/backlog' },
  { match: /FeatureRequest/i, route: '/feature-requests' },
  { match: /DesignModule/i, route: '/design-module' },
  { match: /LoadTest/i, route: '/load-tests' },
  { match: /AiCost|CloudCost/i, route: '/ai-cost' },
  { match: /AgentHome|AskApex|ChatAgent/i, route: '/home' },
  { match: /AdminRoles|AdminUsers|AdminProject/i, route: '/admin' },
  { match: /Walkthrough|PlatformAdmin/i, route: '/home' },
  { match: /CreateAdoItems/i, route: '/backlog' },
];

export interface SyncHeuristicInput {
  testId: string;
  sourceKind?: WalkthroughAnchorSourceKind | null;
  sourceLocations?: readonly WalkthroughAnchorSourceLocation[] | null;
  /** Optional precomputed label; otherwise humanized from testId. */
  label?: string | null;
}

export interface SyncHeuristicSuggestion {
  label: string;
  suggestedRoute: string | null;
  allowedPlacements: WalkthroughRegistryPlacement[];
  smartTags: string[];
  aiProvenance: WalkthroughAnchorAiProvenance;
}

export function humanizeWalkthroughTestId(testId: string): string {
  return testId
    .split('-')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function tokenize(value: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // Split camelCase / PascalCase before lowercasing so CreateAdoItemsModal → create, ado, items, modal.
  const withCamelBreaks = value.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  for (const raw of withCamelBreaks.toLowerCase().split(TOKEN_SPLIT)) {
    const token = raw.trim();
    if (token.length < 2 || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

function primarySourcePath(
  locations: readonly WalkthroughAnchorSourceLocation[] | null | undefined,
): string {
  return locations?.[0]?.filePath?.trim() ?? '';
}

function inferSuggestedRoute(
  testId: string,
  sourcePath: string,
): string | null {
  const haystack = `${testId} ${sourcePath}`.toLowerCase();
  for (const hint of PATH_ROUTE_HINTS) {
    if (hint.match.test(haystack) && isWalkthroughRoute(hint.route)) {
      return hint.route;
    }
  }

  // Exact curated-route token matches (e.g. profile → /profile).
  const routes = listWalkthroughRoutes();
  const tokens = new Set(tokenize(haystack));
  for (const entry of routes) {
    const routeToken = entry.route.replace(/^\//, '').split('/')[0];
    if (routeToken && tokens.has(routeToken) && isWalkthroughRoute(entry.route)) {
      return entry.route;
    }
  }
  return null;
}

function inferPlacements(
  _testId: string,
  _sourcePath: string,
): WalkthroughRegistryPlacement[] {
  // Allow all cardinal placements; walkthrough step placement + Floating UI
  // flip/shift decide the on-screen side at playback time.
  return [...WALKTHROUGH_REGISTRY_PLACEMENTS];
}

function pushUnique(tags: string[], tag: string): void {
  const normalized = tag.trim().toLowerCase();
  if (!isValidSmartTag(normalized)) return;
  if (tags.includes(normalized)) return;
  tags.push(normalized);
}

function inferSmartTags(
  testId: string,
  sourcePath: string,
  suggestedRoute: string | null,
): string[] {
  const tags: string[] = [];
  // Keep original casing for camelCase tokenization; lowercase only for regex haystacks.
  const tokenSource = `${testId} ${sourcePath} ${suggestedRoute ?? ''}`;
  const haystack = tokenSource.toLowerCase();
  const tokens = tokenize(tokenSource);

  for (const hint of DOMAIN_HINTS) {
    if (hint.match.test(haystack)) pushUnique(tags, hint.tag);
  }

  for (const token of tokens) {
    if (ACTION_TOKENS.has(token)) {
      pushUnique(tags, token === 'add' ? 'create' : token === 'close' ? 'dismiss' : token);
    }
    if (UI_TOKENS.has(token)) {
      if (token === 'btn') pushUnique(tags, 'button');
      else if (token === 'menu' || token === 'item') pushUnique(tags, 'menu-item');
      else if (token === 'dialog') pushUnique(tags, 'modal');
      else if (token === 'nav') pushUnique(tags, 'header');
      else pushUnique(tags, token);
    }
  }

  if (/\berror|warning|fail|troubleshoot\b/.test(haystack)) {
    pushUnique(tags, 'troubleshoot');
  }
  if (/\bsettings|preference|config\b/.test(haystack)) {
    pushUnique(tags, 'settings');
  }
  if (/\bonboard|getting.?started|tour\b/.test(haystack)) {
    pushUnique(tags, 'onboarding');
  }

  // Audience defaults — conservative.
  if (/\badmin|super.?admin|platform.?admin\b/.test(haystack)) {
    pushUnique(tags, 'super-admin');
  } else {
    pushUnique(tags, 'all-users');
  }

  // Ensure searchable intent coverage.
  if (!tags.some((t) => t === 'discover' || t === 'configure' || t === 'complete-task' || t === 'troubleshoot' || t === 'announce')) {
    pushUnique(tags, tags.includes('troubleshoot') ? 'troubleshoot' : 'discover');
  }

  // Pad with stable file-derived tokens when still short.
  const fileStem = sourcePath.split(/[/\\]/).pop()?.replace(/\.[^.]+$/, '') ?? '';
  for (const token of tokenize(fileStem)) {
    if (tags.length >= 5) break;
    if (token.length >= 4) pushUnique(tags, token);
  }

  for (const token of tokens) {
    if (tags.length >= 5) break;
    if (token.length >= 4) pushUnique(tags, token);
  }

  const normalized = normalizeSmartTags(tags).slice(0, 8);
  // Guarantee at least 3 kebab tags for review usefulness.
  while (normalized.length < 3) {
    const filler = ['navigation', 'section', 'button'][normalized.length];
    if (!normalized.includes(filler)) normalized.push(filler);
    else break;
  }
  return normalized;
}

/**
 * Build deterministic label / route / placements / tags / provenance for a sync candidate.
 */
export function suggestSyncCandidateMetadata(
  input: SyncHeuristicInput,
): SyncHeuristicSuggestion {
  const testId = input.testId.trim();
  const sourcePath = primarySourcePath(input.sourceLocations);
  const label = (input.label?.trim() || humanizeWalkthroughTestId(testId)).trim();
  const suggestedRoute = inferSuggestedRoute(testId, sourcePath);
  const allowedPlacements = inferPlacements(testId, sourcePath);
  const smartTags = inferSmartTags(testId, sourcePath, suggestedRoute);

  const evidenceBits = [
    sourcePath ? `source ${sourcePath}` : null,
    suggestedRoute ? `route hint ${suggestedRoute}` : 'no curated route match',
    `tags from testId/path tokens`,
  ].filter(Boolean);

  const aiProvenance: WalkthroughAnchorAiProvenance = {
    provider: 'cursor',
    model: SYNC_HEURISTIC_MODEL,
    skillPath: SYNC_HEURISTIC_SKILL_PATH,
    generatedAt: new Date().toISOString(),
    runId: null,
    threadId: null,
    confidence: SYNC_HEURISTIC_CONFIDENCE,
    rationale: `Deterministic sync heuristic (${evidenceBits.join('; ')}). AI smart-tagging may refine this.`,
  };

  return {
    label,
    suggestedRoute,
    allowedPlacements,
    smartTags,
    aiProvenance,
  };
}

/** True when a pending row still needs baseline enrichment. */
export function needsSyncHeuristicEnrichment(row: {
  reviewStatus: string;
  smartTags: readonly string[];
  aiProvenance?: WalkthroughAnchorAiProvenance | null;
}): boolean {
  if (row.reviewStatus !== 'pending') return false;
  if (row.smartTags.length > 0) return false;
  // Leave AI-tagged rows alone even if tags were later cleared.
  if (row.aiProvenance?.model && row.aiProvenance.model !== SYNC_HEURISTIC_MODEL) {
    return false;
  }
  return true;
}

/**
 * True when pending metadata still awaits Track B AI smart-tagging.
 */
export function needsAiSmartTagging(row: {
  reviewStatus: string;
  testId?: string;
  smartTags: readonly string[];
  aiProvenance?: WalkthroughAnchorAiProvenance | null;
}): boolean {
  if (row.reviewStatus !== 'pending') return false;
  if (row.testId && !isPlausibleWalkthroughTestId(row.testId)) return false;
  // Real AI already applied.
  if (
    row.aiProvenance?.model &&
    row.aiProvenance.model !== SYNC_HEURISTIC_MODEL &&
    row.smartTags.length > 0
  ) {
    return false;
  }
  return true;
}

/** Reject scanner false-positives such as template placeholders (`${escaped}`). */
export function isPlausibleWalkthroughTestId(testId: string): boolean {
  const trimmed = testId.trim();
  if (!trimmed) return false;
  if (trimmed.includes('${') || trimmed.includes('`')) return false;
  // Stable allow-list keys are lowercase kebab / alnum with hyphens/underscores/dots.
  return /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(trimmed);
}
