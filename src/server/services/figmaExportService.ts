/**
 * figmaExportService.ts
 *
 * Single entry point for all Figma design export logic.
 * The implementation strategy is swapped here in one place — nothing else
 * in the codebase needs to change when Figma's public Make API ships.
 *
 * Current strategy:   CURSOR_AGENT  (spawns `agent` CLI headlessly)
 * Future strategy:    FIGMA_MAKE_API (direct REST call, no Cursor needed)
 *
 * To switch: change STRATEGY below and implement figmaMakeApiExport().
 */

import { triggerFigmaExportViaAgent } from './cursorAgentService';

/* ── Strategy selector ──────────────────────────────────────── */

type ExportStrategy = 'CURSOR_AGENT' | 'FIGMA_MAKE_API';

/**
 * Change this to 'FIGMA_MAKE_API' once Figma publishes their Make/capture
 * REST endpoint. Add FIGMA_TOKEN to .env and implement figmaMakeApiExport().
 *
 * Tracking: https://www.figma.com/developers  (watch for write/capture API)
 */
const STRATEGY: ExportStrategy = 'CURSOR_AGENT';

/* ── Shared types ───────────────────────────────────────────── */

export interface FigmaExportInput {
  featureId: string;
  featureTitle: string;
  pagePath: string;
  /** Fully-qualified URL to the rendered HTML mock (e.g. http://localhost:3001/api/backlog/mock-html/...) */
  mockHtmlUrl: string;
}

export interface FigmaExportResult {
  success: boolean;
  /** Figma page URL — present when success is true */
  figmaUrl?: string;
  error?: string;
}

/* ── Figma Make API (future) ────────────────────────────────── */

/**
 * TODO: implement when Figma publishes their Make/capture REST API.
 *
 * Expected shape (speculative, update when docs are available):
 *
 *   POST https://api.figma.com/v1/make/captures
 *   Authorization: Bearer <FIGMA_TOKEN>
 *   { "url": "<mockHtmlUrl>", "fileKey": "<targetFileKey>", "pageName": "<featureTitle>" }
 *   → { "captureId": "...", "status": "processing" }
 *
 *   GET https://api.figma.com/v1/make/captures/<captureId>
 *   → { "status": "completed", "figmaUrl": "https://www.figma.com/design/..." }
 *
 * When this ships, flip STRATEGY to 'FIGMA_MAKE_API' and fill in below.
 */
async function figmaMakeApiExport(_input: FigmaExportInput): Promise<FigmaExportResult> {
  const token = process.env.FIGMA_TOKEN;
  if (!token) {
    return { success: false, error: 'FIGMA_TOKEN is not set in .env' };
  }

  // ── Placeholder — replace with real implementation once API is published ──
  return {
    success: false,
    error: 'Figma Make REST API is not yet publicly available. Set STRATEGY to CURSOR_AGENT or check https://www.figma.com/developers for updates.',
  };
}

/* ── Cursor agent (current) ─────────────────────────────────── */

async function cursorAgentExport(input: FigmaExportInput): Promise<FigmaExportResult> {
  return triggerFigmaExportViaAgent(input);
}

/* ── Public entry point ─────────────────────────────────────── */

/**
 * Export an approved UI mock to Figma.
 * Delegates to the active strategy — swap STRATEGY above to change behaviour.
 */
export async function exportMockToFigma(input: FigmaExportInput): Promise<FigmaExportResult> {
  switch (STRATEGY) {
    case 'FIGMA_MAKE_API':
      return figmaMakeApiExport(input);
    case 'CURSOR_AGENT':
    default:
      return cursorAgentExport(input);
  }
}
