import { readFileSync } from 'node:fs';

// Minimal .env loader — no dependency needed for KEY=value files.
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
    baseUrl: (process.env.HYDRA_BASE_URL ?? '').replace(/\/$/, ''),
    apiKey: process.env.HYDRA_API_KEY ?? '',
    knowledgePath: process.env.HYDRA_KNOWLEDGE_PATH ?? '/upload/knowledge',
    memoryPath: process.env.HYDRA_MEMORY_PATH ?? '/memories/add_memory',
    verifyPath: process.env.HYDRA_VERIFY_PATH ?? '/ingestion/verify_processing',
  },

  batchSize: num('BATCH_SIZE', 1000),
  uploadChunk: num('UPLOAD_CHUNK', 100),
  concurrency: num('CONCURRENCY', 4),
  batchDelayMs: Number(process.env.BATCH_DELAY_MS ?? 0) || 0,
  maxRetries: num('MAX_RETRIES', 6),
  verify: (process.env.VERIFY ?? 'true') !== 'false',
  verifyTimeoutMs: num('VERIFY_TIMEOUT_MS', 120_000),

  tables: list('TABLES'),
  skipTables: list('SKIP_TABLES'),
} as const;

export function assertConfig(needsHydra = true): void {
  if (!config.databaseUrl) throw new Error('DATABASE_URL is not set (see .env.example)');
  if (needsHydra && !config.hydra.baseUrl) {
    throw new Error('HYDRA_BASE_URL is not set (see .env.example)');
  }
}
