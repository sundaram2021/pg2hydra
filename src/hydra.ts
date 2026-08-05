import { config } from './config.ts';

/**
 * HydraDB v2 client (https://api.hydradb.com, API-Version: 2).
 *
 * Verified against the published OpenAPI spec:
 *  - POST   /context/ingest   multipart/form-data ONLY (a JSON body returns 415).
 *                             `database` required; `app_knowledge` / `memories` /
 *                             `document_metadata` / `graph_payload` are JSON *strings*.
 *  - GET    /context/status   poll by source id, not by job id.
 *  - DELETE /context          JSON body { database, collection, ids, type }.
 * Every response is enveloped: { success, data, error, meta }.
 */

/** ForcefulRelationsPayload — author-declared edges between sources. */
export type Relations = {
  hydradb_source_ids: string[];
  properties?: Record<string, unknown>;
};

/** One item of the `app_knowledge` array: a structured, non-file source. */
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
  // v2 canonical scope, echoed per item; v1 aliases are added on the wire.
  database?: string;
  collection?: string;
};

/** One item of the `memories` array. */
export type MemoryRecord = {
  id: string;
  title?: string;
  text: string;
  infer: boolean;
  /** JSON-stringified objects — the memory model takes strings, not objects. */
  metadata?: string;
  additional_metadata?: string;
  relations?: Relations;
};

export class HydraError extends Error {
  status: number;
  retryable: boolean;
  requestId: string | undefined;
  constructor(status: number, message: string, requestId?: string) {
    super(`HydraDB ${status}: ${message}${requestId ? ` (request_id ${requestId})` : ''}`);
    this.status = status;
    // 400 validation / 413 too large / 415 wrong content type / 422 bad shape are permanent.
    this.retryable = status === 408 || status === 429 || status >= 500 || status === 0;
    this.requestId = requestId;
  }
}

type Envelope<T> = {
  success?: boolean;
  data?: T;
  error?: unknown;
  meta?: { request_id?: string };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${config.hydra.apiKey}`,
    'api-version': '2',
    ...extra,
  };
}

/** Single retrying HTTP call. `body` is either FormData (multipart) or a JSON value. */
async function call<T>(
  path: string,
  init: { method: string; form?: FormData; json?: unknown; extraHeaders?: Record<string, string> },
): Promise<T> {
  const url = `${config.hydra.baseUrl}${path}`;
  let last: HydraError | null = null;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    if (attempt > 0) {
      const backoff = Math.min(30_000, 500 * 2 ** (attempt - 1));
      await sleep(backoff / 2 + Math.random() * backoff); // jitter
    } else if (config.requestDelayMs) {
      await sleep(config.requestDelayMs); // documented guidance: pace bulk ingestion
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method: init.method,
        headers: init.form
          ? headers(init.extraHeaders)
          : headers({ 'content-type': 'application/json', ...init.extraHeaders }),
        body: init.form ?? (init.json === undefined ? undefined : JSON.stringify(init.json)),
      });
    } catch (err) {
      last = new HydraError(0, err instanceof Error ? err.message : String(err));
      continue;
    }

    const text = await res.text();
    let parsed: Envelope<T> | undefined;
    try {
      parsed = text ? (JSON.parse(text) as Envelope<T>) : undefined;
    } catch {
      parsed = undefined;
    }

    if (res.ok) {
      if (parsed && parsed.success === false) {
        throw new HydraError(res.status, JSON.stringify(parsed.error), parsed.meta?.request_id);
      }
      return (parsed?.data ?? parsed ?? {}) as T;
    }

    last = new HydraError(
      res.status,
      parsed ? JSON.stringify(parsed.error ?? parsed) : text.slice(0, 500),
      parsed?.meta?.request_id,
    );
    if (!last.retryable) throw last;

    const retryAfter = Number(res.headers.get('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) await sleep(retryAfter * 1000);
  }

  throw last ?? new HydraError(0, 'request failed');
}

function scopeFields(form: FormData): void {
  form.set('database', config.hydra.database);
  if (config.hydra.collection) form.set('collection', config.hydra.collection);
  form.set('upsert', 'true'); // deterministic ids + upsert = idempotent re-runs
}

/** POST /context/ingest with type=knowledge. Returns the ids HydraDB accepted. */
export async function ingestKnowledge(sources: KnowledgeSource[]): Promise<string[]> {
  const form = new FormData();
  scopeFields(form);
  form.set('type', 'knowledge');
  form.set(
    'app_knowledge',
    JSON.stringify(
      sources.map((source) => ({
        ...source,
        database: config.hydra.database,
        collection: config.hydra.collection,
        // v1 aliases, harmlessly ignored by v2, required by v1 per-item.
        tenant_id: config.hydra.database,
        sub_tenant_id: config.hydra.collection || config.hydra.database,
      })),
    ),
  );
  await call<unknown>('/context/ingest', { method: 'POST', form });
  return sources.map((source) => source.id);
}

/** POST /context/ingest with type=memory. */
export async function ingestMemories(memories: MemoryRecord[]): Promise<string[]> {
  const form = new FormData();
  scopeFields(form);
  form.set('type', 'memory');
  form.set(
    'memories',
    JSON.stringify(memories.map((memory) => ({ ...memory, source_id: memory.id }))),
  );
  await call<unknown>('/context/ingest', { method: 'POST', form });
  return memories.map((memory) => memory.id);
}

export type IndexingState = 'pending' | 'indexed' | 'failed' | 'unknown';

type StatusResponse = {
  statuses?: {
    id?: string;
    file_id?: string;
    indexing_status?: string;
    error_code?: string;
    error_message?: string;
  }[];
};

/**
 * `graph_creation` already means "indexed and retrievable" — the graph is still
 * being built but the source is searchable, so we accept it as done.
 */
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

/** GET /context/status — one call covers a whole batch of ids. */
export async function fetchStatus(
  ids: string[],
): Promise<Map<string, { state: IndexingState; error: string }>> {
  const out = new Map<string, { state: IndexingState; error: string }>();
  if (!ids.length) return out;

  const query = new URLSearchParams({ database: config.hydra.database, ids: ids.join(',') });
  if (config.hydra.collection) query.set('collection', config.hydra.collection);

  const data = await call<StatusResponse>(`/context/status?${query}`, { method: 'GET' });
  for (const row of data.statuses ?? []) {
    const id = row.id ?? row.file_id;
    if (!id) continue;
    out.set(id, {
      state: classify(row.indexing_status ?? ''),
      error: [row.error_code, row.error_message].filter(Boolean).join(': '),
    });
  }
  return out;
}

/**
 * Polls a batch to a terminal state. Returns the ids that indexed cleanly and
 * the ones that failed (with reasons); anything still pending at the deadline
 * is reported as failed so it lands in the dead-letter table rather than being
 * silently assumed good.
 */
export async function waitForIndexing(
  ids: string[],
): Promise<{ indexed: string[]; failed: Map<string, string> }> {
  const pending = new Set(ids);
  const indexed: string[] = [];
  const failed = new Map<string, string>();
  const deadline = Date.now() + config.verifyTimeoutMs;
  let wait = 1500;

  while (pending.size && Date.now() < deadline) {
    const statuses = await fetchStatus([...pending]);
    for (const [id, { state, error }] of statuses) {
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

/**
 * DELETE /context. `strict` opts into honest status codes — without it the API
 * returns 200 even when nothing was deleted. 404 means already gone: not an error.
 */
export async function deleteSources(
  ids: string[],
  type: 'knowledge' | 'memory' = 'knowledge',
): Promise<number> {
  if (!ids.length) return 0;
  try {
    const data = await call<{ deleted_count?: number }>('/context', {
      method: 'DELETE',
      json: {
        database: config.hydra.database,
        ...(config.hydra.collection ? { collection: config.hydra.collection } : {}),
        ids,
        type,
      },
      extraHeaders: { 'x-hydradb-delete-status': 'strict' },
    });
    return data.deleted_count ?? ids.length;
  } catch (err) {
    if (err instanceof HydraError && err.status === 404) return 0; // nothing matched
    throw err;
  }
}

/** Bounded-concurrency map — keeps in-flight requests under CONCURRENCY. */
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
