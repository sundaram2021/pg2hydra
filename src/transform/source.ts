import { config } from '../config.ts';
import type {
  HydraDocument,
  HydraMemory,
  Rendered,
  TablePlan,
} from '../types.ts';
import { renderOntology } from './ontology.ts';
import { ontologyId } from './pack.ts';

export function ontologyDocument(plan: TablePlan): HydraDocument {
  const { table } = plan;
  return {
    id: ontologyId(table.qualified_name),
    filename: `${table.qualified_name} (table definition).md`,
    text: renderOntology(plan),
    metadata: {
      pg_schema: table.schema,
      pg_table: table.table,
      pg_kind: table.kind,
      pg_part: 'ontology',
      pg_database: config.hydraDatabase,
    },
    additional_metadata: {
      source_layer: 'ontology',
      primary_key: table.primary_key,
      composite_key: table.composite_key,
      unique_keys: table.unique_keys.map((key) => key.join(',')),
      column_names: table.columns.map((column) => column.name),
      related_tables: table.related_tables,
      junction: table.relations.junction,
      self_referencing: table.relations.self_referencing,
      row_count: table.row_count,
      rows_stored_as: plan.layer,
    },
    relations: table.related_tables.map(ontologyId),
  };
}

export function memoryItem(plan: TablePlan, record: Rendered): HydraMemory {
  const { table } = plan;
  return {
    id: `pg::${table.qualified_name}::memory::${record.key.split('/')[1]}`,
    collection: `${table.table}:${record.key.split('/')[1]}`,
    text: record.text,
    metadata: {
      pg_schema: table.schema,
      pg_table: table.table,
      pg_kind: table.kind,
      pg_part: 'memory',
      pg_database: config.hydraDatabase,
    },
    additional_metadata: {
      source_layer: 'memory',
      entity: record.key,
      related_tables: table.related_tables,
    },
  };
}
