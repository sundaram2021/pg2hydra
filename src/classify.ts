import { config } from './config.ts';
import type { Layer, TableObject, TablePlan } from './types.ts';

const TIME_TYPES = [
  'timestamp',
  'timestamptz',
  'timestamp with time zone',
  'timestamp without time zone',
  'date',
];
const TIME_NAMES = [
  'occurred_at',
  'happened_at',
  'event_time',
  'placed_at',
  'created_at',
  'inserted_at',
  'recorded_at',
  'updated_at',
];
const PERSON_NAMES = [
  'users',
  'user',
  'customers',
  'customer',
  'accounts',
  'people',
  'persons',
  'members',
  'profiles',
  'contacts',
];
const PERSON_COLUMNS = ['email', 'email_address', 'username', 'full_name'];

function timeColumn(table: TableObject): string | null {
  const temporal = table.columns.filter((column) =>
    TIME_TYPES.includes(column.data_type.toLowerCase()),
  );
  if (temporal.length === 0) return null;
  for (const name of TIME_NAMES) {
    const match = temporal.find((column) => column.name.toLowerCase() === name);
    if (match) return match.name;
  }
  return temporal[0]!.name;
}

function looksLikePerson(table: TableObject): boolean {
  if (PERSON_NAMES.includes(table.table.toLowerCase())) return true;
  const columns = table.columns.map((column) => column.name.toLowerCase());
  return (
    PERSON_COLUMNS.some((name) => columns.includes(name)) &&
    table.primary_key.length === 1
  );
}

function chosenLayer(table: TableObject, time: string | null): Layer {
  if (table.primary_key.length === 0) return 'knowledge';
  if (config.memoryTables.includes(table.table)) return 'memory';
  if (config.episodeTables.includes(table.table)) return 'episode';
  if (config.memoryTables.length > 0 || config.episodeTables.length > 0)
    return 'knowledge';
  if (table.kind === 'view') return 'knowledge';
  if (table.primary_key.length > 0 && looksLikePerson(table)) return 'memory';
  if (time && table.primary_key.length > 0) return 'episode';
  return 'knowledge';
}

export function planTable(table: TableObject): TablePlan {
  const time = timeColumn(table);
  const layer = chosenLayer(table, time);
  return {
    table,
    layer,
    time_column: layer === 'episode' ? time : null,
    entity: table.table.replace(/s$/, ''),
  };
}

export function planTables(tables: TableObject[]): TablePlan[] {
  return tables.map(planTable);
}
