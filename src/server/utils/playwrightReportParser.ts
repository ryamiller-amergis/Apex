import { extractFileFromZip, readZipEntries } from './adoArtifactZip';

export interface PlaywrightReportStats {
  total: number;
  passed: number;
  failed: number;
  flaky: number;
  skipped: number;
}

interface PlaywrightHtmlReportJson {
  stats?: {
    total?: number;
    expected?: number;
    unexpected?: number;
    flaky?: number;
    skipped?: number;
  };
}

const REPORT_TEMPLATE_RE = /<template\s+id="playwrightReportBase64"[^>]*>([\s\S]*?)<\/template>/i;

function decodeEmbeddedReportZip(html: string): Buffer | null {
  const match = REPORT_TEMPLATE_RE.exec(html);
  if (!match?.[1]) return null;

  let payload = match[1].trim();
  const dataUriPrefix = 'data:application/zip;base64,';
  if (payload.startsWith(dataUriPrefix)) {
    payload = payload.slice(dataUriPrefix.length);
  }

  try {
    const zipBuffer = Buffer.from(payload, 'base64');
    return zipBuffer.length > 0 ? zipBuffer : null;
  } catch {
    return null;
  }
}

function statsFromReportJson(raw: string): PlaywrightReportStats | null {
  let parsed: PlaywrightHtmlReportJson;
  try {
    parsed = JSON.parse(raw) as PlaywrightHtmlReportJson;
  } catch {
    return null;
  }

  const stats = parsed.stats;
  if (!stats || typeof stats.total !== 'number') return null;

  const passed = stats.expected ?? 0;
  const failed = stats.unexpected ?? 0;
  const flaky = stats.flaky ?? 0;
  const skipped = stats.skipped ?? 0;

  return {
    total: stats.total,
    passed,
    failed,
    flaky,
    skipped,
  };
}

async function extractReportJsonFromEmbeddedZip(zipBuffer: Buffer): Promise<string | null> {
  const reportJson = await extractFileFromZip(zipBuffer, 'report.json');
  return reportJson ? reportJson.toString('utf8') : null;
}

/**
 * Parse Playwright HTML report stats from index.html content.
 * Playwright embeds a base64 ZIP in `<template id="playwrightReportBase64">`
 * containing report.json with aggregate pass/fail counts.
 */
export async function parsePlaywrightReportHtml(html: string): Promise<PlaywrightReportStats | null> {
  const embeddedZip = decodeEmbeddedReportZip(html);
  if (!embeddedZip) return null;

  const reportJsonText = await extractReportJsonFromEmbeddedZip(embeddedZip);
  if (!reportJsonText) return null;

  return statsFromReportJson(reportJsonText);
}

/** Locate playwright-report/index.html inside a pipeline artifact zip. */
export async function findPlaywrightIndexHtmlInArtifactZip(artifactZip: Buffer): Promise<string | null> {
  const candidates = readZipEntries(artifactZip)
    .map(entry => entry.fileName.replace(/\\/g, '/'))
    .filter(name => name.toLowerCase().endsWith('/playwright-report/index.html') || name.toLowerCase() === 'index.html')
    .sort((a, b) => {
      const aScore = a.toLowerCase().includes('playwright-report/index.html') ? 0 : 1;
      const bScore = b.toLowerCase().includes('playwright-report/index.html') ? 0 : 1;
      return aScore - bScore || a.length - b.length;
    });

  for (const fileName of candidates) {
    const raw = await extractFileFromZip(artifactZip, fileName);
    if (!raw) continue;
    const html = raw.toString('utf8');
    if (html.includes('playwrightReportBase64')) {
      return html;
    }
  }

  return null;
}

/** Parse Playwright stats from a downloaded pipeline artifact zip. */
export async function parsePlaywrightStatsFromArtifactZip(artifactZip: Buffer): Promise<PlaywrightReportStats | null> {
  const html = await findPlaywrightIndexHtmlInArtifactZip(artifactZip);
  if (!html) return null;
  return parsePlaywrightReportHtml(html);
}
