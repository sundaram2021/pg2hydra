import { mkdirSync, writeFileSync } from 'node:fs';
import { config } from './config.ts';
import { log } from './util/log.ts';
import { closePg } from './pg/client.ts';
import { introspect } from './pg/introspect.ts';
import { buildTableObjects } from './pg/relations.ts';
import { countRows, readBatches } from './pg/rows.ts';
import { planTables } from './classify.ts';
import { renderFor } from './transform/records.ts';
import { packDocuments } from './transform/pack.ts';
import { memoryItem, ontologyDocument } from './transform/source.ts';
import { createClient, ensureDatabase, waitIndexed } from './hydra/client.ts';
import { uploadDocuments } from './hydra/upload.ts';
import { uploadMemories } from './hydra/memories.ts';
import { verify } from './hydra/verify.ts';
import type { Hydra } from './hydra/client.ts';
import type { TablePlan } from './types.ts';

type Totals = { documents: string[]; memories: string[]; edges: number };

async function loadPlans(): Promise<TablePlan[]> {
  const tables = await buildTableObjects(await introspect());
  for (const table of tables) table.row_count = await countRows(table);
  const plans = planTables(tables);
  log.done(`introspected ${plans.length} relations in ${config.pgSchema}`);
  for (const plan of plans)
    log.info(
      `${plan.table.qualified_name} [${plan.table.kind}] rows=${plan.table.row_count} -> ${plan.layer}` +
        `${plan.time_column ? ` by ${plan.time_column}` : ''}`,
    );
  return plans;
}

async function migrateTable(
  client: Hydra,
  plan: TablePlan,
  totals: Totals,
): Promise<void> {
  const label = plan.table.table;
  let index = 0;
  let offset = 0;
  let documents = 0;
  let memories = 0;

  for await (const rows of readBatches(plan.table, plan.time_column)) {
    const records = rows.map((row) => renderFor(plan, row));

    if (plan.layer === 'memory' && config.migrateMemories) {
      const items = records.map((record) => memoryItem(plan, record));
      totals.memories.push(...(await uploadMemories(client, items, label)));
      memories += items.length;
      continue;
    }

    const packed = packDocuments(plan, records, index, offset);
    const result = await uploadDocuments(client, packed, label);
    totals.documents.push(...result.ids);
    totals.edges += result.edges;
    index += packed.length;
    offset += records.length;
    documents += packed.length;
  }

  log.done(
    `${plan.table.qualified_name}: ${plan.table.row_count} rows -> ` +
      (memories > 0
        ? `${memories} memories`
        : `${documents} ${plan.layer} documents`),
  );
}

async function dryRun(plans: TablePlan[]): Promise<void> {
  mkdirSync('out', { recursive: true });
  for (const plan of plans) {
    const ontology = ontologyDocument(plan);
    writeFileSync(`out/${ontology.filename}`, ontology.text);

    for await (const rows of readBatches(plan.table, plan.time_column)) {
      const records = rows.map((row) => renderFor(plan, row));
      if (plan.layer === 'memory' && config.migrateMemories) {
        writeFileSync(
          `out/${plan.table.qualified_name} (memory sample).md`,
          memoryItem(plan, records[0]!).text,
        );
      } else {
        const packed = packDocuments(plan, records, 0, 0);
        if (packed[0])
          writeFileSync(`out/${packed[0].filename}`, packed[0].text);
      }
      break;
    }
    log.info(`${plan.table.qualified_name} -> ${plan.layer}`);
  }
  log.done('dry run complete, inspect ./out');
}

async function main(): Promise<void> {
  const plans = await loadPlans();
  if (plans.length === 0)
    throw new Error(`no tables found in schema ${config.pgSchema}`);

  if (config.dryRun) {
    await dryRun(plans);
    return;
  }

  const client = createClient();
  await ensureDatabase(client);
  const totals: Totals = { documents: [], memories: [], edges: 0 };

  log.step('migrating table definitions');
  const ontology = await uploadDocuments(
    client,
    plans.map(ontologyDocument),
    'definitions',
  );
  totals.edges += ontology.edges;
  await waitIndexed(client, ontology.ids);

  log.step('migrating rows');
  for (const plan of plans) await migrateTable(client, plan, totals);
  await waitIndexed(client, totals.documents);

  log.done(
    `migration complete: ${ontology.ids.length} definitions, ${totals.documents.length} record documents, ${totals.memories.length} memories, ${totals.edges} graph edges`,
  );

  if (config.verify) {
    log.step('verifying');
    await verify(client, plans);
  }
}

main()
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    log.error(message);
    if (process.env['PG2HYDRA_DEBUG'] && error instanceof Error && error.stack)
      console.error(error.stack);
    process.exitCode = 1;
  })
  .finally(() => closePg());
