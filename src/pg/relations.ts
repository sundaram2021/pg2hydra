import { config } from '../config.ts';
import { query } from './client.ts';
import type { Relations, TableObject, TableShape } from '../types.ts';

type ForeignKeyRow = {
  constraint_name: string;
  source_table: string;
  source_columns: string[];
  target_table: string;
  target_columns: string[];
  on_delete: string;
};

const DELETE_ACTIONS: Record<string, string> = {
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
  d: 'SET DEFAULT',
};

async function foreignKeys(): Promise<ForeignKeyRow[]> {
  return query<ForeignKeyRow>(
    `SELECT con.conname AS constraint_name,
            src.relname AS source_table,
            array_agg(DISTINCT sa.attname::text) AS source_columns,
            tgt.relname AS target_table,
            array_agg(DISTINCT ta.attname::text) AS target_columns,
            con.confdeltype AS on_delete
       FROM pg_constraint con
       JOIN pg_class src ON src.oid = con.conrelid
       JOIN pg_class tgt ON tgt.oid = con.confrelid
       JOIN pg_namespace nsp ON nsp.oid = src.relnamespace
       JOIN LATERAL unnest(con.conkey) AS sk(attnum) ON true
       JOIN pg_attribute sa ON sa.attrelid = src.oid AND sa.attnum = sk.attnum
       JOIN LATERAL unnest(con.confkey) AS tk(attnum) ON true
       JOIN pg_attribute ta ON ta.attrelid = tgt.oid AND ta.attnum = tk.attnum
      WHERE nsp.nspname = $1 AND con.contype = 'f'
      GROUP BY con.conname, src.relname, tgt.relname, con.confdeltype`,
    [config.pgSchema],
  );
}

function buildRelations(
  shape: TableShape,
  allKeys: ForeignKeyRow[],
): Relations {
  const outgoing = allKeys.filter((key) => key.source_table === shape.table);
  const incoming = allKeys.filter((key) => key.target_table === shape.table);

  const many_to_one = outgoing.map((key) => ({
    constraint: key.constraint_name,
    columns: key.source_columns,
    references_table: `${shape.schema}.${key.target_table}`,
    references_columns: key.target_columns,
    on_delete: DELETE_ACTIONS[key.on_delete] ?? 'NO ACTION',
  }));

  const one_to_many = incoming.map((key) => ({
    constraint: key.constraint_name,
    table: `${shape.schema}.${key.source_table}`,
    columns: key.source_columns,
    local_columns: key.target_columns,
  }));

  const junction =
    shape.composite_key &&
    outgoing.length >= 2 &&
    shape.primary_key.every((column) =>
      outgoing.some((key) => key.source_columns.includes(column)),
    );

  const many_to_many = junction
    ? outgoing.flatMap((key) =>
        outgoing
          .filter((other) => other.constraint_name !== key.constraint_name)
          .map((other) => ({
            through: `${shape.schema}.${shape.table}`,
            local_columns: key.source_columns,
            target_table: `${shape.schema}.${other.target_table}`,
            target_columns: other.target_columns,
          })),
      )
    : [];

  return {
    many_to_one,
    one_to_many,
    many_to_many,
    self_referencing: outgoing.some((key) => key.target_table === shape.table),
    junction,
  };
}

export function sourceId(schema: string, table: string): string {
  return `pg::${schema}.${table}::object`;
}

export async function buildTableObjects(
  shapes: TableShape[],
): Promise<TableObject[]> {
  const keys = await foreignKeys();
  const present = new Set(shapes.map((shape) => shape.table));

  return shapes.map((shape) => {
    const relations = buildRelations(shape, keys);
    const related = new Set<string>();
    for (const relation of relations.many_to_one)
      related.add(relation.references_table);
    for (const relation of relations.one_to_many) related.add(relation.table);
    for (const relation of relations.many_to_many)
      related.add(relation.target_table);
    related.delete(`${shape.schema}.${shape.table}`);

    return {
      ...shape,
      id: sourceId(shape.schema, shape.table),
      qualified_name: `${shape.schema}.${shape.table}`,
      relations,
      related_tables: [...related].filter((name) =>
        present.has(name.split('.')[1]!),
      ),
      row_count: null,
    };
  });
}
