import pg from 'pg';
import { readFileSync } from 'node:fs';
import { config } from './config.ts';

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 4,
  application_name: 'pg2hydra',
});

export function explainConnectionError(err: unknown): string | null {
  const code = (err as { code?: string } | null)?.code;
  const host = (() => {
    try {
      return new URL(config.databaseUrl).hostname;
    } catch {
      return '';
    }
  })();

  if (code === 'ECONNREFUSED') {
    return [
      `Nothing is listening on ${host || 'the Postgres host'}.`,
      'Start the local database first:  docker compose up -d',
      'Check it is healthy with:        docker compose ps',
    ].join('\n');
  }

  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH') {
    return `No route to ${host || 'the Postgres host'}. If this is a managed database on an IPv6-only hostname, use its IPv4 or pooler endpoint instead.`;
  }

  if (code === 'ENOTFOUND') {
    return `Postgres host${host ? ` "${host}"` : ''} does not resolve. Check DATABASE_URL for typos.`;
  }

  if (code === 'ETIMEDOUT') {
    return `Timed out connecting to ${host || 'Postgres'}. Check the port and any firewall between you and the database.`;
  }

  if (code === '3D000') {
    return 'That database does not exist. With docker compose the database is "appdb".';
  }

  if (code === '28P01') {
    return 'Postgres rejected the credentials in DATABASE_URL.';
  }

  return null;
}

export type Row = Record<string, unknown>;

export type ForeignKey = {
  column: string;
  parentTable: string;
  parentColumn: string;
};

export type TableMeta = {
  table: string;
  pk: string;
  columns: string[];
  fks: ForeignKey[];
};

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
const qualified = (table: string) => `${ident(config.schema)}.${ident(table)}`;

async function q<T extends Row>(sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query<T>(sql, params);
  return res.rows;
}

export async function introspect(): Promise<Map<string, TableMeta>> {
  const schema = config.schema;

  const columns = await q<{ table_name: string; column_name: string }>(
    `SELECT c.table_name, c.column_name
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = $1 AND t.table_type = 'BASE TABLE'
      ORDER BY c.table_name, c.ordinal_position`,
    [schema],
  );

  const pks = await q<{ table_name: string; column_name: string; ordinal: number }>(
    `SELECT tc.table_name, kcu.column_name, kcu.ordinal_position AS ordinal
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name
        AND kcu.constraint_schema = tc.constraint_schema
      WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = $1
      ORDER BY kcu.ordinal_position`,
    [schema],
  );

  const fks = await q<{
    table_name: string;
    column_name: string;
    parent_table: string;
    parent_column: string;
  }>(
    `SELECT tc.table_name,
            kcu.column_name,
            ccu.table_name  AS parent_table,
            ccu.column_name AS parent_column
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name
        AND kcu.constraint_schema = tc.constraint_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
        AND ccu.constraint_schema = tc.constraint_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = $1`,
    [schema],
  );

  const metas = new Map<string, TableMeta>();
  for (const { table_name, column_name } of columns) {
    const meta = metas.get(table_name) ?? { table: table_name, pk: '', columns: [], fks: [] };
    meta.columns.push(column_name);
    metas.set(table_name, meta);
  }
  for (const { table_name, column_name } of pks) {
    const meta = metas.get(table_name);
    if (meta && !meta.pk) meta.pk = column_name;
  }
  for (const fk of fks) {
    metas.get(fk.table_name)?.fks.push({
      column: fk.column_name,
      parentTable: fk.parent_table,
      parentColumn: fk.parent_column,
    });
  }
  return metas;
}

export function topoSort(metas: Map<string, TableMeta>, only: string[] = []): string[] {
  const scope = new Set(only.length ? only : [...metas.keys()]);
  const pending = new Set(scope);
  const order: string[] = [];

  while (pending.size) {
    const ready = [...pending]
      .filter((table) => {
        const fks = metas.get(table)?.fks ?? [];
        return fks.every(
          (fk) => fk.parentTable === table || !pending.has(fk.parentTable),
        );
      })
      .sort();

    if (!ready.length) {
      throw new Error(
        `Foreign-key cycle between tables: ${[...pending].sort().join(', ')}. ` +
          'Break it manually via the TABLES env var and run the members in a chosen order.',
      );
    }
    for (const table of ready) {
      pending.delete(table);
      order.push(table);
    }
  }
  return order;
}

export async function planTables(explicit: string[] = []): Promise<{
  metas: Map<string, TableMeta>;
  order: string[];
}> {
  const metas = await introspect();
  const requested = explicit.length ? explicit : config.tables;
  for (const table of requested) {
    if (!metas.has(table)) throw new Error(`Table "${table}" not found in schema ${config.schema}`);
  }
  const scope = (requested.length ? requested : [...metas.keys()]).filter(
    (t) => !config.skipTables.includes(t),
  );
  return { metas, order: topoSort(metas, scope) };
}

export async function fetchBatch(
  meta: TableMeta,
  afterPk: string | null,
  limit: number,
): Promise<Row[]> {
  const pk = ident(meta.pk);
  const where = afterPk === null ? '' : `WHERE ${pk} > $1`;
  const params = afterPk === null ? [limit] : [afterPk, limit];
  const limitIdx = afterPk === null ? 1 : 2;
  return q<Row>(
    `SELECT * FROM ${qualified(meta.table)} ${where} ORDER BY ${pk} LIMIT $${limitIdx}`,
    params,
  );
}

export async function countRows(table: string): Promise<number> {
  const rows = await q<{ n: string }>(`SELECT count(*)::text AS n FROM ${qualified(table)}`);
  return Number(rows[0]?.n ?? 0);
}

export async function applySchema(): Promise<void> {
  const sql = readFileSync(new URL('../sql/schema.sql', import.meta.url), 'utf8');
  await pool.query(sql);
}

export async function getCheckpoint(table: string): Promise<string | null> {
  const rows = await q<{ last_pk: string }>(
    'SELECT last_pk FROM migration_meta.checkpoints WHERE source_table = $1',
    [table],
  );
  return rows[0]?.last_pk ?? null;
}

export async function setCheckpoint(
  table: string,
  lastPk: string,
  rowsDone: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO migration_meta.checkpoints (source_table, last_pk, rows_done, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (source_table) DO UPDATE
       SET last_pk = EXCLUDED.last_pk,
           rows_done = migration_meta.checkpoints.rows_done + EXCLUDED.rows_done,
           updated_at = now()`,
    [table, lastPk, rowsDone],
  );
}

export async function finishTable(table: string): Promise<void> {
  await pool.query(
    'UPDATE migration_meta.checkpoints SET finished_at = now(), updated_at = now() WHERE source_table = $1',
    [table],
  );
}

export async function resetCheckpoint(table: string): Promise<void> {
  await pool.query('DELETE FROM migration_meta.checkpoints WHERE source_table = $1', [table]);
}

export async function recordMappings(
  entries: { table: string; pk: string; hydraId: string; hash: string }[],
): Promise<void> {
  if (!entries.length) return;
  await pool.query(
    `INSERT INTO migration_meta.id_map (source_table, source_pk, hydra_source_id, content_hash)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])
     ON CONFLICT (source_table, source_pk) DO UPDATE
       SET hydra_source_id = EXCLUDED.hydra_source_id,
           content_hash = EXCLUDED.content_hash,
           migrated_at = now()`,
    [
      entries.map((e) => e.table),
      entries.map((e) => e.pk),
      entries.map((e) => e.hydraId),
      entries.map((e) => e.hash),
    ],
  );
}

export async function lookupMappings(
  table: string,
  pks: string[],
): Promise<Map<string, { hydraId: string; hash: string }>> {
  const out = new Map<string, { hydraId: string; hash: string }>();
  if (!pks.length) return out;
  const rows = await q<{ source_pk: string; hydra_source_id: string; content_hash: string }>(
    `SELECT source_pk, hydra_source_id, content_hash
       FROM migration_meta.id_map
      WHERE source_table = $1 AND source_pk = ANY($2::text[])`,
    [table, [...new Set(pks)]],
  );
  for (const r of rows) {
    out.set(r.source_pk, { hydraId: r.hydra_source_id, hash: r.content_hash });
  }
  return out;
}

export async function recordFailure(
  table: string,
  pk: string | null,
  stage: 'transform' | 'load' | 'verify',
  error: string,
  payload?: unknown,
): Promise<void> {
  await pool.query(
    `INSERT INTO migration_meta.failures (source_table, source_pk, stage, error, payload)
     VALUES ($1, $2, $3, $4, $5)`,
    [table, pk, stage, error.slice(0, 4000), payload === undefined ? null : JSON.stringify(payload)],
  );
}

export async function openFailures(): Promise<{ source_table: string; stage: string; n: string }[]> {
  return q(
    `SELECT source_table, stage, count(*)::text AS n
       FROM migration_meta.failures
      WHERE NOT resolved
      GROUP BY source_table, stage
      ORDER BY source_table`,
  );
}

export async function recentFailures(
  limit: number,
): Promise<
  { source_table: string; source_pk: string | null; stage: string; error: string; failed_at: Date }[]
> {
  return q(
    `SELECT source_table, source_pk, stage, error, failed_at
       FROM migration_meta.failures
      WHERE NOT resolved
      ORDER BY failed_at DESC
      LIMIT $1`,
    [limit],
  );
}

export async function failedPks(table: string): Promise<string[]> {
  const rows = await q<{ source_pk: string }>(
    `SELECT DISTINCT source_pk FROM migration_meta.failures
      WHERE NOT resolved AND source_pk IS NOT NULL AND source_table = $1`,
    [table],
  );
  return rows.map((r) => r.source_pk);
}

export async function fetchByPks(meta: TableMeta, pks: string[]): Promise<Row[]> {
  if (!pks.length) return [];
  return q<Row>(
    `SELECT * FROM ${qualified(meta.table)} WHERE ${ident(meta.pk)}::text = ANY($1::text[])
      ORDER BY ${ident(meta.pk)}`,
    [pks],
  );
}

export async function resolveFailures(table: string, pks: string[]): Promise<void> {
  if (!pks.length) return;
  await pool.query(
    `UPDATE migration_meta.failures SET resolved = true
      WHERE source_table = $1 AND source_pk = ANY($2::text[])`,
    [table, pks],
  );
}

export async function getWatermark(table: string): Promise<Date | null> {
  const rows = await q<{ last_synced_at: Date | null }>(
    'SELECT last_synced_at FROM migration_meta.sync_state WHERE source_table = $1',
    [table],
  );
  return rows[0]?.last_synced_at ?? null;
}

export async function setWatermark(
  table: string,
  column: string | null,
  syncedAt: Date | null,
): Promise<void> {
  await pool.query(
    `INSERT INTO migration_meta.sync_state (source_table, watermark_column, last_synced_at, last_run_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (source_table) DO UPDATE
       SET watermark_column = EXCLUDED.watermark_column,
           last_synced_at = GREATEST(
             migration_meta.sync_state.last_synced_at,
             EXCLUDED.last_synced_at
           ),
           last_run_at = now()`,
    [table, column, syncedAt],
  );
}

export async function fetchChanged(
  meta: TableMeta,
  column: string,
  since: Date | null,
  afterPk: string | null,
  limit: number,
): Promise<Row[]> {
  const pk = ident(meta.pk);
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (since) {
    params.push(since);
    clauses.push(`${ident(column)} > $${params.length}`);
  }
  if (afterPk !== null) {
    params.push(afterPk);
    clauses.push(`${pk} > $${params.length}`);
  }
  params.push(limit);
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return q<Row>(
    `SELECT * FROM ${qualified(meta.table)} ${where} ORDER BY ${pk} LIMIT $${params.length}`,
    params,
  );
}

export async function findDeleted(meta: TableMeta, limit: number): Promise<
  { pk: string; hydraId: string }[]
> {
  const rows = await q<{ source_pk: string; hydra_source_id: string }>(
    `SELECT m.source_pk, m.hydra_source_id
       FROM migration_meta.id_map m
      WHERE m.source_table = $1
        AND NOT EXISTS (
          SELECT 1 FROM ${qualified(meta.table)} t
           WHERE t.${ident(meta.pk)}::text = m.source_pk
        )
      LIMIT $2`,
    [meta.table, limit],
  );
  return rows.map((r) => ({ pk: r.source_pk, hydraId: r.hydra_source_id }));
}

export async function forgetMappings(table: string, pks: string[]): Promise<void> {
  if (!pks.length) return;
  await pool.query(
    'DELETE FROM migration_meta.id_map WHERE source_table = $1 AND source_pk = ANY($2::text[])',
    [table, pks],
  );
}

export async function syncState(): Promise<
  { source_table: string; watermark_column: string | null; last_synced_at: Date | null; last_run_at: Date }[]
> {
  return q('SELECT * FROM migration_meta.sync_state ORDER BY source_table');
}

export async function progress(): Promise<
  { source_table: string; last_pk: string; rows_done: string; finished_at: Date | null }[]
> {
  return q(
    `SELECT source_table, last_pk, rows_done::text AS rows_done, finished_at
       FROM migration_meta.checkpoints ORDER BY source_table`,
  );
}
