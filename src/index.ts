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
import type { HydraDocument, HydraMemory, TablePlan } from './types.ts';

async function loadPlans(): Promise<TablePlan[]> {
  const tables = await buildTableObjects(await introspect());
  for (const table of tables) table.row_count = await countRows(table);
  const plans = planTables(tables);
  log.done(
    `introspected ${plans.length} relations in schema ${config.pgSchema}`,
  );
  for (const plan of plans)
    log.info(
      `${plan.table.qualified_name} [${plan.table.kind}] rows=${plan.table.row_count} -> ${plan.layer}` +
        `${plan.time_column ? ` on ${plan.time_column}` : ''}`,
    );
  return plans;
}

async function buildForTable(
  plan: TablePlan,
): Promise<{ documents: HydraDocument[]; memories: HydraMemory[] }> {
  const documents: HydraDocument[] = [];
  const memories: HydraMemory[] = [];
  let index = 0;
  let offset = 0;

  for await (const batch of readBatches(plan.table, plan.time_column)) {
    const records = batch.rows.map((row) => renderFor(plan, row));
    if (plan.layer === 'memory' && config.migrateMemories) {
      for (const record of records) memories.push(memoryItem(plan, record));
      continue;
    }
    const packed = packDocuments(plan, records, index, offset);
    documents.push(...packed);
    index += packed.length;
    offset += records.length;
  }

  return { documents, memories };
}

async function dryRun(plans: TablePlan[]): Promise<void> {
  mkdirSync('out', { recursive: true });
  for (const plan of plans) {
    const ontology = ontologyDocument(plan);
    writeFileSync(`out/${ontology.filename}`, ontology.text);
    const { documents, memories } = await buildForTable(plan);
    if (documents[0])
      writeFileSync(`out/${documents[0].filename}`, documents[0].text);
    if (memories[0])
      writeFileSync(
        `out/${plan.table.qualified_name} (memory sample).md`,
        memories[0].text,
      );
    log.info(
      `${plan.table.qualified_name}: ${documents.length} documents, ${memories.length} memories`,
    );
  }
  log.done('dry run complete, inspect ./out');
}

async function migrate(client: Hydra, plans: TablePlan[]): Promise<void> {
  log.step('migrating table ontology');
  const ontology = await uploadDocuments(
    client,
    plans.map(ontologyDocument),
    'ontology',
  );
  await waitIndexed(client, ontology.ids);

  log.step('migrating rows as knowledge and episodes');
  const documentIds: string[] = [];
  let edges = ontology.edges;
  const allMemories: HydraMemory[] = [];

  for (const plan of plans) {
    const { documents, memories } = await buildForTable(plan);
    allMemories.push(...memories);
    if (documents.length === 0) continue;
    const result = await uploadDocuments(client, documents, plan.table.table);
    documentIds.push(...result.ids);
    edges += result.edges;
    log.done(
      `${plan.table.qualified_name}: ${documents.length} ${plan.layer} documents from ${plan.table.row_count} rows`,
    );
  }
  await waitIndexed(client, documentIds);

  if (allMemories.length > 0) {
    log.step('migrating entity rows as memories');
    const memoryIds = await uploadMemories(client, allMemories, 'memories');
    log.done(
      `stored ${memoryIds.length} memories across ${memoryIds.length} collections`,
    );
  }

  log.done(
    `migration complete: ${ontology.ids.length} ontology, ${documentIds.length} record documents, ${allMemories.length} memories, ${edges} graph edges`,
  );
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
  await migrate(client, plans);

  if (config.verify) {
    log.step('verifying retrieval and graph');
    await verify(client, plans);
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
