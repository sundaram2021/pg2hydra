import type { RowBatch, TableObject } from '../types.ts';
import { normalizeRow, scalar, truncate } from './value.ts';

export function entityKey(
  table: TableObject,
  row: Record<string, unknown>,
): string {
  const keys =
    table.primary_key.length > 0
      ? table.primary_key
      : table.columns.slice(0, 1).map((column) => column.name);
  const parts = keys.map((key) => scalar(row[key]));
  return `${table.table}/${parts.join('-') || 'row'}`;
}

function rowRelations(
  table: TableObject,
  row: Record<string, unknown>,
  key: string,
): string[] {
  const out: string[] = [];
  for (const relation of table.relations.many_to_one) {
    const values = relation.columns.map((column) => row[column]);
    if (values.some((value) => value === null || value === undefined)) continue;
    const target = `${relation.references_table.split('.')[1]}/${values.map(scalar).join('-')}`;
    out.push(`${key} belongs to ${target} via ${relation.columns.join(', ')}.`);
  }
  return out;
}

export function renderBatch(batch: RowBatch): string {
  const { table } = batch;
  const lines: string[] = [];
  lines.push(
    `# ${table.qualified_name} rows ${batch.offset + 1}-${batch.offset + batch.rows.length}`,
  );
  lines.push('');
  lines.push(
    `Records from PostgreSQL ${table.kind} ${table.qualified_name}. Each record is one row keyed by ${table.primary_key.join(', ') || 'position'}.`,
  );
  lines.push('');

  for (const raw of batch.rows) {
    const row = normalizeRow(raw);
    const key = entityKey(table, row);
    lines.push(`## ${key}`);
    lines.push(JSON.stringify(row));
    lines.push(
      table.columns
        .map(
          (column) =>
            `${column.name}: ${truncate(scalar(row[column.name]), 300)}`,
        )
        .join('; '),
    );
    const relations = rowRelations(table, row, key);
    if (relations.length > 0) lines.push(relations.join(' '));
    lines.push('');
  }

  return lines.join('\n');
}
