import { config } from './config.ts';

export type Relation = {
  cortex_source_ids: string[];
  properties: Record<string, unknown>;
};

export type HydraDoc = {
  id: string;
  content: string;
  document_metadata: Record<string, unknown>;
  relations?: Relation | Relation[];
};

export type HydraMemory = {
  id: string;
  content: string;
  user_id?: string;
  metadata: Record<string, unknown>;
  relations?: Relation | Relation[];
};

export class HydraError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(`HydraDB ${status}: ${message}`);
    this.status = status;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const retryable = (status: number) => status === 408 || status === 429 || status >= 500;

async function request<T>(path: string, method: 'GET' | 'POST', body?: unknown): Promise<T> {
  const url = `${config.hydra.baseUrl}${path}`;
  let lastError = '';

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    if (attempt > 0) {
      // exponential backoff with jitter, capped at 30s
      const backoff = Math.min(30_000, 500 * 2 ** (attempt - 1));
      await sleep(backoff / 2 + Math.random() * backoff);
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(config.hydra.apiKey ? { authorization: `Bearer ${config.hydra.apiKey}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      continue; // network blip — retry
    }

    const text = await res.text();
    if (res.ok) return (text ? JSON.parse(text) : {}) as T;

    lastError = text.slice(0, 500);
    if (!retryable(res.status)) throw new HydraError(res.status, lastError);

    const retryAfter = Number(res.headers.get('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) await sleep(retryAfter * 1000);
  }

  throw new HydraError(0, `exhausted ${config.maxRetries} retries — ${lastError}`);
}

type UploadResponse = {
  job_id?: string;
  jobId?: string;
  id?: string;
  status?: string;
};

/** Upserts documents into the knowledge graph. Returns a job id when one is issued. */
export async function uploadKnowledge(docs: HydraDoc[]): Promise<string | null> {
  const res = await request<UploadResponse>(config.hydra.knowledgePath, 'POST', {
    documents: docs,
    upsert: true,
  });
  return res.job_id ?? res.jobId ?? res.id ?? null;
}

/** Upserts user-scoped facts into the memory graph. */
export async function addMemories(memories: HydraMemory[]): Promise<string | null> {
  const res = await request<UploadResponse>(config.hydra.memoryPath, 'POST', {
    memories,
    upsert: true,
  });
  return res.job_id ?? res.jobId ?? res.id ?? null;
}

type VerifyResponse = { status?: string; state?: string; errors?: unknown };

/**
 * Polls ingestion status until terminal. Resolves true on completion, throws on
 * a reported error, and gives up (false) once VERIFY_TIMEOUT_MS elapses.
 */
export async function verifyProcessing(jobId: string): Promise<boolean> {
  const deadline = Date.now() + config.verifyTimeoutMs;
  let wait = 1000;

  while (Date.now() < deadline) {
    const res = await request<VerifyResponse>(
      `${config.hydra.verifyPath}?job_id=${encodeURIComponent(jobId)}`,
      'GET',
    );
    const status = (res.status ?? res.state ?? '').toLowerCase();
    if (status === 'completed' || status === 'complete' || status === 'succeeded') return true;
    if (status === 'errored' || status === 'error' || status === 'failed') {
      throw new HydraError(0, `job ${jobId} ${status}: ${JSON.stringify(res.errors ?? {})}`);
    }
    await sleep(wait);
    wait = Math.min(8000, wait * 1.5);
  }
  return false;
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
