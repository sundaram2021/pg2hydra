import { log } from './log.ts';

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(error: unknown): boolean {
  const status =
    (error as { status?: number; statusCode?: number })?.status ??
    (error as { statusCode?: number })?.statusCode;
  if (typeof status === 'number')
    return status === 408 || status === 409 || status === 429 || status >= 500;
  return true;
}

export async function withRetry<T>(
  label: string,
  attempts: number,
  fn: () => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === attempts) break;
      const backoff =
        Math.min(30000, 500 * 2 ** (attempt - 1)) +
        Math.floor(Math.random() * 250);
      log.warn(
        `${label} failed (attempt ${attempt}/${attempts}), retrying in ${backoff}ms`,
      );
      await sleep(backoff);
    }
  }
  throw lastError;
}

export async function pool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        results[index] = await worker(items[index]!, index);
      }
    },
  );
  await Promise.all(runners);
  return results;
}

export async function waitFor(
  label: string,
  timeoutMs: number,
  intervalMs: number,
  check: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
