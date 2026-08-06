import { config } from '../config.ts';
import { log } from '../util/log.ts';
import { pool, sleep, withRetry } from '../util/async.ts';
import type { Hydra } from './client.ts';
import type { HydraSource } from '../types.ts';

function wire(source: HydraSource): Record<string, unknown> {
  return {
    id: source.id,
    database: config.hydraDatabase,
    ...(config.hydraCollection ? { collection: config.hydraCollection } : {}),
    title: source.title,
    type: source.type,
    timestamp: source.timestamp,
    content: source.content,
    tenant_metadata: source.tenant_metadata,
    additional_metadata: source.additional_metadata,
    relations: source.relations,
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    out.push(items.slice(index, index + size));
  return out;
}

export async function ingestSources(
  client: Hydra,
  sources: HydraSource[],
  label: string,
): Promise<string[]> {
  if (sources.length === 0) return [];
  const chunks = chunk(sources, config.uploadChunk);
  const accepted: string[] = [];
  let done = 0;

  await pool(chunks, config.concurrency, async (group) => {
    const response = await withRetry(
      `ingest ${label}`,
      config.maxRetries,
      async () => {
        if (config.requestDelayMs > 0) await sleep(config.requestDelayMs);
        return client.context.ingest({
          type: 'knowledge',
          database: config.hydraDatabase,
          ...(config.hydraCollection
            ? { collection: config.hydraCollection }
            : {}),
          upsert: 'true',
          appKnowledge: JSON.stringify(group.map(wire)),
        });
      },
    );

    const results = response.data?.results ?? [];
    let edges = 0;
    for (const result of results) {
      if (result.error)
        log.warn(`ingest error for ${result.id ?? 'unknown'}: ${result.error}`);
      else if (result.id) accepted.push(result.id);
      if (result.relationsError)
        log.warn(
          `relation error for ${result.id ?? 'unknown'}: ${result.relationsError}`,
        );
      edges += result.relationsCreated ?? 0;
    }
    if (results.length === 0)
      for (const source of group) accepted.push(source.id);

    done += group.length;
    log.info(
      `${label}: uploaded ${done}/${sources.length}, graph edges ${edges}`,
    );
    if (config.batchDelayMs > 0) await sleep(config.batchDelayMs);
  });

  return accepted;
}
