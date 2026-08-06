import { mkdirSync, writeFileSync } from 'node:fs';
import { config } from './config.ts';
import { log } from './util/log.ts';
import { closePg } from './pg/client.ts';
import { introspect } from './pg/introspect.ts';
import { buildTableObjects } from './pg/relations.ts';
import { countRows, readBatches } from './pg/rows.ts';
import { batchSource, schemaSource } from './transform/source.ts';
import { toObject } from './transform/object.ts';
import { renderBatch } from './transform/record.ts';
import { createClient, ensureDatabase, waitIndexed } from './hydra/client.ts';
import { ingestSources } from './hydra/ingest.ts';
import { verify } from './hydra/verify.ts';
import type { Hydra } from './hydra/client.ts';
import type { HydraSource, TableObject } from './types.ts';

async function loadTables(): Promise<TableObject[]> {
  const shapes = await introspect();
  const tables = await buildTableObjects(shapes);
  for (const table of tables) table.row_count = await countRows(table);
  log.done(
    `introspected ${tables.length} relations in schema ${config.pgSchema}`,
  );
  for (const table of tables) {
    const relations = table.relations;
    log.info(
      `${table.qualified_name} [${table.kind}] rows=${table.row_count} pk=(${table.primary_key.join(', ') || 'none'})` +
        `${table.composite_key ? ' composite' : ''} m2o=${relations.many_to_one.length} o2m=${relations.one_to_many.length} m2m=${relations.many_to_many.length}`,
    );
  }
  return tables;
}

async function dryRun(tables: TableObject[]): Promise<void> {
  mkdirSync('out', { recursive: true });
  for (const table of tables) {
    writeFileSync(
      `out/${table.table}.object.json`,
      JSON.stringify(toObject(table), null, 2),
    );
    for await (const batch of readBatches(table)) {
      writeFileSync(
        `out/${table.table}.rows.sample.md`,
        renderBatch({ ...batch, rows: batch.rows.slice(0, 3) }),
      );
      break;
    }
  }
  log.done(
    `dry run complete, wrote ${tables.length} table objects and row samples to ./out`,
  );
}

async function migrateRows(
  client: Hydra,
  tables: TableObject[],
): Promise<string[]> {
  const flushSize = Math.max(1, config.uploadChunk * config.concurrency);
  const ingested: string[] = [];

  for (const table of tables) {
    let buffer: HydraSource[] = [];
    let batches = 0;

    const flush = async (): Promise<void> => {
      if (buffer.length === 0) return;
      const ids = await ingestSources(client, buffer, `${table.table} rows`);
      ingested.push(...ids);
      buffer = [];
    };

    for await (const batch of readBatches(table)) {
      buffer.push(batchSource(batch));
      batches += 1;
      if (buffer.length >= flushSize) await flush();
    }
    await flush();
    log.done(
      `${table.qualified_name}: migrated ${table.row_count} rows in ${batches} batches`,
    );
  }

  return ingested;
}

async function main(): Promise<void> {
  const tables = await loadTables();
  if (tables.length === 0)
    throw new Error(`no tables found in schema ${config.pgSchema}`);

  if (config.dryRun) {
    await dryRun(tables);
    return;
  }

  const client = createClient();
  await ensureDatabase(client);

  log.step('migrating table objects (schema + relationship graph)');
  const schemaIds = await ingestSources(
    client,
    tables.map(schemaSource),
    'table objects',
  );
  await waitIndexed(client, schemaIds);

  log.step('migrating rows in batches');
  const rowIds = await migrateRows(client, tables);
  await waitIndexed(client, rowIds);

  log.done(
    `migration complete: ${schemaIds.length} table objects, ${rowIds.length} row batches`,
  );

  if (config.verify) {
    log.step('verifying retrieval and graph');
    await verify(client, tables);
  }
}

main()
  .catch((error: unknown) => {
    log.error(
      error instanceof Error
        ? `${error.message}\n${error.stack ?? ''}`
        : String(error),
    );
    process.exitCode = 1;
  })
  .finally(() => closePg());
