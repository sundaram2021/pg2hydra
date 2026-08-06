import { readFileSync } from 'node:fs';

function loadEnvFile(path = '.env'): void {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadEnvFile(process.env.ENV_FILE ?? '.env');

function num(key: string, fallback: number): number {
  const parsed = Number(process.env[key]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function list(key: string): string[] {
  return (process.env[key] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? '',
  schema: process.env.PG_SCHEMA ?? 'public',

  hydra: {
    baseUrl: (process.env.HYDRA_BASE_URL ?? 'https://api.hydradb.com').replace(/\/$/, ''),
    apiKey: process.env.HYDRA_DB_API_KEY ?? process.env.HYDRA_API_KEY ?? '',
    database: process.env.HYDRA_DATABASE ?? '',
    collection: process.env.HYDRA_COLLECTION ?? '',
  },

  batchSize: num('BATCH_SIZE', 1000),

  uploadChunk: Math.min(num('UPLOAD_CHUNK', 20), 20),
  concurrency: num('CONCURRENCY', 2),
  batchDelayMs: Number(process.env.BATCH_DELAY_MS ?? 0) || 0,

  requestDelayMs: Number(process.env.REQUEST_DELAY_MS ?? 1000) || 0,
  maxRetries: num('MAX_RETRIES', 6),
  requestTimeoutSeconds: num('REQUEST_TIMEOUT_SECONDS', 60),
  bootstrapTimeoutMs: num('BOOTSTRAP_TIMEOUT_MS', 300_000),
  bootstrapPollMs: num('BOOTSTRAP_POLL_MS', 5_000),
  skipPreflight: (process.env.HYDRA_SKIP_PREFLIGHT ?? 'false') === 'true',
  verify: (process.env.VERIFY ?? 'true') !== 'false',
  verifyTimeoutMs: num('VERIFY_TIMEOUT_MS', 300_000),

  syncIntervalSeconds: num('SYNC_INTERVAL_SECONDS', 60),

  syncOverlapSeconds: num('SYNC_OVERLAP_SECONDS', 5),
  syncDeletes: (process.env.SYNC_DELETES ?? 'true') !== 'false',

  tables: list('TABLES'),
  skipTables: list('SKIP_TABLES'),
} as const;

export function assertConfig(needsHydra = true): void {
  if (!config.databaseUrl) throw new Error('DATABASE_URL is not set (see .env.example)');
  if (!needsHydra) return;
  if (!config.hydra.apiKey) throw new Error('HYDRA_DB_API_KEY is not set (see .env.example)');
  if (!config.hydra.database) {
    throw new Error('HYDRA_DATABASE is not set — it is required on every HydraDB v2 call');
  }
}
