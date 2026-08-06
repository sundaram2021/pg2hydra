import { config } from '../config.ts';
import { log } from '../util/log.ts';
import { withRetry } from '../util/async.ts';
import type { Hydra } from './client.ts';
import type { TablePlan } from '../types.ts';

function looksDirty(text: string): boolean {
  return (
    text.includes('html_base64') ||
    text.includes('"tenant_id"') ||
    text.includes('\\"')
  );
}

async function ask(client: Hydra, question: string, collection?: string) {
  return withRetry('query', config.maxRetries, () =>
    client.query({
      database: config.hydraDatabase,
      ...(collection
        ? { collection }
        : config.hydraCollection
          ? { collection: config.hydraCollection }
          : {}),
      query: question,
      type: collection ? 'all' : 'knowledge',
      queryBy: 'hybrid',
      mode: 'thinking',
      graphContext: true,
      maxResults: 5,
    }),
  );
}

export async function verify(client: Hydra, plans: TablePlan[]): Promise<void> {
  const anchor =
    plans.find((plan) => plan.table.relations.many_to_one.length > 0) ??
    plans[0];
  if (!anchor) return;

  const question = `How does ${anchor.table.qualified_name} relate to ${anchor.table.related_tables.join(' and ') || 'other tables'}?`;
  const response = await ask(client, question);
  const chunks = response.data?.chunks ?? [];
  log.done(`query returned ${chunks.length} chunks for: ${question}`);

  let dirty = 0;
  for (const chunk of chunks) {
    const text = chunk.chunkContent ?? '';
    if (looksDirty(text)) dirty += 1;
  }
  for (const chunk of chunks.slice(0, 3))
    log.info(
      `- [${chunk.sourceTitle ?? chunk.id}] ${(chunk.chunkContent ?? '').replace(/\s+/g, ' ').slice(0, 140)}`,
    );

  if (dirty > 0)
    log.warn(
      `${dirty}/${chunks.length} chunks contain envelope or escaped JSON`,
    );
  else log.done(`all ${chunks.length} chunks are clean prose`);

  const memoryPlan = plans.find((plan) => plan.layer === 'memory');
  if (memoryPlan && config.migrateMemories) {
    const collection = `${memoryPlan.table.table}:1`;
    const memoryResponse = await ask(
      client,
      `What do we know about ${memoryPlan.entity} 1?`,
      collection,
    );
    const memoryChunks = memoryResponse.data?.chunks ?? [];
    log.done(
      `memory query on collection ${collection} returned ${memoryChunks.length} chunks`,
    );
    if (memoryChunks[0])
      log.info(
        `- ${(memoryChunks[0].chunkContent ?? '').replace(/\s+/g, ' ').slice(0, 140)}`,
      );
  }

  const stats = await withRetry('stats', config.maxRetries, () =>
    client.databases.stats({ database: config.hydraDatabase }),
  );
  log.info(`database stats: ${JSON.stringify(stats.data ?? {})}`);
}
