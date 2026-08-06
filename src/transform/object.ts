import type { TableObject } from '../types.ts';
import { truncate } from './value.ts';

export function renderSchema(table: TableObject): string {
  const lines: string[] = [];
  lines.push(`# ${table.qualified_name}`);
  lines.push('');
  lines.push(
    `${table.qualified_name} is a PostgreSQL ${table.kind} in schema ${table.schema}.`,
  );
  if (table.comment) lines.push(table.comment);
  lines.push(
    table.primary_key.length > 0
      ? `${table.table} is identified by ${table.composite_key ? 'composite primary key' : 'primary key'} (${table.primary_key.join(', ')}).`
      : `${table.table} has no primary key.`,
  );

  lines.push('');
  lines.push('## Columns');
  for (const column of table.columns) {
    lines.push(
      `- ${table.table}.${column.name} is ${column.data_type}${column.nullable ? ', nullable' : ', not null'}${column.default ? `, default ${column.default}` : ''}.`,
    );
  }

  for (const unique of table.unique_keys)
    lines.push(`- ${table.table} is unique on (${unique.join(', ')}).`);

  lines.push('');
  lines.push('## Relationships');
  if (
    table.relations.many_to_one.length === 0 &&
    table.relations.one_to_many.length === 0 &&
    table.relations.many_to_many.length === 0
  ) {
    lines.push(`- ${table.table} has no foreign key relationships.`);
  }
  for (const relation of table.relations.many_to_one) {
    lines.push(
      `- Many ${table.table} belong to one ${relation.references_table}: ${table.table}.${relation.columns.join(', ')} references ${relation.references_table}.${relation.references_columns.join(', ')} (many-to-one, on delete ${relation.on_delete}).`,
    );
  }
  for (const relation of table.relations.one_to_many) {
    lines.push(
      `- One ${table.qualified_name} has many ${relation.table}: ${relation.table}.${relation.columns.join(', ')} references ${table.table}.${relation.local_columns.join(', ')} (one-to-many).`,
    );
  }
  for (const relation of table.relations.many_to_many) {
    lines.push(
      `- ${table.qualified_name} joins ${relation.target_table} through ${relation.through} (many-to-many) on ${relation.local_columns.join(', ')} and ${relation.target_columns.join(', ')}.`,
    );
  }
  if (table.relations.self_referencing)
    lines.push(
      `- ${table.qualified_name} is self-referencing and forms a hierarchy.`,
    );
  if (table.relations.junction)
    lines.push(
      `- ${table.qualified_name} is a junction table linking ${table.related_tables.join(' and ')}.`,
    );

  if (table.view_definition) {
    lines.push('');
    lines.push('## View definition');
    lines.push('```sql');
    lines.push(truncate(table.view_definition, 4000));
    lines.push('```');
  }

  lines.push('');
  lines.push('## Object');
  lines.push('```json');
  lines.push(JSON.stringify(toObject(table), null, 2));
  lines.push('```');
  return lines.join('\n');
}

export function toObject(table: TableObject): Record<string, unknown> {
  return {
    id: table.id,
    qualified_name: table.qualified_name,
    schema: table.schema,
    table: table.table,
    kind: table.kind,
    primary_key: table.primary_key,
    composite_key: table.composite_key,
    unique_keys: table.unique_keys,
    columns: table.columns,
    relations: table.relations,
    related_tables: table.related_tables,
    row_count: table.row_count,
  };
}
