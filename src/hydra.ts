import { HydraDB, HydraDBClient } from '@hydradb/sdk';
import { config } from './config.ts';

export type Relations = {
  hydradb_source_ids: string[];
  properties?: Record<string, unknown>;
};

export type KnowledgeSource = {
  id: string;
  title?: string;
  type?: string;
  content: { text: string };
  kind?: string;
  provider?: string;
  external_id?: string;
  fields?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  additional_metadata?: Record<string, unknown>;
  relations?: Relations;
  timestamp?: string;
};

export type MemoryRecord = {
  id: string;
  title?: string;
  text: string;
  infer: boolean;
  metadata?: string;
  additional_metadata?: string;
  relations?: Relations;
};

export type MetadataField = HydraDB.TenantsCustomPropertyDefinition;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let client: HydraDBClient | undefined;

export function hydra(): HydraDBClient {
  if (!client) {
    client = new HydraDBClient({
      token: config.hydra.apiKey,
      baseUrl: config.hydra.baseUrl,
      maxRetries: config.maxRetries,
      timeoutInSeconds: config.requestTimeoutSeconds,
    });
  }
  return client;
}

async function pace(): Promise<void> {
  if (config.requestDelayMs) await sleep(config.requestDelayMs);
}

function scope(): { database: string; collection?: string } {
  return {
    database: config.hydra.database,
    ...(config.hydra.collection ? { collection: config.hydra.collection } : {}),
  };
}

export async function createDatabase(schema: MetadataField[]): Promise<void> {
  try {
    await hydra().databases.create({
      database: config.hydra.database,
      ...(schema.length ? { databaseMetadataSchema: schema } : {}),
    });
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode !== 409) throw err;
  }
}

export async function waitForDatabaseReady(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let wait = 2000;
  while (Date.now() < deadline) {
    const res = await hydra().databases.status({ database: config.hydra.database });
    if (res.data?.infra?.readyForIngestion) return true;
    await sleep(wait);
    wait = Math.min(10_000, Math.round(wait * 1.5));
  }
  return false;
}

export async function ingestKnowledge(sources: KnowledgeSource[]): Promise<string[]> {
  await pace();
  await hydra().context.ingest({
    ...scope(),
    type: 'knowledge',
    upsert: 'true',
    appKnowledge: JSON.stringify(
      sources.map((source) => ({
        ...source,
        database: config.hydra.database,
        collection: config.hydra.collection,
      })),
    ),
  });
  return sources.map((source) => source.id);
}

export async function ingestMemories(memories: MemoryRecord[]): Promise<string[]> {
  await pace();
  await hydra().context.ingest({
    ...scope(),
    type: 'memory',
    upsert: 'true',
    memories: JSON.stringify(memories.map((memory) => ({ ...memory, source_id: memory.id }))),
  });
  return memories.map((memory) => memory.id);
}

export type IndexingState = 'pending' | 'indexed' | 'failed' | 'unknown';

function classify(status: string): IndexingState {
  switch (status.toLowerCase()) {
    case 'completed':
    case 'complete':
    case 'success':
    case 'succeeded':
    case 'graph_creation':
      return 'indexed';
    case 'failed':
    case 'errored':
    case 'error':
      return 'failed';
    case 'queued':
    case 'processing':
      return 'pending';
    default:
      return 'unknown';
  }
}

export async function fetchStatus(
  ids: string[],
): Promise<Map<string, { state: IndexingState; error: string }>> {
  const out = new Map<string, { state: IndexingState; error: string }>();
  if (!ids.length) return out;

  const res = await hydra().context.status({ ...scope(), ids });
  for (const row of res.data?.statuses ?? []) {
    if (!row.id) continue;
    out.set(row.id, {
      state: classify(row.indexingStatus ?? ''),
      error: [row.errorCode, row.errorMessage].filter(Boolean).join(': '),
    });
  }
  return out;
}

export async function waitForIndexing(
  ids: string[],
): Promise<{ indexed: string[]; failed: Map<string, string> }> {
  const pending = new Set(ids);
  const indexed: string[] = [];
  const failed = new Map<string, string>();
  const deadline = Date.now() + config.verifyTimeoutMs;
  let wait = 1500;

  while (pending.size && Date.now() < deadline) {
    for (const [id, { state, error }] of await fetchStatus([...pending])) {
      if (state === 'indexed') {
        indexed.push(id);
        pending.delete(id);
      } else if (state === 'failed') {
        failed.set(id, error || 'indexing failed');
        pending.delete(id);
      }
    }
    if (!pending.size) break;
    await sleep(wait);
    wait = Math.min(10_000, Math.round(wait * 1.5));
  }

  for (const id of pending) failed.set(id, 'indexing did not reach a terminal state before timeout');
  return { indexed, failed };
}

export async function deleteSources(
  ids: string[],
  type: 'knowledge' | 'memory' = 'knowledge',
): Promise<number> {
  if (!ids.length) return 0;
  try {
    const res = await hydra().context.delete(
      { ...scope(), ids, type },
      { headers: { 'X-HydraDB-Delete-Status': 'strict' } },
    );
    return res.data?.deletedCount ?? ids.length;
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) return 0;
    throw err;
  }
}

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}
