import { config } from './config.ts';
import {
  type Row,
  type TableMeta,
  fetchBatch,
  fetchByPks,
  failedPks,
  finishTable,
  getCheckpoint,
  lookupMappings,
  planTables,
  recordFailure,
  recordMappings,
  resetCheckpoint,
  resolveFailures,
  setCheckpoint,
} from './db.ts';
import {
  type HydraDoc,
  type HydraMemory,
  type Relation,
  addMemories,
  mapLimit,
  uploadKnowledge,
  verifyProcessing,
} from './hydra.ts';
import {
  assertColumns,
  configFor,
  contentHash,
  hydraId,
  relationLabel,
  renderMetadata,
  renderText,
  targetFor,
} from './mapping.ts';

export type MigrateOptions = {
  tables?: string[];
  dryRun?: boolean;
  restart?: boolean;
};

export type Stats = {
  read: number;
  skipped: number;
  loaded: number;
  failed: number;
};

const zero = (): Stats => ({ read: 0, skipped: 0, loaded: 0, failed: 0 });
const add = (a: Stats, b: Stats): Stats => ({
  read: a.read + b.read,
  skipped: a.skipped + b.skipped,
  loaded: a.loaded + b.loaded,
  failed: a.failed + b.failed,
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const chunk = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

type Prepared = {
  pk: string;
  hydraId: string;
  hash: string;
  doc?: HydraDoc;
  memory?: HydraMemory;
};

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`  ! ${message}`);
}

// --------------------------------------------------------------- relation build

/**
 * Resolves every FK value in the batch to a parent HydraDB id via id_map.
 * A missing parent is a hard failure (never a silent skip) so an ordering bug
 * surfaces immediately instead of producing an orphaned graph.
 */
async function resolveParents(
  meta: TableMeta,
  metas: Map<string, TableMeta>,
  rows: Row[],
  includeSelf: boolean,
): Promise<Map<string, Map<string, string>>> {
  const byParent = new Map<string, Map<string, string>>();

  for (const fk of usableFks(meta, metas, includeSelf)) {
    const pks = rows
      .map((row) => row[fk.column])
      .filter((value) => value !== null && value !== undefined)
      .map(String);
    const existing = byParent.get(fk.parentTable);
    const found = await lookupMappings(fk.parentTable, pks);
    const merged = existing ?? new Map<string, string>();
    for (const [pk, entry] of found) merged.set(pk, entry.hydraId);
    byParent.set(fk.parentTable, merged);
  }
  return byParent;
}

function usableFks(meta: TableMeta, metas: Map<string, TableMeta>, includeSelf: boolean) {
  return meta.fks.filter((fk) => {
    if (fk.parentTable === meta.table && !includeSelf) return false;
    const parent = metas.get(fk.parentTable);
    if (!parent) {
      warnOnce(`${meta.table}.${fk.column}`, `${meta.table}.${fk.column} -> unknown table, edge skipped`);
      return false;
    }
    if (targetFor(fk.parentTable) === 'skip') return false;
    if (fk.parentColumn !== parent.pk) {
      warnOnce(
        `${meta.table}.${fk.column}`,
        `${meta.table}.${fk.column} references ${fk.parentTable}.${fk.parentColumn} (not its primary key) — edge skipped`,
      );
      return false;
    }
    return true;
  });
}

function buildRelations(
  meta: TableMeta,
  metas: Map<string, TableMeta>,
  row: Row,
  parents: Map<string, Map<string, string>>,
  includeSelf: boolean,
): Relation | Relation[] | undefined {
  const byLabel = new Map<string, string[]>();

  for (const fk of usableFks(meta, metas, includeSelf)) {
    const value = row[fk.column];
    if (value === null || value === undefined) continue;
    const parentId = parents.get(fk.parentTable)?.get(String(value));
    if (!parentId) {
      throw new Error(
        `parent ${fk.parentTable}.${fk.parentColumn}=${String(value)} not found in id_map ` +
          `(referenced by ${meta.table}.${fk.column}) — migrate the parent table first`,
      );
    }
    const label = relationLabel(meta.table, fk.column, fk.parentTable);
    byLabel.set(label, [...(byLabel.get(label) ?? []), parentId]);
  }

  const relations: Relation[] = [...byLabel].map(([label, ids]) => ({
    cortex_source_ids: [...new Set(ids)],
    properties: { relation: label },
  }));
  if (!relations.length) return undefined;
  return relations.length === 1 ? relations[0] : relations;
}

// ------------------------------------------------------------------ batch cycle

/** Pure transform of a row batch into HydraDB payloads. Failures are per-row. */
async function prepare(
  meta: TableMeta,
  metas: Map<string, TableMeta>,
  rows: Row[],
  includeSelf: boolean,
  stats: Stats,
): Promise<Prepared[]> {
  const parents = await resolveParents(meta, metas, rows, includeSelf);
  const target = targetFor(meta.table);
  const tableConfig = configFor(meta.table);
  const prepared: Prepared[] = [];

  const known = await lookupMappings(
    meta.table,
    rows.map((row) => String(row[meta.pk])),
  );

  for (const row of rows) {
    const pk = String(row[meta.pk]);
    try {
      assertColumns(meta, row);
      const text = renderText(meta, row);
      const metadata = renderMetadata(meta, row);
      const relations = buildRelations(meta, metas, row, parents, includeSelf);
      const hash = contentHash(text, metadata, relations);
      const id = hydraId(meta.table, pk);

      if (known.get(pk)?.hash === hash) {
        stats.skipped++;
        continue;
      }

      if (target === 'memory') {
        const userColumn = tableConfig.userIdColumn;
        const userId = userColumn ? row[userColumn] : undefined;
        if (userColumn && (userId === null || userId === undefined)) {
          throw new Error(`memory row has no ${userColumn}`);
        }
        prepared.push({
          pk,
          hydraId: id,
          hash,
          memory: {
            id,
            content: text,
            ...(userId === undefined ? {} : { user_id: String(userId) }),
            metadata,
            ...(relations ? { relations } : {}),
          },
        });
      } else {
        prepared.push({
          pk,
          hydraId: id,
          hash,
          doc: { id, content: text, document_metadata: metadata, ...(relations ? { relations } : {}) },
        });
      }
    } catch (err) {
      stats.failed++;
      await recordFailure(meta.table, pk, 'transform', err instanceof Error ? err.message : String(err), row);
    }
  }
  return prepared;
}

/** Uploads in bounded-concurrency chunks; a bad chunk dead-letters, never aborts. */
async function load(meta: TableMeta, prepared: Prepared[], stats: Stats): Promise<Prepared[]> {
  const chunks = chunk(prepared, config.uploadChunk);

  const results = await mapLimit(chunks, config.concurrency, async (items) => {
    try {
      const jobId = items[0]?.memory
        ? await addMemories(items.map((item) => item.memory as HydraMemory))
        : await uploadKnowledge(items.map((item) => item.doc as HydraDoc));
      return { items, jobId, ok: true as const };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      for (const item of items) {
        await recordFailure(meta.table, item.pk, 'load', message);
      }
      stats.failed += items.length;
      return { items, jobId: null, ok: false as const };
    }
  });

  const succeeded: Prepared[] = [];
  for (const result of results) {
    if (!result.ok) continue;
    if (config.verify && result.jobId) {
      try {
        const done = await verifyProcessing(result.jobId);
        if (!done) throw new Error(`verification timed out for job ${result.jobId}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        for (const item of result.items) await recordFailure(meta.table, item.pk, 'verify', message);
        stats.failed += result.items.length;
        continue;
      }
    }
    succeeded.push(...result.items);
  }

  stats.loaded += succeeded.length;
  return succeeded;
}

async function commit(meta: TableMeta, succeeded: Prepared[]): Promise<void> {
  // id_map first, checkpoint second — a crash between the two can only ever
  // repeat work, never lose a mapping.
  await recordMappings(
    succeeded.map((item) => ({
      table: meta.table,
      pk: item.pk,
      hydraId: item.hydraId,
      hash: item.hash,
    })),
  );
}

// ---------------------------------------------------------------------- passes

async function migrateTable(
  meta: TableMeta,
  metas: Map<string, TableMeta>,
  options: MigrateOptions,
): Promise<Stats> {
  const stats = zero();
  if (targetFor(meta.table) === 'skip') {
    console.log(`- ${meta.table}: skipped by mapping`);
    return stats;
  }
  if (!meta.pk) {
    console.log(`- ${meta.table}: no primary key, cannot paginate — skipped`);
    return stats;
  }

  if (options.restart) await resetCheckpoint(meta.table);
  let lastPk = await getCheckpoint(meta.table);
  console.log(`> ${meta.table} (${targetFor(meta.table)})${lastPk ? ` resuming after pk ${lastPk}` : ''}`);

  for (;;) {
    const rows = await fetchBatch(meta, lastPk, config.batchSize);
    if (!rows.length) break;
    stats.read += rows.length;

    const prepared = await prepare(meta, metas, rows, false, stats);
    if (!options.dryRun && prepared.length) {
      const succeeded = await load(meta, prepared, stats);
      await commit(meta, succeeded);
    } else {
      stats.loaded += prepared.length;
    }

    lastPk = String(rows[rows.length - 1]?.[meta.pk]);
    if (!options.dryRun) await setCheckpoint(meta.table, lastPk, rows.length);
    console.log(
      `  ${meta.table}: read ${stats.read} loaded ${stats.loaded} skipped ${stats.skipped} failed ${stats.failed}`,
    );
    if (config.batchDelayMs) await sleep(config.batchDelayMs);
  }

  if (!options.dryRun) await finishTable(meta.table);
  return stats;
}

/**
 * Second pass for self-referencing FKs (employees.manager_id -> employees.id).
 * Every row now exists in id_map, so the self edges resolve and the upsert
 * simply replaces the document with its related version.
 */
async function patchSelfReferences(
  meta: TableMeta,
  metas: Map<string, TableMeta>,
  options: MigrateOptions,
): Promise<Stats> {
  const stats = zero();
  const selfFks = meta.fks.filter((fk) => fk.parentTable === meta.table);
  if (!selfFks.length || targetFor(meta.table) === 'skip' || !meta.pk) return stats;

  console.log(`> ${meta.table}: self-reference pass (${selfFks.map((f) => f.column).join(', ')})`);
  let lastPk: string | null = null;

  for (;;) {
    const rows = await fetchBatch(meta, lastPk, config.batchSize);
    if (!rows.length) break;
    lastPk = String(rows[rows.length - 1]?.[meta.pk]);

    const linked = rows.filter((row) =>
      selfFks.some((fk) => row[fk.column] !== null && row[fk.column] !== undefined),
    );
    if (!linked.length) continue;
    stats.read += linked.length;

    const prepared = await prepare(meta, metas, linked, true, stats);
    if (!options.dryRun && prepared.length) {
      const succeeded = await load(meta, prepared, stats);
      await commit(meta, succeeded);
    } else {
      stats.loaded += prepared.length;
    }
  }
  return stats;
}

// ------------------------------------------------------------------ entrypoints

export async function migrate(options: MigrateOptions = {}): Promise<Stats> {
  const { metas, order } = await planTables(options.tables);
  console.log(`Plan (${order.length} tables): ${order.join(' -> ')}\n`);

  let total = zero();
  for (const table of order) {
    const meta = metas.get(table);
    if (!meta) continue;
    total = add(total, await migrateTable(meta, metas, options));
  }
  for (const table of order) {
    const meta = metas.get(table);
    if (!meta) continue;
    total = add(total, await patchSelfReferences(meta, metas, options));
  }

  console.log(
    `\nDone — read ${total.read}, loaded ${total.loaded}, skipped ${total.skipped}, failed ${total.failed}`,
  );
  return total;
}

/** Retries dead-lettered rows once the underlying cause is fixed. */
export async function redrive(tables: string[] = []): Promise<Stats> {
  const { metas, order } = await planTables(tables);
  let total = zero();

  for (const table of order) {
    const meta = metas.get(table);
    if (!meta) continue;
    const pks = await failedPks(table);
    if (!pks.length) continue;

    console.log(`> ${table}: re-driving ${pks.length} failed rows`);
    const stats = zero();
    for (const group of chunk(pks, config.batchSize)) {
      const rows = await fetchByPks(meta, group);
      stats.read += rows.length;
      const prepared = await prepare(meta, metas, rows, true, stats);
      const succeeded = await load(meta, prepared, stats);
      await commit(meta, succeeded);
      await resolveFailures(
        table,
        succeeded.map((item) => item.pk),
      );
    }
    console.log(`  ${table}: loaded ${stats.loaded} failed ${stats.failed}`);
    total = add(total, stats);
  }
  return total;
}
