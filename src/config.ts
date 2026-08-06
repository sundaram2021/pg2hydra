import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function loadEnvFile(): void {
  try {
    const raw = readFileSync(resolve(process.cwd(), '.env'), 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch {
    return;
  }
}

loadEnvFile();

function str(key: string, fallback = ''): string {
  return process.env[key]?.trim() || fallback;
}

function num(key: string, fallback: number): number {
  const parsed = Number(process.env[key]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function bool(key: string, fallback: boolean): boolean {
  const value = process.env[key]?.trim().toLowerCase();
  if (value === undefined || value === '') return fallback;
  return value === 'true' || value === '1' || value === 'yes';
}

function list(key: string): string[] {
  return str(key)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export const config = {
  databaseUrl: str(
    'DATABASE_URL',
    'postgresql://postgres:postgres@localhost:5432/appdb',
  ),
  pgSchema: str('PG_SCHEMA', 'public'),
  tables: list('TABLES'),
  skipTables: list('SKIP_TABLES'),
  hydraBaseUrl: str('HYDRA_BASE_URL', 'https://api.hydradb.com'),
  hydraApiKey: str('HYDRA_DB_API_KEY'),
  hydraDatabase: str('HYDRA_DATABASE', 'pg2hydra_demo'),
  hydraCollection: str('HYDRA_COLLECTION'),
  batchSize: num('BATCH_SIZE', 1000),
  docTargetBytes: num('DOC_TARGET_BYTES', 24000),
  memoryTables: list('MEMORY_TABLES'),
  episodeTables: list('EPISODE_TABLES'),
  migrateMemories: bool('MIGRATE_MEMORIES', true),
  declareMetadataSchema: bool('DECLARE_METADATA_SCHEMA', false),
  uploadChunk: num('UPLOAD_CHUNK', 20),
  concurrency: num('CONCURRENCY', 2),
  requestDelayMs: num('REQUEST_DELAY_MS', 0),
  batchDelayMs: num('BATCH_DELAY_MS', 0),
  maxRetries: num('MAX_RETRIES', 6),
  requestTimeoutMs: num('REQUEST_TIMEOUT_SECONDS', 60) * 1000,
  bootstrapTimeoutMs: num('BOOTSTRAP_TIMEOUT_MS', 300000),
  verify: bool('VERIFY', true),
  waitForGraph:
    bool('WAIT_FOR_GRAPH', false) || process.argv.includes('--wait-graph'),
  verifyTimeoutMs: num('VERIFY_TIMEOUT_MS', 300000),
  dryRun: process.argv.includes('--dry-run'),
};

export type Config = typeof config;
