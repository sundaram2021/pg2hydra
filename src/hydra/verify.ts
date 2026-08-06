import { config } from '../config.ts';
import { log } from '../util/log.ts';
import { withRetry } from '../util/async.ts';
import type { Hydra } from './client.ts';
import type { TableObject } from '../types.ts';

export async function verify(
  client: Hydra,
  tables: TableObject[],
): Promise<void> {
  const anchor =
    tables.find((table) => table.relations.many_to_one.length > 0) ?? tables[0];
  if (!anchor) return;

  const question = `What is ${anchor.qualified_name} and how does it relate to ${anchor.related_tables.join(', ') || 'other tables'}?`;

  const response = await withRetry('query', config.maxRetries, () =>
    client.query({
      database: config.hydraDatabase,
      ...(config.hydraCollection ? { collection: config.hydraCollection } : {}),
      query: question,
      type: 'knowledge',
      queryBy: 'hybrid',
      mode: 'thinking',
      graphContext: true,
      maxResults: 5,
    }),
  );

  const chunks = response.data?.chunks ?? [];
  log.done(`query returned ${chunks.length} chunks for: ${question}`);
  for (const item of chunks.slice(0, 3)) {
    log.info(
      `- [${item.sourceTitle ?? item.id ?? 'chunk'}] ${(item.chunkContent ?? '').replace(/\s+/g, ' ').slice(0, 150)}`,
    );
  }

  const relations = await withRetry('relations', config.maxRetries, () =>
    client.context.relations({
      database: config.hydraDatabase,
      id: anchor.id,
      limit: 25,
    }),
  );
  const payload = relations.data as unknown as
    { relations?: unknown[]; edges?: unknown[] } | undefined;
  const edges = payload?.relations ?? payload?.edges ?? [];
  log.done(
    `graph relations recorded for ${anchor.qualified_name}: ${Array.isArray(edges) ? edges.length : 0}`,
  );

  const stats = await withRetry('stats', config.maxRetries, () =>
    client.databases.stats({ database: config.hydraDatabase }),
  );
  log.info(`database stats: ${JSON.stringify(stats.data ?? {})}`);
}
