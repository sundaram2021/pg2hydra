import { config } from '../config.ts';
import { query } from './client.ts';
import type { Column, TableShape } from '../types.ts';

type TableRow = {
  table_name: string;
  kind: 'table' | 'view';
  comment: string | null;
};
type ColumnRow = {
  table_name: string;
  name: string;
  data_type: string;
  nullable: string;
  default: string | null;
};
type KeyRow = {
  table_name: string;
  constraint_type: string;
  constraint_name: string;
  columns: string[];
};
type ViewRow = { table_name: string; definition: string };

function included(name: string): boolean {
  if (config.skipTables.includes(name)) return false;
  return config.tables.length === 0 || config.tables.includes(name);
}

export async function introspect(): Promise<TableShape[]> {
  const schema = config.pgSchema;

  const tables = await query<TableRow>(
    `SELECT c.relname AS table_name,
            CASE WHEN c.relkind = 'v' THEN 'view' ELSE 'table' END AS kind,
            obj_description(c.oid) AS comment
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v')
      ORDER BY c.relkind, c.relname`,
    [schema],
  );

  const columns = await query<ColumnRow>(
    `SELECT table_name, column_name AS name, data_type, is_nullable AS nullable,
            column_default AS default
       FROM information_schema.columns
      WHERE table_schema = $1
      ORDER BY table_name, ordinal_position`,
    [schema],
  );

  const keys = await query<KeyRow>(
    `SELECT rel.relname AS table_name, con.contype AS constraint_type, con.conname AS constraint_name,
            array_agg(att.attname::text ORDER BY k.ord) AS columns
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
       JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
       JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = k.attnum
      WHERE nsp.nspname = $1 AND con.contype IN ('p', 'u')
      GROUP BY rel.relname, con.contype, con.conname`,
    [schema],
  );

  const views = await query<ViewRow>(
    `SELECT table_name, view_definition AS definition
       FROM information_schema.views
      WHERE table_schema = $1`,
    [schema],
  );

  const byTable = <T extends { table_name: string }>(
    rows: T[],
    name: string,
  ): T[] => rows.filter((row) => row.table_name === name);

  return tables
    .filter((table) => included(table.table_name))
    .map((table) => {
      const cols: Column[] = byTable(columns, table.table_name).map(
        (column) => ({
          name: column.name,
          data_type: column.data_type,
          nullable: column.nullable === 'YES',
          default: column.default,
        }),
      );
      const tableKeys = byTable(keys, table.table_name);
      const primary =
        tableKeys.find((key) => key.constraint_type === 'p')?.columns ?? [];
      return {
        schema,
        table: table.table_name,
        kind: table.kind,
        comment: table.comment,
        columns: cols,
        primary_key: primary,
        composite_key: primary.length > 1,
        unique_keys: tableKeys
          .filter((key) => key.constraint_type === 'u')
          .map((key) => key.columns),
        view_definition:
          views
            .find((view) => view.table_name === table.table_name)
            ?.definition?.trim() ?? null,
      };
    });
}
