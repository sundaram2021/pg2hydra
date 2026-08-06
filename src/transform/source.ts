import { config } from '../config.ts';
import type { HydraSource, RowBatch, TableObject } from '../types.ts';
import { renderSchema } from './object.ts';
import { renderBatch } from './record.ts';

export function batchId(table: TableObject, index: number): string {
  return `pg::${table.qualified_name}::rows::${String(index).padStart(5, '0')}`;
}

function base(
  table: TableObject,
): Pick<HydraSource, 'timestamp' | 'tenant_metadata'> {
  return {
    timestamp: new Date().toISOString(),
    tenant_metadata: {
      pg_schema: table.schema,
      pg_table: table.table,
      pg_kind: table.kind,
      pg_part: 'object',
      pg_database: config.hydraDatabase,
    },
  };
}

export function schemaSource(table: TableObject): HydraSource {
  const shared = base(table);
  return {
    id: table.id,
    title: `${table.qualified_name} (${table.kind} definition)`,
    type: 'knowledge_base',
    timestamp: shared.timestamp,
    content: { markdown: renderSchema(table) },
    tenant_metadata: shared.tenant_metadata,
    additional_metadata: {
      primary_key: table.primary_key,
      composite_key: table.composite_key,
      unique_keys: table.unique_keys.map((key) => key.join(',')),
      column_names: table.columns.map((column) => column.name),
      related_tables: table.related_tables,
      many_to_one: table.relations.many_to_one.length,
      one_to_many: table.relations.one_to_many.length,
      many_to_many: table.relations.many_to_many.length,
      junction: table.relations.junction,
      self_referencing: table.relations.self_referencing,
      row_count: table.row_count,
      source_layer: 'schema',
    },
    relations: {
      ids: table.related_tables.map((name) => `pg::${name}::object`),
      properties: {
        reason: 'foreign key relationship between postgres tables',
      },
    },
  };
}

export function batchSource(batch: RowBatch): HydraSource {
  const { table } = batch;
  const shared = base(table);
  return {
    id: batchId(table, batch.index),
    title: `${table.qualified_name} rows ${batch.offset + 1}-${batch.offset + batch.rows.length}`,
    type: 'custom',
    timestamp: shared.timestamp,
    content: { markdown: renderBatch(batch) },
    tenant_metadata: { ...shared.tenant_metadata, pg_part: 'rows' },
    additional_metadata: {
      batch_index: batch.index,
      row_offset: batch.offset,
      row_count: batch.rows.length,
      primary_key: table.primary_key,
      composite_key: table.composite_key,
      related_tables: table.related_tables,
      source_layer: 'rows',
    },
    relations: {
      ids: [
        table.id,
        ...table.related_tables.map((name) => `pg::${name}::object`),
      ],
      properties: {
        reason: 'rows belong to their table object and its related tables',
      },
    },
  };
}
