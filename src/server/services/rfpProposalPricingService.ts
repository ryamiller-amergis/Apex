/**
 * Official-source pricing research for generated RFP proposals.
 *
 * Every priced line cites the official source it came from (AWS Price List Bulk
 * API, or an official vendor page found through Tavily). Builds run on AWS:
 * the messaging choice is priced as Amazon SQS, and logs as CloudWatch.
 * When no official price can be verified the line is returned with
 * `priceStatus: 'unavailable'` and null amounts; it is never estimated here.
 *
 * Fetched text is reference data. Only extracted numbers, the source URL, and a
 * sanitized title leave this module — raw page snippets never reach a prompt.
 */

import {
  type RfpArchitecture,
  type RfpArchitectureSizing,
  type RfpCloudResource,
  type RfpConfidence,
  type RfpCostAmounts,
  type RfpCostLine,
  type RfpCostSourceType,
  type RfpDeploymentRegion,
  type RfpExpectedUserScale,
  type RfpSizingProfile,
  type RfpVerdict,
} from '../../shared/types/rfpIntake';
import {
  loadRfpProposalAiBaseline,
  type RfpProposalAiBaseline,
} from './rfpProposalAiBaselineService';

export interface JsonFetchInit {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
}

export type JsonFetcher = (url: string, init?: JsonFetchInit) => Promise<unknown>;

export class PricingFetchError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'PricingFetchError';
  }
}

export interface JsonFetcherOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
  maxBytes?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_MAX_BYTES = 40 * 1024 * 1024;

async function fetchJsonOnce(
  fetchImpl: typeof fetch,
  url: string,
  init: JsonFetchInit | undefined,
  timeoutMs: number,
  maxBytes: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!res.ok) {
      throw new PricingFetchError(`HTTP ${res.status}`, res.status === 429 || res.status >= 500);
    }
    const declared = Number(res.headers?.get?.('content-length') ?? 0);
    if (declared > maxBytes) throw new PricingFetchError('response is larger than the size limit', false);
    const text = await res.text();
    if (Buffer.byteLength(text) > maxBytes) throw new PricingFetchError('response is larger than the size limit', false);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new PricingFetchError('response was not valid JSON', false);
    }
  } catch (err) {
    if (controller.signal.aborted) throw new PricingFetchError(`timed out after ${timeoutMs} ms`, true);
    if (err instanceof PricingFetchError) throw err;
    throw new PricingFetchError(err instanceof Error ? err.message : String(err), true);
  } finally {
    clearTimeout(timer);
  }
}

/** JSON GET/POST with a per-attempt timeout, bounded retries on transient errors, and a size cap. */
export function createJsonFetcher(options: JsonFetcherOptions = {}): JsonFetcher {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  return async (url, init) => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        return await fetchJsonOnce(fetchImpl, url, init, timeoutMs, maxBytes);
      } catch (err) {
        lastError = err;
        if (!(err instanceof PricingFetchError) || !err.retryable || attempt === retries) break;
        await sleep(500 * 2 ** attempt);
      }
    }
    throw lastError;
  };
}

/** Strips anything that could read as markup or instructions and caps the length. */
export function sanitizeReferenceText(value: string, maxLength = 120): string {
  let cleaned = '';
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 31 || code === 127) {
      cleaned += ' ';
      continue;
    }
    if ('`<>{}[]|\\'.includes(char)) continue;
    cleaned += char;
  }
  return cleaned.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

export function isOfficialVendorUrl(url: string, domains: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

const REGION_CODES: Record<RfpDeploymentRegion, string> = {
  'us-east': 'us-east-1',
  'us-central': 'us-east-2',
  'us-west': 'us-west-2',
};

const AWS_OFFER_BASE = 'https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws';
const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';

export function awsOfferUrl(
  service: 'AmazonRDS' | 'AmazonECS' | 'AmazonSQS' | 'AmazonCloudWatch',
  region: string,
): string {
  return `${AWS_OFFER_BASE}/${service}/current/${region}/index.json`;
}

interface ProfileSpec {
  tasks: number;
  vcpu: number;
  memoryGb: number;
  dbInstance: string;
  dbDeployment: 'Single-AZ' | 'Multi-AZ';
  logGb: number;
  sqsMillionRequests: number;
  sqsQueue: 'standard' | 'fifo';
  responders: RfpCostAmounts;
}

const PROFILES: Record<RfpSizingProfile, ProfileSpec> = {
  small: {
    tasks: 1, vcpu: 0.5, memoryGb: 1, dbInstance: 'db.t4g.small', dbDeployment: 'Single-AZ',
    logGb: 5, sqsMillionRequests: 5, sqsQueue: 'standard', responders: { low: 2, expected: 3, high: 5 },
  },
  medium: {
    tasks: 2, vcpu: 1, memoryGb: 2, dbInstance: 'db.t4g.large', dbDeployment: 'Multi-AZ',
    logGb: 20, sqsMillionRequests: 20, sqsQueue: 'standard', responders: { low: 3, expected: 5, high: 8 },
  },
  large: {
    tasks: 4, vcpu: 2, memoryGb: 4, dbInstance: 'db.m6g.xlarge', dbDeployment: 'Multi-AZ',
    logGb: 60, sqsMillionRequests: 100, sqsQueue: 'fifo', responders: { low: 6, expected: 10, high: 15 },
  },
};

const NON_PROD_STORAGE_GB = 20;
const NON_PROD_LOG_GB = 2;
const ALWAYS_ON_HOURS = 730;
const BUSINESS_HOURS = 264;

const LICENSED_USERS: Record<RfpExpectedUserScale, RfpCostAmounts> = {
  small: { low: 25, expected: 50, high: 100 },
  medium: { low: 150, expected: 300, high: 500 },
  large: { low: 501, expected: 750, high: 1500 },
};

const AI_TOKENS_MILLIONS = { light: 5, moderate: 25, heavy: 100 } as const;

type VendorPriceUnit = 'user/month' | 'million tokens';

interface VendorProduct {
  key: string;
  match: RegExp;
  product: string;
  domains: readonly string[];
  query: string;
  unit: VendorPriceUnit;
}

const VENDOR_PRODUCTS: readonly VendorProduct[] = [
  { key: 'pagerduty', match: /pagerduty/i, product: 'PagerDuty', domains: ['pagerduty.com'], query: 'PagerDuty pricing per user per month', unit: 'user/month' },
  { key: 'copilot-studio', match: /copilot studio/i, product: 'Microsoft Copilot Studio', domains: ['microsoft.com'], query: 'Microsoft Copilot Studio pricing', unit: 'user/month' },
  { key: 'm365-copilot', match: /(microsoft|m)\s?365 copilot/i, product: 'Microsoft 365 Copilot', domains: ['microsoft.com'], query: 'Microsoft 365 Copilot pricing per user per month', unit: 'user/month' },
  { key: 'power-automate', match: /power automate/i, product: 'Microsoft Power Automate', domains: ['microsoft.com'], query: 'Microsoft Power Automate pricing per user per month', unit: 'user/month' },
  { key: 'power-apps', match: /power ?apps|power platform/i, product: 'Microsoft Power Apps', domains: ['microsoft.com'], query: 'Microsoft Power Apps pricing per user per month', unit: 'user/month' },
  { key: 'bedrock', match: /bedrock/i, product: 'Amazon Bedrock', domains: ['aws.amazon.com'], query: 'Amazon Bedrock pricing Anthropic Claude per million input tokens', unit: 'million tokens' },
];

const BEDROCK = VENDOR_PRODUCTS.find((product) => product.key === 'bedrock') as VendorProduct;
const PAGERDUTY = VENDOR_PRODUCTS.find((product) => product.key === 'pagerduty') as VendorProduct;

const PRICE_PATTERNS: Record<VendorPriceUnit, RegExp> = {
  'user/month': /\$\s?(\d{1,4}(?:\.\d{1,2})?)\s*(?:USD\s*)?(?:\/|per)\s*(?:user|seat|license)\s*(?:\/|per)\s*(?:mo|month)\b/i,
  'million tokens': /\$\s?(\d{1,4}(?:\.\d{1,4})?)\s*(?:\/|per)\s*(?:1M|1 million|million|1,000,000)\s*(?:input\s+)?tokens/i,
};

export function extractVendorPrice(text: string, unit: VendorPriceUnit): number | null {
  const match = PRICE_PATTERNS[unit].exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

export interface VendorSearchResult {
  url: string;
  title: string;
  content: string;
}

export type VendorSearch = (query: string, domains: readonly string[]) => Promise<VendorSearchResult[]>;

export interface PricingDeps {
  fetchJson: JsonFetcher;
  searchVendor: VendorSearch | null;
  now: () => Date;
  cacheTtlMs?: number;
  loadObservedAiBaseline?: () => Promise<RfpProposalAiBaseline | null>;
}

export interface PricingRequest {
  architecture: Pick<RfpArchitecture, 'resources' | 'requiresAi'> & { sizing: RfpArchitectureSizing };
  verdict: RfpVerdict;
  expectedUsers: RfpExpectedUserScale | null;
  recommendedTooling: string[];
}

export interface PricingResult {
  lines: RfpCostLine[];
  researchedAt: string;
}

interface Source {
  type: RfpCostSourceType;
  url: string;
  title: string;
}

interface AwsOffer {
  publicationDate?: string;
  products?: Record<string, { sku: string; productFamily?: string; attributes?: Record<string, string> }>;
  terms?: {
    OnDemand?: Record<string, Record<string, { priceDimensions?: Record<string, { pricePerUnit?: { USD?: string } }> }>>;
  };
}

interface RdsPrices {
  instances: Map<string, number>;
  gp3Storage: Map<string, number>;
}

interface FargatePrices {
  vcpuHour: number | null;
  gbHour: number | null;
}

interface SqsPrices {
  standardPerMillion: number | null;
  fifoPerMillion: number | null;
}

function onDemandUsd(offer: AwsOffer, sku: string): number | null {
  const terms = offer.terms?.OnDemand?.[sku];
  if (!terms) return null;
  for (const term of Object.values(terms)) {
    for (const dimension of Object.values(term.priceDimensions ?? {})) {
      const value = Number(dimension.pricePerUnit?.USD);
      if (Number.isFinite(value) && value > 0) return value;
    }
  }
  return null;
}

function parseRdsOffer(offer: AwsOffer, region: string): RdsPrices {
  const instances = new Map<string, number>();
  const gp3Storage = new Map<string, number>();
  for (const product of Object.values(offer.products ?? {})) {
    const attrs = product.attributes ?? {};
    if (attrs.databaseEngine !== 'PostgreSQL' || attrs.regionCode !== region) continue;
    const deployment = attrs.deploymentOption;
    if (deployment !== 'Single-AZ' && deployment !== 'Multi-AZ') continue;
    if (product.productFamily === 'Database Instance' && attrs.instanceType) {
      const key = `${attrs.instanceType}|${deployment}`;
      if (instances.has(key)) continue;
      const price = onDemandUsd(offer, product.sku);
      if (price !== null) instances.set(key, price);
    } else if (product.productFamily === 'Database Storage' && attrs.volumeType === 'General Purpose-GP3') {
      if (gp3Storage.has(deployment)) continue;
      const price = onDemandUsd(offer, product.sku);
      if (price !== null) gp3Storage.set(deployment, price);
    }
  }
  return { instances, gp3Storage };
}

function parseFargateOffer(offer: AwsOffer, region: string): FargatePrices {
  const prices: FargatePrices = { vcpuHour: null, gbHour: null };
  for (const product of Object.values(offer.products ?? {})) {
    const attrs = product.attributes ?? {};
    if (attrs.regionCode !== region) continue;
    const usage = attrs.usagetype ?? '';
    if (prices.vcpuHour === null && /-Fargate-vCPU-Hours:perCPU$/.test(usage)) {
      prices.vcpuHour = onDemandUsd(offer, product.sku);
    } else if (prices.gbHour === null && /-Fargate-GB-Hours$/.test(usage)) {
      prices.gbHour = onDemandUsd(offer, product.sku);
    }
  }
  return prices;
}

function perMillion(price: number): number {
  return price < 0.01 ? Math.round(price * 1_000_000 * 1e6) / 1e6 : price;
}

function parseSqsOffer(offer: AwsOffer, region: string): SqsPrices {
  const prices: SqsPrices = { standardPerMillion: null, fifoPerMillion: null };
  for (const product of Object.values(offer.products ?? {})) {
    const attrs = product.attributes ?? {};
    if (attrs.regionCode !== region) continue;
    const usage = attrs.usagetype ?? '';
    const queue = (attrs.queueType ?? '').toLowerCase();
    if (!/Tier1$/i.test(usage)) continue;
    const price = onDemandUsd(offer, product.sku);
    if (price === null) continue;
    if (prices.standardPerMillion === null && queue === 'standard' && !/fifo/i.test(usage)) {
      prices.standardPerMillion = perMillion(price);
    } else if (prices.fifoPerMillion === null && (queue === 'fifo' || /fifo/i.test(usage))) {
      prices.fifoPerMillion = perMillion(price);
    }
  }
  return prices;
}

function parseCloudWatchIngestion(offer: AwsOffer, region: string): number | null {
  for (const product of Object.values(offer.products ?? {})) {
    const attrs = product.attributes ?? {};
    if (attrs.regionCode !== region) continue;
    const usage = attrs.usagetype ?? '';
    if (!/DataProcessing-Bytes$/i.test(usage) || /vended/i.test(usage)) continue;
    const price = onDemandUsd(offer, product.sku);
    if (price !== null) return price;
  }
  return null;
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

function scaled(expected: number, lowFactor: number, highFactor: number): RfpCostAmounts {
  return { low: roundCents(expected * lowFactor), expected: roundCents(expected), high: roundCents(expected * highFactor) };
}

interface LineSpec {
  id: string;
  label: string;
  quantity: number;
  unit: string;
  assumptions: string[];
}

function verifiedLine(
  spec: LineSpec,
  source: Source,
  retrievedAt: string,
  unitPrice: number,
  amounts: RfpCostAmounts,
  confidence: RfpConfidence,
): RfpCostLine {
  return {
    id: spec.id,
    label: spec.label,
    category: 'operating',
    cadence: 'monthly',
    quantity: spec.quantity,
    unit: spec.unit,
    unitPrice,
    amounts,
    currency: 'USD',
    priceStatus: 'verified',
    sourceType: source.type,
    sourceUrl: source.url,
    sourceTitle: source.title,
    retrievedAt,
    confidence,
    assumptions: spec.assumptions,
    adminConfirmed: false,
  };
}

function unavailableLine(spec: LineSpec, sourceType: RfpCostSourceType, reason: string, source?: Source): RfpCostLine {
  return {
    id: spec.id,
    label: spec.label,
    category: 'operating',
    cadence: 'monthly',
    quantity: spec.quantity,
    unit: spec.unit,
    unitPrice: null,
    amounts: null,
    currency: 'USD',
    priceStatus: 'unavailable',
    sourceType,
    sourceUrl: source?.url ?? null,
    sourceTitle: source?.title ?? null,
    retrievedAt: null,
    confidence: 'low',
    assumptions: [...spec.assumptions, `Price unavailable: ${reason} Confirm the price before publishing.`],
    adminConfirmed: false,
  };
}

function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const PROPOSAL_TOOLING_VERDICTS: ReadonlySet<RfpVerdict> = new Set(['rent', 'rent-and-wrap', 'buy']);

/** Apex hosts these itself, so they are delivery context rather than licenses. */
const SELF_HOSTED_TOOLING = /mastra|apex interview/i;

export function createRfpProposalPricingService(deps: PricingDeps) {
  const ttlMs = deps.cacheTtlMs ?? 24 * 60 * 60 * 1000;
  const cache = new Map<string, { value: unknown; at: number }>();
  const inflight = new Map<string, Promise<unknown>>();

  function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = cache.get(key);
    if (hit && deps.now().getTime() - hit.at < ttlMs) return Promise.resolve(hit.value as T);
    const pending = inflight.get(key);
    if (pending) return pending as Promise<T>;
    const promise = load()
      .then((value) => {
        cache.set(key, { value, at: deps.now().getTime() });
        return value;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, promise);
    return promise;
  }

  const loadRds = (region: string) => cached(`rds:${region}`, async () =>
    parseRdsOffer(await deps.fetchJson(awsOfferUrl('AmazonRDS', region)) as AwsOffer, region));

  const loadFargate = (region: string) => cached(`fargate:${region}`, async () =>
    parseFargateOffer(await deps.fetchJson(awsOfferUrl('AmazonECS', region)) as AwsOffer, region));

  const loadSqs = (region: string) => cached(`sqs:${region}`, async () =>
    parseSqsOffer(await deps.fetchJson(awsOfferUrl('AmazonSQS', region)) as AwsOffer, region));

  const loadCloudWatch = (region: string) => cached(`cloudwatch:${region}`, async () =>
    parseCloudWatchIngestion(await deps.fetchJson(awsOfferUrl('AmazonCloudWatch', region)) as AwsOffer, region));

  const searchVendor = (product: VendorProduct) => cached(`vendor:${product.key}`, async () => {
    if (!deps.searchVendor) return [];
    const results = await deps.searchVendor(product.query, product.domains);
    return results.filter((result) => isOfficialVendorUrl(result.url, product.domains));
  });

  async function priceObservedAiBaseline(): Promise<RfpCostLine | null> {
    const baseline = await deps.loadObservedAiBaseline?.();
    if (!baseline || baseline.expectedMonthlyUsd <= 0) return null;
    const expected = roundCents(baseline.expectedMonthlyUsd);
    const featureSummary = baseline.features
      .map((row) => `${row.feature}: $${row.averageOperationUsd.toFixed(3)} average`)
      .join('; ');
    return {
      id: 'ai-usage-observed-baseline',
      label: 'Estimated monthly AI workflow usage',
      category: 'operating',
      cadence: 'monthly',
      quantity: 1,
      unit: 'workflow-month',
      unitPrice: expected,
      amounts: scaled(expected, 0.5, 2),
      currency: 'USD',
      priceStatus: 'estimate',
      sourceType: 'internal-estimate',
      sourceUrl: null,
      sourceTitle: 'Apex production AI usage baseline',
      retrievedAt: baseline.observedThrough,
      confidence: 'low',
      assumptions: [
        'Temporary proxy until this product has request-specific scope and runtime usage telemetry',
        `Based on ${baseline.pricedOperationCount} priced Apex operations through ${baseline.observedThrough.slice(0, 10)}`,
        `One average monthly operation for each workflow stage (${featureSummary})`,
        'Observed operations without a model price in the current catalog are excluded',
        'Range allows for 50% to 200% of the observed workflow baseline',
      ],
      adminConfirmed: false,
    };
  }

  async function priceEcs(sizing: RfpArchitectureSizing, retrievedAt: string): Promise<RfpCostLine[]> {
    const region = REGION_CODES[sizing.region];
    const source: Source = {
      type: 'aws-price-list',
      url: awsOfferUrl('AmazonECS', region),
      title: `AWS Price List: AWS Fargate (${region})`,
    };
    const hours = sizing.uptimePattern === 'always-on' ? ALWAYS_ON_HOURS : BUSINESS_HOURS;
    const envs = environmentsFor(sizing);
    let prices: FargatePrices | null = null;
    let failure = '';
    try {
      prices = await loadFargate(region);
    } catch (err) {
      failure = `the AWS price list could not be reached (${errorReason(err)}).`;
    }
    return envs.map(({ id, label, profile, count }) => {
      const spec = PROFILES[profile];
      const taskHours = spec.tasks * hours * count;
      const lineSpec: LineSpec = {
        id: `ecs-${id}`,
        label: `AWS Fargate compute — ${label}`,
        quantity: taskHours,
        unit: 'task-hour',
        assumptions: [
          `${spec.tasks} task(s) of ${spec.vcpu} vCPU and ${spec.memoryGb} GB per environment, ${hours} hours a month`,
          'Range allows for autoscaling between 75% and 150% of the expected load',
        ],
      };
      if (!prices?.vcpuHour || !prices.gbHour) {
        return unavailableLine(lineSpec, 'aws-price-list', failure || 'no Fargate price was found for this region.', source);
      }
      const unitPrice = spec.vcpu * prices.vcpuHour + spec.memoryGb * prices.gbHour;
      return verifiedLine(lineSpec, source, retrievedAt, Math.round(unitPrice * 1e6) / 1e6,
        scaled(unitPrice * taskHours, 0.75, 1.5), 'high');
    });
  }

  async function priceRds(sizing: RfpArchitectureSizing, retrievedAt: string): Promise<RfpCostLine[]> {
    const region = REGION_CODES[sizing.region];
    const source: Source = {
      type: 'aws-price-list',
      url: awsOfferUrl('AmazonRDS', region),
      title: `AWS Price List: Amazon RDS for PostgreSQL (${region})`,
    };
    let prices: RdsPrices | null = null;
    let failure = '';
    try {
      prices = await loadRds(region);
    } catch (err) {
      failure = `the AWS price list could not be reached (${errorReason(err)}).`;
    }
    const lines: RfpCostLine[] = [];
    for (const { id, label, profile, count } of environmentsFor(sizing)) {
      const spec = PROFILES[profile];
      const deployment = id === 'prod' ? spec.dbDeployment : 'Single-AZ';
      const instanceHours = ALWAYS_ON_HOURS * count;
      const lineSpec: LineSpec = {
        id: `rds-${id}`,
        label: `Amazon RDS for PostgreSQL — ${label}`,
        quantity: instanceHours,
        unit: 'instance-hour',
        assumptions: [`${spec.dbInstance} ${deployment}, running all month`],
      };
      const hourly = prices?.instances.get(`${spec.dbInstance}|${deployment}`);
      lines.push(hourly
        ? verifiedLine(lineSpec, source, retrievedAt, hourly, scaled(hourly * instanceHours, 1, 1), 'high')
        : unavailableLine(lineSpec, 'aws-price-list', failure || `no on-demand price was found for ${spec.dbInstance} ${deployment}.`, source));
    }

    const nonProdCount = sizing.environmentCount - 1;
    const prodDeployment = PROFILES[sizing.sizingProfile].dbDeployment;
    const storageSpec: LineSpec = {
      id: 'rds-storage',
      label: 'Amazon RDS storage (gp3)',
      quantity: sizing.storageGb + nonProdCount * NON_PROD_STORAGE_GB,
      unit: 'GB-month',
      assumptions: [
        `${sizing.storageGb} GB in production${nonProdCount > 0 ? ` and ${NON_PROD_STORAGE_GB} GB per non-production environment` : ''}`,
        'Range allows for up to 50% data growth',
      ],
    };
    const prodRate = prices?.gp3Storage.get(prodDeployment);
    const nonProdRate = prices?.gp3Storage.get('Single-AZ');
    if (prodRate && (nonProdCount === 0 || nonProdRate)) {
      const total = sizing.storageGb * prodRate + nonProdCount * NON_PROD_STORAGE_GB * (nonProdRate ?? 0);
      lines.push(verifiedLine(storageSpec, source, retrievedAt, prodRate, scaled(total, 1, 1.5), 'high'));
    } else {
      lines.push(unavailableLine(storageSpec, 'aws-price-list', failure || 'no gp3 storage price was found for this region.', source));
    }
    return lines;
  }

  async function priceSqs(sizing: RfpArchitectureSizing, retrievedAt: string): Promise<RfpCostLine[]> {
    const region = REGION_CODES[sizing.region];
    const source: Source = {
      type: 'aws-price-list',
      url: awsOfferUrl('AmazonSQS', region),
      title: `AWS Price List: Amazon SQS (${region})`,
    };
    let prices: SqsPrices | null = null;
    let failure = '';
    try {
      prices = await loadSqs(region);
    } catch (err) {
      failure = `the AWS price list could not be reached (${errorReason(err)}).`;
    }
    return environmentsFor(sizing).map(({ id, label, profile, count }) => {
      const spec = PROFILES[profile];
      const queue = id === 'prod' ? spec.sqsQueue : 'standard';
      const millions = spec.sqsMillionRequests * count;
      const lineSpec: LineSpec = {
        id: `service-bus-${id}`,
        label: `Amazon SQS ${queue === 'fifo' ? 'FIFO' : 'standard'} — ${label}`,
        quantity: millions,
        unit: 'million-request',
        assumptions: [
          queue === 'fifo'
            ? 'FIFO queues, used where the workload needs ordered messaging'
            : 'Standard queues, the AWS messaging service for this build',
          `${spec.sqsMillionRequests} million requests a month per environment`,
          'Range allows for half to double the expected request volume',
        ],
      };
      const unitPrice = queue === 'fifo' ? prices?.fifoPerMillion : prices?.standardPerMillion;
      return unitPrice
        ? verifiedLine(lineSpec, source, retrievedAt, unitPrice, scaled(unitPrice * millions, 0.5, 2), 'medium')
        : unavailableLine(lineSpec, 'aws-price-list', failure || `no ${queue} queue request price was found for this region.`, source);
    });
  }

  async function priceMonitoring(sizing: RfpArchitectureSizing, retrievedAt: string): Promise<RfpCostLine> {
    const region = REGION_CODES[sizing.region];
    const source: Source = {
      type: 'aws-price-list',
      url: awsOfferUrl('AmazonCloudWatch', region),
      title: `AWS Price List: Amazon CloudWatch Logs (${region})`,
    };
    const gb = PROFILES[sizing.sizingProfile].logGb + (sizing.environmentCount - 1) * NON_PROD_LOG_GB;
    const lineSpec: LineSpec = {
      id: 'monitoring',
      label: 'Amazon CloudWatch log ingestion',
      quantity: gb,
      unit: 'GB',
      assumptions: [
        `About ${gb} GB of logs a month across all environments`,
        'CloudWatch Logs data ingestion',
        'Range allows for 50% to 200% of the expected log volume',
      ],
    };
    try {
      const perGb = await loadCloudWatch(region);
      if (perGb === null) return unavailableLine(lineSpec, 'aws-price-list', 'no log ingestion price was found for this region.', source);
      return verifiedLine(lineSpec, source, retrievedAt, perGb, scaled(perGb * gb, 0.5, 2), 'medium');
    } catch (err) {
      return unavailableLine(lineSpec, 'aws-price-list', `the AWS price list could not be reached (${errorReason(err)}).`, source);
    }
  }

  async function priceVendor(
    product: VendorProduct,
    spec: LineSpec,
    quantity: RfpCostAmounts,
    retrievedAt: string,
  ): Promise<RfpCostLine> {
    if (!deps.searchVendor) {
      return unavailableLine(spec, 'vendor-page', `official ${product.product} pricing lookup is not configured.`);
    }
    let results: VendorSearchResult[];
    try {
      results = await searchVendor(product);
    } catch (err) {
      return unavailableLine(spec, 'vendor-page', `the ${product.product} pricing search failed (${errorReason(err)}).`);
    }
    for (const result of results) {
      const unitPrice = extractVendorPrice(result.content, product.unit);
      if (unitPrice === null) continue;
      const source: Source = {
        type: 'vendor-page',
        url: result.url,
        title: sanitizeReferenceText(result.title) || product.product,
      };
      return verifiedLine(spec, source, retrievedAt, unitPrice, {
        low: roundCents(unitPrice * quantity.low),
        expected: roundCents(unitPrice * quantity.expected),
        high: roundCents(unitPrice * quantity.high),
      }, 'medium');
    }
    return unavailableLine(spec, 'vendor-page', `no ${product.unit} price was found on an official ${product.product} page.`);
  }

  function pricePagerDuty(sizing: RfpArchitectureSizing, retrievedAt: string): Promise<RfpCostLine> {
    const responders = PROFILES[sizing.sizingProfile].responders;
    return priceVendor(PAGERDUTY, {
      id: 'pagerduty',
      label: 'PagerDuty on-call',
      quantity: responders.expected,
      unit: 'user-month',
      assumptions: [`${responders.low}–${responders.high} on-call responders (expected ${responders.expected})`],
    }, responders, retrievedAt);
  }

  function priceAiUsage(sizing: RfpArchitectureSizing, retrievedAt: string): Promise<RfpCostLine> | null {
    if (!sizing.aiUsage) return null;
    const millions = AI_TOKENS_MILLIONS[sizing.aiUsage];
    return priceVendor(BEDROCK, {
      id: 'ai-usage',
      label: 'AI model usage (Amazon Bedrock)',
      quantity: millions,
      unit: 'million tokens',
      assumptions: [
        `About ${millions} million tokens a month; range allows for half to double that usage`,
        'Priced at the input-token rate; output tokens cost more and need admin review',
      ],
    }, { low: millions * 0.5, expected: millions, high: millions * 2 }, retrievedAt);
  }

  function priceTooling(tool: string, expectedUsers: RfpExpectedUserScale | null, retrievedAt: string): Promise<RfpCostLine> {
    const users = LICENSED_USERS[expectedUsers ?? 'medium'];
    const name = sanitizeReferenceText(tool, 80);
    const product = VENDOR_PRODUCTS.find((candidate) => candidate.match.test(tool) && candidate.unit === 'user/month');
    const spec: LineSpec = {
      id: `license-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'product'}`,
      label: `${product?.product ?? name} licensing`,
      quantity: users.expected,
      unit: 'user-month',
      assumptions: [`${users.low}–${users.high} licensed users (expected ${users.expected}) based on the expected user scale`],
    };
    if (!product) {
      return Promise.resolve(unavailableLine(spec, 'vendor-page', `no official pricing source is configured for ${name}.`));
    }
    return priceVendor(product, spec, users, retrievedAt);
  }

  async function priceArchitecture(request: PricingRequest): Promise<PricingResult> {
    const retrievedAt = deps.now().toISOString();
    const { sizing, resources } = request.architecture;
    const selected = new Set<RfpCloudResource>(resources);
    const pending: Array<Promise<RfpCostLine | RfpCostLine[]>> = [];

    if (selected.has('ecs')) pending.push(priceEcs(sizing, retrievedAt));
    if (selected.has('rds')) pending.push(priceRds(sizing, retrievedAt));
    if (selected.has('service-bus')) pending.push(priceSqs(sizing, retrievedAt));
    if (selected.has('monitoring')) pending.push(priceMonitoring(sizing, retrievedAt));
    if (selected.has('pagerduty')) pending.push(pricePagerDuty(sizing, retrievedAt));
    if (request.architecture.requiresAi) {
      const observed = await priceObservedAiBaseline();
      if (observed) {
        pending.push(Promise.resolve(observed));
      } else {
        const ai = priceAiUsage(sizing, retrievedAt);
        if (ai) pending.push(ai);
      }
    }
    if (PROPOSAL_TOOLING_VERDICTS.has(request.verdict)) {
      const seen = new Set<string>();
      for (const tool of request.recommendedTooling) {
        const key = tool.trim().toLowerCase();
        if (!key || seen.has(key) || SELF_HOSTED_TOOLING.test(key)) continue;
        seen.add(key);
        pending.push(priceTooling(tool, request.expectedUsers, retrievedAt));
      }
    }

    const lines = (await Promise.all(pending)).flat();
    const unique = new Map<string, RfpCostLine>();
    for (const line of lines) if (!unique.has(line.id)) unique.set(line.id, line);
    return { lines: [...unique.values()], researchedAt: retrievedAt };
  }

  return { priceArchitecture };
}

interface EnvironmentGroup {
  id: 'prod' | 'nonprod';
  label: string;
  profile: RfpSizingProfile;
  count: number;
}

function environmentsFor(sizing: RfpArchitectureSizing): EnvironmentGroup[] {
  const groups: EnvironmentGroup[] = [{ id: 'prod', label: 'production', profile: sizing.sizingProfile, count: 1 }];
  const nonProd = sizing.environmentCount - 1;
  if (nonProd > 0) {
    groups.push({
      id: 'nonprod',
      label: `${nonProd} non-production environment${nonProd === 1 ? '' : 's'}`,
      profile: 'small',
      count: nonProd,
    });
  }
  return groups;
}

function tavilyApiKey(): string {
  const raw = process.env.TAVILY_API_KEY ?? process.env.TAVILY_AUTH ?? '';
  return raw.startsWith('Bearer ') ? raw.slice(7).trim() : raw.trim();
}

function createTavilyVendorSearch(fetchJson: JsonFetcher, apiKey: string): VendorSearch {
  return async (query, domains) => {
    const payload = await fetchJson(TAVILY_SEARCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        query,
        search_depth: 'basic',
        max_results: 5,
        include_answer: false,
        include_domains: domains,
      }),
    });
    const results = (payload as { results?: unknown[] } | null)?.results;
    if (!Array.isArray(results)) return [];
    return results.flatMap((row) => {
      const item = row as Record<string, unknown>;
      if (typeof item.url !== 'string') return [];
      return [{
        url: item.url,
        title: typeof item.title === 'string' ? item.title : '',
        content: typeof item.content === 'string' ? item.content : '',
      }];
    });
  };
}

let defaultService: ReturnType<typeof createRfpProposalPricingService> | null = null;

function getDefaultPricingService(): ReturnType<typeof createRfpProposalPricingService> {
  if (!defaultService) {
    const fetchJson = createJsonFetcher();
    const apiKey = tavilyApiKey();
    defaultService = createRfpProposalPricingService({
      fetchJson,
      searchVendor: apiKey ? createTavilyVendorSearch(createJsonFetcher({ timeoutMs: 15_000, retries: 1 }), apiKey) : null,
      now: () => new Date(),
      loadObservedAiBaseline: loadRfpProposalAiBaseline,
    });
  }
  return defaultService;
}

export function priceRfpArchitecture(request: PricingRequest): Promise<PricingResult> {
  return getDefaultPricingService().priceArchitecture(request);
}
