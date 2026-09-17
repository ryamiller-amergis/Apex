import { Pool } from 'pg';

if (!process.env.DATABASE_URL) {
  console.warn('[db] DATABASE_URL is not set — database queries will fail.');
}

const databaseUrl = process.env.DATABASE_URL ?? '';

// Enable SSL when running in production OR when the connection string explicitly
// requests it (e.g. pointing a local dev machine at the Azure cloud DB).
const useSSL =
  process.env.NODE_ENV === 'production' || databaseUrl.includes('sslmode=require');

// Cap the per-instance pool so multiple App Service instances (across both the
// production and staging slots) plus background workers and the interactive
// actor cannot collectively exhaust the shared Postgres max_connections budget.
// Override with DB_POOL_MAX when a specific environment needs a different cap.
const poolMax = Number.parseInt(process.env.DB_POOL_MAX ?? '', 10);

const pool = new Pool({
  connectionString: databaseUrl,
  ssl: useSSL ? { rejectUnauthorized: true } : undefined,
  max: Number.isFinite(poolMax) && poolMax > 0 ? poolMax : 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

export interface DbPoolStats {
  max: number;
  total: number;
  idle: number;
  active: number;
  waiting: number;
  saturation: number;
}

type DbPoolStatsSource = Pick<
  Pool,
  'totalCount' | 'idleCount' | 'waitingCount' | 'options'
>;

function safeCount(value: number | undefined): number {
  return Number.isFinite(value) ? Math.max(0, value ?? 0) : 0;
}

function safeMax(value: number | undefined): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? value ?? 0 : 0;
}

export function getDbPoolStats(
  source: DbPoolStatsSource = pool,
): DbPoolStats {
  const max = safeMax(source.options?.max);
  const total = safeCount(source.totalCount);
  const idle = safeCount(source.idleCount);
  const waiting = safeCount(source.waitingCount);
  const active = Math.max(0, total - idle);

  return {
    max,
    total,
    idle,
    active,
    waiting,
    saturation: max > 0 ? active / max : 0,
  };
}

pool.on('error', (err) => {
  console.error('[db] Unexpected error on idle client', err);
});

export default pool;
