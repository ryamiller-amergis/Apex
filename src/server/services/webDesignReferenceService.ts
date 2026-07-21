/**
 * Web Design Reference Service
 *
 * Fetches live per-feature modern UI design references from Tavily and distils them
 * into a compact markdown block for injection into the Bedrock prototype prompt.
 *
 * Rules (enforced in the prompt, not here):
 * - Only called for NEW-page features when prototype_web_references_enabled is true.
 * - EXTEND mode always uses repo sources only — never web.
 * - References are inspiration only; the project's repo design system is authoritative.
 *
 * Fail-soft: any network/API error returns an empty string so generation never breaks.
 */

import https from 'https';
import crypto from 'crypto';

const TAVILY_API_URL = 'https://api.tavily.com/search';
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes per feature
const MAX_RESULTS = 5;

interface TavilyResult {
  title: string;
  url: string;
  content: string;
}

interface TavilyResponse {
  results?: TavilyResult[];
}

interface CacheEntry {
  markdown: string;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(featureName: string, designSystemName: string): string {
  return crypto.createHash('sha256').update(`${featureName}::${designSystemName}`).digest('hex').slice(0, 16);
}

async function callTavily(query: string, apiKey: string): Promise<TavilyResult[]> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      query,
      search_depth: 'basic',
      max_results: MAX_RESULTS,
      include_answer: false,
    });

    const url = new URL(TAVILY_API_URL);
    const options: https.RequestOptions = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const json = JSON.parse(data) as TavilyResponse;
            resolve(json.results ?? []);
          } catch {
            reject(new Error('Tavily response was not valid JSON'));
          }
        } else {
          reject(new Error(`Tavily returned ${res.statusCode}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(12_000, () => { req.destroy(); reject(new Error('Tavily request timed out')); });
    req.write(body);
    req.end();
  });
}

function distil(results: TavilyResult[]): string {
  if (results.length === 0) return '';
  const lines = results.slice(0, MAX_RESULTS).map((r, i) => {
    const snippet = r.content.replace(/\s+/g, ' ').trim().slice(0, 200);
    return `${i + 1}. **${r.title}** — ${snippet} ([source](${r.url}))`;
  });
  return lines.join('\n');
}

export interface WebDesignReferenceOptions {
  featureName: string;
  featureDescription?: string;
  designSystemName: string;
}

/**
 * Fetch modern UI design references for a feature.
 * Returns a compact markdown block (inspiration only, subordinate to the repo design system).
 * Returns an empty string on any error so prototype generation never breaks.
 */
export async function getDesignReferences(opts: WebDesignReferenceOptions): Promise<string> {
  // Support both TAVILY_API_KEY (bare key) and TAVILY_AUTH ("Bearer tvly-...").
  const raw = process.env.TAVILY_API_KEY ?? process.env.TAVILY_AUTH ?? '';
  const apiKey = raw.startsWith('Bearer ') ? raw.slice(7).trim() : raw.trim();
  if (!apiKey) {
    console.warn('[webDesignReferenceService] TAVILY_API_KEY / TAVILY_AUTH not set — skipping web design references');
    return '';
  }

  const key = cacheKey(opts.featureName, opts.designSystemName);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.markdown;
  }

  const descClause = opts.featureDescription
    ? ` for "${opts.featureDescription.slice(0, 80)}"`
    : '';
  const query = `best modern SaaS UI design pattern ${opts.featureName}${descClause} animations micro-interactions 2025 production quality`;

  try {
    const results = await callTavily(query, apiKey);
    const markdown = distil(results);
    cache.set(key, { markdown, fetchedAt: Date.now() });
    console.log(`[webDesignReferenceService] Fetched ${results.length} web design references for "${opts.featureName}"`);
    return markdown;
  } catch (err: any) {
    console.warn(`[webDesignReferenceService] Tavily search failed for "${opts.featureName}": ${err.message}`);
    return '';
  }
}

/** Clear the reference cache (useful in tests). */
export function clearDesignReferenceCache(): void {
  cache.clear();
}
