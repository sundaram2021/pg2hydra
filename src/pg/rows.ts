import { config } from '../config.ts';
import { query, quoteIdent } from './client.ts';
import type { RowBatch, TableObject } from '../types.ts';

function orderClause(table: TableObject): string {
  const keys =
    table.primary_key.length > 0
      ? table.primary_key
      : table.columns.slice(0, 1).map((column) => column.name);
  if (keys.length === 0) return '';
  return ` ORDER BY ${keys.map(quoteIdent).join(', ')}`;
}

export async function countRows(table: TableObject): Promise<number> {
  const rows = await query<{ total: string }>(
    `SELECT count(*)::text AS total FROM ${quoteIdent(table.schema)}.${quoteIdent(table.table)}`,
  );
  return Number(rows[0]?.total ?? 0);
}

export async function* readBatches(
  table: TableObject,
): AsyncGenerator<RowBatch> {
  const target = `${quoteIdent(table.schema)}.${quoteIdent(table.table)}`;
  const order = orderClause(table);
  let offset = 0;
  let index = 0;

  while (true) {
    const rows = await query<Record<string, unknown>>(
      `SELECT * FROM ${target}${order} LIMIT $1 OFFSET $2`,
      [config.batchSize, offset],
    );
    if (rows.length === 0) return;
    yield { table, index, offset, rows };
    if (rows.length < config.batchSize) return;
    offset += rows.length;
    index += 1;
  }
}
