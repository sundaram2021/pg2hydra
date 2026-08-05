import { config } from './config.ts';
import {
  type Row,
  type TableMeta,
  failedPks,
  fetchBatch,
  fetchByPks,
  fetchChanged,
  findDeleted,
  finishTable,
  forgetMappings,
  getCheckpoint,
  getWatermark,
  lookupMappings,
  planTables,
  recordFailure,
  recordMappings,
  resetCheckpoint,
  resolveFailures,
  setCheckpoint,
  setWatermark,
} from './db.ts';
import {
  type KnowledgeSource,
  type MemoryRecord,
  type Relations,
  deleteSources,
  ingestKnowledge,
  ingestMemories,
  mapLimit,
  waitForIndexing,
} from './hydra.ts';
import {
  assertColumns,
  configFor,
  contentHash,
  hydraId,
  relationLabel,
  renderMetadata,
  renderText,
  renderTitle,
  targetFor,
  watermarkColumn,
} from './mapping.ts';

export type RunOptions = {
  tables?: string[];
  dryRun?: boolean;
  restart?: boolean;
};

export type Stats = {
  read: number;
  skipped: number;
  loaded: number;
  deleted: number;
  failed: number;
};

const zero = (): Stats => ({ read: 0, skipped: 0, loaded: 0, deleted: 0, failed: 0 });
const add = (a: Stats, b: Stats): Stats => ({
  read: a.read + b.read,
  skipped: a.skipped + b.skipped,
  loaded: a.loaded + b.loaded,
  deleted: a.deleted + b.deleted,
  failed: a.failed + b.failed,
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const chunk = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};
const summary = (s: Stats) =>
  `read ${s.read} loaded ${s.loaded} skipped ${s.skipped} deleted ${s.deleted} failed ${s.failed}`;

type Prepared = {
  pk: string;
  hydraId: string;
  hash: string;
  source?: KnowledgeSource;
  memory?: MemoryRecord;
};

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`  ! ${message}`);
}

// --------------------------------------------------------------- relation build

function usableFks(meta: TableMeta, metas: Map<string, TableMeta>, includeSelf: boolean) {
  const ignored = new Set(configFor(meta.table).ignoreFks ?? []);
  return meta.fks.filter((fk) => {
    if (ignored.has(fk.column)) return false;
    if (fk.parentTable === meta.table && !includeSelf) return false;
    const parent = metas.get(fk.parentTable);
    if (!parent) return false;
    if (targetFor(fk.parentTable) === 'skip') return false;
    // Forceful relations live within one store, so knowledge->memory edges are dropped.
    if (targetFor(meta.table) !== targetFor(fk.parentTable)) {
      warnOnce(
        `${meta.table}.${fk.column}`,
        `${meta.table}.${fk.column} crosses the knowledge/memory boundary — edge skipped`,
      );
      return false;
    }
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

/** Resolves FK values to parent HydraDB ids via id_map, one query per parent table. */
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
    const merged = byParent.get(fk.parentTable) ?? new Map<string, string>();
    for (const [pk, entry] of await lookupMappings(fk.parentTable, pks)) {
      merged.set(pk, entry.hydraId);
    }
    byParent.set(fk.parentTable, merged);
  }
  return byParent;
}

/**
 * ForcefulRelationsPayload: every parent id in `hydradb_source_ids`, with the
 * FK-derived labels carried in `properties` so the edge keeps its meaning.
 */
function buildRelations(
  meta: TableMeta,
  metas: Map<string, TableMeta>,
  row: Row,
  parents: Map<string, Map<string, string>>,
  includeSelf: boolean,
): Relations | undefined {
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
  if (!byLabel.size) return undefined;

  const ids = [...new Set([...byLabel.values()].flat())];
  const labels = [...byLabel.keys()];
  return {
    hydradb_source_ids: ids,
    properties:
      labels.length === 1
        ? { relation: labels[0] }
        : { relations: Object.fromEntries([...byLabel].map(([l, v]) => [l, [...new Set(v)]])) },
  };
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
  const known = await lookupMappings(
    meta.table,
    rows.map((row) => String(row[meta.pk])),
  );
  const prepared: Prepared[] = [];

  for (const row of rows) {
    const pk = String(row[meta.pk]);
    try {
      assertColumns(meta, row);
      const text = renderText(meta, row);
      const title = renderTitle(meta, row);
      const { metadata, additional } = renderMetadata(meta, row);
      const relations = buildRelations(meta, metas, row, parents, includeSelf);
      const hash = contentHash(text, { title, metadata, additional }, relations);
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
            title,
            text,
            infer: false, // rows are already facts; never let the API re-interpret them
            // memory metadata fields are JSON strings, not objects
            metadata: JSON.stringify(metadata),
            additional_metadata: JSON.stringify(
              userId === undefined ? additional : { ...additional, user_id: String(userId) },
            ),
            ...(relations ? { relations } : {}),
          },
        });
      } else {
        prepared.push({
          pk,
          hydraId: id,
          hash,
          source: {
            id,
            title,
            type: meta.table,
            kind: 'record',
            provider: 'postgres',
            external_id: pk,
            content: { text },
            metadata,
            additional_metadata: additional,
            ...(relations ? { relations } : {}),
          },
        });
      }
    } catch (err) {
      stats.failed++;
      await recordFailure(
        meta.table,
        pk,
        'transform',
        err instanceof Error ? err.message : String(err),
        row,
      );
    }
  }
  return prepared;
}

/** Ingests in bounded-concurrency chunks; a bad chunk dead-letters, never aborts. */
async function load(meta: TableMeta, prepared: Prepared[], stats: Stats): Promise<Prepared[]> {
  const chunks = chunk(prepared, config.uploadChunk);

  const results = await mapLimit(chunks, config.concurrency, async (items) => {
    try {
      if (items[0]?.memory) {
        await ingestMemories(items.map((item) => item.memory as MemoryRecord));
      } else {
        await ingestKnowledge(items.map((item) => item.source as KnowledgeSource));
      }
      return { items, ok: true as const };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      for (const item of items) await recordFailure(meta.table, item.pk, 'load', message);
      stats.failed += items.length;
      return { items, ok: false as const };
    }
  });

  let accepted = results.filter((r) => r.ok).flatMap((r) => r.items);

  if (config.verify && accepted.length) {
    // Ingestion is async: poll the source ids to a terminal indexing state.
    const byId = new Map(accepted.map((item) => [item.hydraId, item]));
    const { indexed, failed } = await waitForIndexing([...byId.keys()]);
    for (const [id, reason] of failed) {
      const item = byId.get(id);
      if (item) await recordFailure(meta.table, item.pk, 'verify', reason);
    }
    stats.failed += failed.size;
    accepted = indexed.map((id) => byId.get(id)).filter((item): item is Prepared => !!item);
  }

  stats.loaded += accepted.length;
  return accepted;
}

/** id_map is written before the checkpoint advances — a crash can only repeat work. */
async function commit(meta: TableMeta, accepted: Prepared[]): Promise<void> {
  await recordMappings(
    accepted.map((item) => ({
      table: meta.table,
      pk: item.pk,
      hydraId: item.hydraId,
      hash: item.hash,
    })),
  );
}

async function processRows(
  meta: TableMeta,
  metas: Map<string, TableMeta>,
  rows: Row[],
  includeSelf: boolean,
  dryRun: boolean,
  stats: Stats,
): Promise<void> {
  const prepared = await prepare(meta, metas, rows, includeSelf, stats);
  if (!prepared.length) return;
  if (dryRun) {
    stats.loaded += prepared.length;
    return;
  }
  await commit(meta, await load(meta, prepared, stats));
}

// ---------------------------------------------------------------------- backfill

async function migrateTable(
  meta: TableMeta,
  metas: Map<string, TableMeta>,
  options: RunOptions,
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
  console.log(
    `> ${meta.table} (${targetFor(meta.table)})${lastPk ? ` resuming after pk ${lastPk}` : ''}`,
  );

  for (;;) {
    const rows = await fetchBatch(meta, lastPk, config.batchSize);
    if (!rows.length) break;
    stats.read += rows.length;

    await processRows(meta, metas, rows, false, !!options.dryRun, stats);

    lastPk = String(rows[rows.length - 1]?.[meta.pk]);
    if (!options.dryRun) await setCheckpoint(meta.table, lastPk, rows.length);
    console.log(`  ${meta.table}: ${summary(stats)}`);
    if (config.batchDelayMs) await sleep(config.batchDelayMs);
  }

  if (!options.dryRun) await finishTable(meta.table);
  return stats;
}

/**
 * Second pass for self-referencing FKs (employees.manager_id -> employees.id).
 * Every row now exists in id_map, so the self edges resolve and the upsert
 * replaces the document with its related version.
 */
async function patchSelfReferences(
  meta: TableMeta,
  metas: Map<string, TableMeta>,
  options: RunOptions,
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
    await processRows(meta, metas, linked, true, !!options.dryRun, stats);
  }
  return stats;
}

export async function migrate(options: RunOptions = {}): Promise<Stats> {
  const { metas, order } = await planTables(options.tables);
  console.log(`Plan (${order.length} tables): ${order.join(' -> ')}\n`);

  let total = zero();
  for (const table of order) {
    const meta = metas.get(table);
    if (meta) total = add(total, await migrateTable(meta, metas, options));
  }
  for (const table of order) {
    const meta = metas.get(table);
    if (meta) total = add(total, await patchSelfReferences(meta, metas, options));
  }

  console.log(`\nDone — ${summary(total)}`);
  return total;
}

// -------------------------------------------------------------- incremental sync

/**
 * One incremental pass over a table: rows whose watermark column moved since
 * the last run are re-rendered and upserted. Tables without a timestamp column
 * fall back to a full keyset re-scan, where content hashing keeps the cost to
 * "read the rows" — unchanged rows never reach the network.
 */
async function syncTable(
  meta: TableMeta,
  metas: Map<string, TableMeta>,
  options: RunOptions,
): Promise<Stats> {
  const stats = zero();
  if (targetFor(meta.table) === 'skip' || !meta.pk) return stats;

  const column = watermarkColumn(meta);
  const previous = await getWatermark(meta.table);
  // Overlap window: rows committed slightly out of clock order still get picked up.
  const since =
    previous && column ? new Date(previous.getTime() - config.syncOverlapSeconds * 1000) : null;
  let highest: Date | null = previous;
  let lastPk: string | null = null;

  for (;;) {
    const rows = column
      ? await fetchChanged(meta, column, since, lastPk, config.batchSize)
      : await fetchBatch(meta, lastPk, config.batchSize);
    if (!rows.length) break;
    stats.read += rows.length;
    lastPk = String(rows[rows.length - 1]?.[meta.pk]);

    if (column) {
      for (const row of rows) {
        const value = row[column];
        const seen = value instanceof Date ? value : value ? new Date(String(value)) : null;
        if (seen && !Number.isNaN(seen.getTime()) && (!highest || seen > highest)) highest = seen;
      }
    }

    await processRows(meta, metas, rows, true, !!options.dryRun, stats);
    if (config.batchDelayMs) await sleep(config.batchDelayMs);
  }

  if (!options.dryRun) await setWatermark(meta.table, column, highest);
  if (stats.read || stats.loaded) {
    console.log(`  ${meta.table}${column ? ` (${column})` : ' (full re-scan)'}: ${summary(stats)}`);
  }
  return stats;
}

/** Rows that disappeared from the source are deleted from HydraDB and from id_map. */
async function syncDeletes(meta: TableMeta, options: RunOptions): Promise<Stats> {
  const stats = zero();
  if (targetFor(meta.table) === 'skip' || !meta.pk) return stats;
  const type = targetFor(meta.table) === 'memory' ? 'memory' : 'knowledge';

  for (;;) {
    const gone = await findDeleted(meta, config.batchSize);
    if (!gone.length) break;
    if (options.dryRun) {
      stats.deleted += gone.length;
      break;
    }
    for (const group of chunk(gone, config.uploadChunk)) {
      try {
        await deleteSources(
          group.map((entry) => entry.hydraId),
          type,
        );
        await forgetMappings(
          meta.table,
          group.map((entry) => entry.pk),
        );
        stats.deleted += group.length;
      } catch (err) {
        stats.failed += group.length;
        await recordFailure(
          meta.table,
          null,
          'load',
          `delete failed: ${err instanceof Error ? err.message : String(err)}`,
          group.map((entry) => entry.hydraId),
        );
      }
    }
    if (gone.length < config.batchSize) break;
  }
  if (stats.deleted) console.log(`  ${meta.table}: deleted ${stats.deleted}`);
  return stats;
}

/** One full incremental pass across every in-scope table. */
export async function sync(options: RunOptions = {}): Promise<Stats> {
  const { metas, order } = await planTables(options.tables);
  let total = zero();

  for (const table of order) {
    const meta = metas.get(table);
    if (meta) total = add(total, await syncTable(meta, metas, options));
  }
  if (config.syncDeletes) {
    for (const table of [...order].reverse()) {
      // children before parents, so an edge is never left pointing at a deleted node
      const meta = metas.get(table);
      if (meta) total = add(total, await syncDeletes(meta, options));
    }
  }
  return total;
}

/** `sync --watch`: run forever at SYNC_INTERVAL_SECONDS, surviving transient errors. */
export async function watch(options: RunOptions = {}): Promise<never> {
  console.log(
    `Watching every ${config.syncIntervalSeconds}s (deletes ${config.syncDeletes ? 'on' : 'off'}). Ctrl+C to stop.`,
  );
  for (;;) {
    const startedAt = Date.now();
    try {
      const stats = await sync(options);
      if (stats.read || stats.deleted) {
        console.log(`[${new Date().toISOString()}] ${summary(stats)}`);
      }
    } catch (err) {
      console.error(`[${new Date().toISOString()}] sync pass failed: ${
        err instanceof Error ? err.message : String(err)
      }`);
    }
    const elapsed = Date.now() - startedAt;
    await sleep(Math.max(0, config.syncIntervalSeconds * 1000 - elapsed));
  }
}

// ------------------------------------------------------------------------ redrive

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
      const accepted = await load(meta, prepared, stats);
      await commit(meta, accepted);
      await resolveFailures(
        table,
        accepted.map((item) => item.pk),
      );
    }
    console.log(`  ${table}: ${summary(stats)}`);
    total = add(total, stats);
  }
  return total;
}
