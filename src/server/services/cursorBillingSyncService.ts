/**
 * Cursor Billing Sync Service
 *
 * Pulls /teams/filtered-usage-events (by service account or isHeadless) and
 * /teams/spend from the Cursor Admin API hourly. Upserts into cursor_usage_events.
 *
 * Rate limits: <=1 pull/hour recommended; 20 req/min hard limit.
 * Data is aggregated hourly by Cursor — no point polling more often.
 */
import https from 'https';
import { db } from '../db/drizzle';
import { cursorUsageEvents } from '../db/schema';
import crypto from 'crypto';

const CURSOR_BASE_HOST = 'api.cursor.com';

function getAdminApiKey(): string {
  const key = process.env.CURSOR_TEAM_API_KEY ?? '';
  if (!key) throw new Error('CURSOR_TEAM_API_KEY is not configured');
  return key;
}

function basicAuth(apiKey: string): string {
  return 'Basic ' + Buffer.from(`${apiKey}:`).toString('base64');
}

function cursorPost<T>(path: string, body: unknown): Promise<T> {
  const apiKey = getAdminApiKey();
  const payload = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: CURSOR_BASE_HOST,
        path,
        method: 'POST',
        headers: {
          Authorization: basicAuth(apiKey),
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Accept: 'application/json',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(data) as T); }
            catch { reject(new Error(`Cursor API JSON parse error: ${path}`)); }
          } else {
            reject(new Error(`Cursor API ${res.statusCode}: ${path}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(15_000, () => { req.destroy(); reject(new Error(`Cursor API timeout: ${path}`)); });
    req.write(payload);
    req.end();
  });
}

interface CursorUsageEvent {
  timestamp: string;
  userEmail?: string;
  serviceAccountId?: string;
  serviceAccountName?: string;
  model: string;
  kind?: string;
  maxMode?: boolean;
  requestsCosts?: number;
  isTokenBasedCall?: boolean;
  isChargeable?: boolean;
  isHeadless?: boolean;
  tokenUsage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheWriteTokens?: number;
    cacheReadTokens?: number;
    totalCents?: number;
    discountPercentOff?: number;
  };
  chargedCents?: number;
  cursorTokenFee?: number;
}

interface CursorFilteredUsageResponse {
  totalUsageEventsCount: number;
  pagination?: {
    numPages: number;
    currentPage: number;
    pageSize: number;
    hasNextPage: boolean;
  };
  usageEvents: CursorUsageEvent[];
}

/** Deterministic dedupe key from Cursor event fields */
function makeDedupeKey(event: CursorUsageEvent): string {
  const raw = `${event.timestamp}|${event.userEmail ?? ''}|${event.serviceAccountId ?? ''}|${event.model}|${event.chargedCents ?? 0}|${event.tokenUsage?.inputTokens ?? 0}|${event.tokenUsage?.outputTokens ?? 0}`;
  return crypto.createHash('sha1').update(raw).digest('hex');
}

/**
 * Pull all filtered-usage-events for the given filters (service account or
 * isHeadless for the shared account) in a date range and upsert into the DB.
 */
async function syncFilteredUsageEvents(
  startDate: number,
  endDate: number,
  serviceAccountId?: string,
  assignProject?: string,
): Promise<{ inserted: number; skipped: number }> {
  let inserted = 0;
  let skipped = 0;
  let page = 1;
  const PAGE_SIZE = 100;

  while (true) {
    const body: Record<string, unknown> = { startDate, endDate, page, pageSize: PAGE_SIZE };
    if (serviceAccountId) {
      // Filter to a specific service account (exact billing attribution)
      body.serviceAccountId = serviceAccountId;
    }
    // Note: no isHeadless filter parameter exists on the API — we ingest all events
    // and filter to isHeadless=true rows in the allocation step when no SA ID is configured.

    const res = await cursorPost<CursorFilteredUsageResponse>('/teams/filtered-usage-events', body);
    const events = res.usageEvents ?? [];

    for (const ev of events) {
      const dedupeKey = makeDedupeKey(ev);
      const tsMs = parseInt(ev.timestamp, 10);
      const ts = new Date(tsMs).toISOString();

      try {
        await db.insert(cursorUsageEvents).values({
          ts,
          serviceAccountId: ev.serviceAccountId ?? null,
          project: assignProject ?? null,
          model: ev.model,
          kind: ev.kind ?? null,
          maxMode: ev.maxMode ?? false,
          isHeadless: ev.isHeadless ?? false,
          isTokenBasedCall: ev.isTokenBasedCall ?? false,
          isChargeable: ev.isChargeable ?? false,
          inputTokens: ev.tokenUsage?.inputTokens ?? null,
          outputTokens: ev.tokenUsage?.outputTokens ?? null,
          cacheWriteTokens: ev.tokenUsage?.cacheWriteTokens ?? null,
          cacheReadTokens: ev.tokenUsage?.cacheReadTokens ?? null,
          totalModelCents: ev.tokenUsage?.totalCents != null ? String(ev.tokenUsage.totalCents) : null,
          chargedCents: String(ev.chargedCents ?? 0),
          cursorTokenFeeCents: ev.cursorTokenFee != null ? String(ev.cursorTokenFee) : null,
          requestsCosts: ev.requestsCosts != null ? String(ev.requestsCosts) : null,
          userEmail: ev.userEmail ?? null,
          dedupeKey,
        }).onConflictDoNothing();
        inserted++;
      } catch {
        skipped++;
      }
    }

    if (!res.pagination?.hasNextPage) break;
    page++;
  }

  return { inserted, skipped };
}

/** Run the full hourly billing sync. */
export async function runCursorBillingSync(): Promise<void> {
  const now = Date.now();
  // Look back 2 hours to catch any Cursor aggregation lag
  const startDate = now - 2 * 60 * 60 * 1000;
  const endDate = now;

  // If a dedicated service account ID is configured, filter to it for exact attribution.
  // Otherwise, ingest all team events — the allocation step then filters to isHeadless=true
  // rows which cleanly isolates Apex's programmatic agent runs from human IDE usage.
  const sharedServiceAccountId = process.env.CURSOR_SERVICE_ACCOUNT_ID?.trim() || undefined;

  const { inserted, skipped } = await syncFilteredUsageEvents(
    startDate,
    endDate,
    sharedServiceAccountId,
    undefined, // project resolved at allocation time, not here
  );

  console.log(`[cursorBillingSync] Synced: inserted=${inserted}, skipped=${skipped}, filterMode=${sharedServiceAccountId ? 'serviceAccount' : 'isHeadless'}`);
}
