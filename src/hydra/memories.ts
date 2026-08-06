import { config } from '../config.ts';
import { log } from '../util/log.ts';
import { pool, sleep, withRetry } from '../util/async.ts';
import type { Hydra } from './client.ts';
import type { HydraMemory } from '../types.ts';

type MemoryResult = { id?: string; error?: string | null };

async function send(
  client: Hydra,
  memory: HydraMemory,
): Promise<MemoryResult[]> {
  const form = new FormData();
  form.append('type', 'memory');
  form.append('database', config.hydraDatabase);
  form.append('collection', memory.collection);
  form.append('upsert', 'true');
  if (config.declareMetadataSchema)
    form.append('metadata', JSON.stringify(memory.metadata));
  form.append(
    'additional_metadata',
    JSON.stringify(
      config.declareMetadataSchema
        ? memory.additional_metadata
        : { ...memory.metadata, ...memory.additional_metadata },
    ),
  );
  form.append(
    'memories',
    JSON.stringify([{ id: memory.id, text: memory.text, infer: false }]),
  );

  const response = await client.fetch('/context/ingest', {
    method: 'POST',
    body: form,
  });
  const payload = (await response.json()) as {
    success?: boolean;
    data?: { results?: MemoryResult[] };
    error?: { message?: string };
  };
  if (!response.ok || payload.success === false) {
    const error = new Error(
      payload.error?.message ?? `memory ingest failed with ${response.status}`,
    );
    Object.assign(error, { statusCode: response.status });
    throw error;
  }
  return payload.data?.results ?? [];
}

export async function uploadMemories(
  client: Hydra,
  memories: HydraMemory[],
  label: string,
): Promise<string[]> {
  if (memories.length === 0) return [];
  const ids: string[] = [];
  let done = 0;

  await pool(memories, config.concurrency, async (memory) => {
    const results = await withRetry(
      `memory ${label}`,
      config.maxRetries,
      async () => {
        if (config.requestDelayMs > 0) await sleep(config.requestDelayMs);
        return send(client, memory);
      },
    );

    for (const result of results) {
      if (result.error)
        log.warn(`memory error for ${result.id ?? memory.id}: ${result.error}`);
      else ids.push(result.id ?? memory.id);
    }

    done += 1;
    if (done % 10 === 0 || done === memories.length)
      log.info(`${label}: ${done}/${memories.length} memories`);
  });

  return ids;
}
