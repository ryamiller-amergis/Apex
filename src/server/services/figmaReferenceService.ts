/**
 * Figma Reference Service
 *
 * Provides visual and structural design context sourced directly from the
 * MaxView Figma design files, not from code parsing.
 *
 * The reference consists of:
 *   - PNG screenshots of real MaxView pages (stored in src/server/assets/)
 *   - Nav items extracted from Figma metadata
 *   - Design token hints (colors, typography derived from screenshots)
 *
 * To refresh the reference after design changes, ask the Cursor AI:
 *   "Refresh the MaxView Figma reference"
 * The agent will call get_screenshot on the key Figma frames, download the
 * images to src/server/assets/, and update .cursor/figma-reference.json.
 *
 * Figma source files:
 *   Design system: https://www.figma.com/design/EDtAXPJZtgxFFoHSZt8deF
 *   MaxView UX:    https://www.figma.com/design/ZsL1t2zBbuBCQDwgVHCvEO
 *   Reference frames:
 *     4984:35898  Document Manager – Default (table page, full app shell)
 *     4984:36040  List View – Filled
 */

import fs from 'fs';
import path from 'path';

/* ── Types ─────────────────────────────────────────────────── */

export interface NavItem {
  label: string;
  route: string;
  icon?: string;
}

export interface FigmaReference {
  /** ISO timestamp of when the reference was last captured */
  updatedAt: string;
  /** Nav items from the left sidebar, in order */
  navItems: NavItem[];
  /**
   * Base64-encoded PNG of a full-page screenshot from Figma.
   * Passed to Bedrock as a vision input so Claude can visually match the style.
   */
  tablePageBase64: string | null;
  /** Width of the reference screenshot (for Bedrock image metadata) */
  tablePageWidth: number;
  /** Height of the reference screenshot */
  tablePageHeight: number;
  /** Human-readable label describing what the screenshot shows */
  tablePageLabel: string;
}

/* ── Defaults (from Figma metadata + visual inspection) ────── */

const DEFAULT_NAV_ITEMS: NavItem[] = [
  { label: 'Dashboard',        route: '/dashboard',        icon: 'grid_view' },
  { label: 'Document Manager', route: '/document-manager', icon: 'folder_open' },
  { label: 'Assignments',      route: '/assignments',       icon: 'assignment' },
  { label: 'Shift Scheduler',  route: '/shift-scheduler',  icon: 'calendar_month' },
  { label: 'Timecards',        route: '/timecards',         icon: 'timer' },
];

/* ── Paths ─────────────────────────────────────────────────── */

const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const REFERENCE_META_PATH = path.join(process.cwd(), '.cursor', 'figma-reference.json');
const TABLE_PAGE_PNG = path.join(ASSETS_DIR, 'maxview-page-default.png');

/* ── Cache ─────────────────────────────────────────────────── */

let cachedReference: FigmaReference | null = null;
let cacheLoadedAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes — re-reads disk if PNG was updated

/* ── Load reference ────────────────────────────────────────── */

export function getFigmaReference(): FigmaReference {
  const now = Date.now();
  if (cachedReference && now - cacheLoadedAt < CACHE_TTL_MS) {
    return cachedReference;
  }

  let navItems: NavItem[] = DEFAULT_NAV_ITEMS;
  let updatedAt = '(built-in defaults)';

  /* Read optional metadata from .cursor/figma-reference.json */
  try {
    if (fs.existsSync(REFERENCE_META_PATH)) {
      const meta = JSON.parse(fs.readFileSync(REFERENCE_META_PATH, 'utf-8')) as {
        updatedAt?: string;
        navItems?: NavItem[];
      };
      if (meta.navItems?.length) navItems = meta.navItems;
      if (meta.updatedAt) updatedAt = meta.updatedAt;
    }
  } catch {
    /* ignore — defaults already set */
  }

  /* Read the PNG screenshot (if available) */
  let tablePageBase64: string | null = null;
  let tablePageWidth = 1024;
  let tablePageHeight = 810;

  try {
    if (fs.existsSync(TABLE_PAGE_PNG)) {
      const buf = fs.readFileSync(TABLE_PAGE_PNG);
      tablePageBase64 = buf.toString('base64');
      /* Parse PNG IHDR chunk for actual dimensions */
      if (buf.length > 24) {
        tablePageWidth  = buf.readUInt32BE(16);
        tablePageHeight = buf.readUInt32BE(20);
      }
    }
  } catch {
    /* screenshot missing — continue without it */
  }

  cachedReference = {
    updatedAt,
    navItems,
    tablePageBase64,
    tablePageWidth,
    tablePageHeight,
    tablePageLabel:
      'MaxView app — Document Manager page (Candidate Management section). ' +
      'Left white sidebar with "maxview" gradient logo, icon+text nav items. ' +
      'Right workspace on light gray background. ' +
      'Content area: white card, large page title, underline sub-tabs, ' +
      'toolbar (Columns / Filters / Density / Export + Search), ' +
      'data table with light-gray header, status chips (Active green, ' +
      'Pending Signatures blue, Needs Review orange, Completed dark-green).',
  };
  cacheLoadedAt = now;

  if (tablePageBase64) {
    console.log(
      `[figmaReferenceService] Loaded reference screenshot ` +
      `(${tablePageWidth}×${tablePageHeight}, ` +
      `${Math.round(buf_size(tablePageBase64) / 1024)} KB) ` +
      `| nav items: ${navItems.map(n => n.label).join(', ')}`
    );
  } else {
    console.warn('[figmaReferenceService] No reference screenshot found — visual grounding disabled');
  }

  return cachedReference;
}

function buf_size(b64: string) {
  return Math.round((b64.length * 3) / 4);
}

/** Force a cache refresh on next call (call after updating PNG files) */
export function invalidateFigmaReferenceCache(): void {
  cachedReference = null;
  cacheLoadedAt   = 0;
}
