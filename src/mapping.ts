import { createHash } from 'node:crypto';
import type { Row, TableMeta } from './db.ts';
import type { MetadataField } from './hydra.ts';

export type Target =
  | 'knowledge'
  | 'memory'
  | 'skip';

export type TableConfig = {
  target?: Target;

  text?: (row: Row) => string;

  title?: (row: Row) => string;

  metadata?: (row: Row) => Record<string, unknown>;

  userIdColumn?: string;

  updatedAtColumn?: string;

  ignoreFks?: string[];
};

export const TABLES: Record<string, TableConfig> = {
  customers: {
    target: 'knowledge',
    title: (r) => `Customer ${r.name}`,
    text: (r) => `Customer ${r.name} (${r.email}), ${r.tier} tier, joined ${r.created_at}`,
    metadata: (r) => ({ tier: r.tier }),
  },
  products: {
    target: 'knowledge',
    title: (r) => `Product ${r.name}`,
    text: (r) =>
      `Product ${r.name} in category ${r.category}, priced ${Number(r.price_cents) / 100}`,
    metadata: (r) => ({ category: r.category }),
  },
  employees: {
    target: 'knowledge',
    title: (r) => `Employee ${r.name}`,
    text: (r) => `Employee ${r.name}, role ${r.role}`,
  },
  orders: {
    target: 'knowledge',
    title: (r) => `Order #${r.id}`,
    text: (r) =>
      `Order #${r.id}: ${r.item_count} items totalling ${Number(r.total_cents) / 100}, ` +
      `status ${r.status}, placed ${r.created_at}`,
    metadata: (r) => ({ status: r.status }),
  },
  order_items: {
    target: 'knowledge',
    title: (r) => `Line item ${r.id}`,
    text: (r) => `${r.qty}x ${r.product_name} in order #${r.order_id}`,
  },
  user_preferences: {
    target: 'memory',
    userIdColumn: 'user_id',
    title: (r) => `Preference: ${r.key}`,
    text: (r) => `User preference: ${r.key} = ${r.value}`,
  },
  audit_log: { target: 'skip' },
};

export const RELATION_LABELS: Record<string, string> = {
  'orders.customer_id': 'belongs_to_customer',
  'orders.handled_by': 'handled_by_employee',
  'order_items.order_id': 'part_of_order',
  'order_items.product_id': 'references_product',
  'employees.manager_id': 'reports_to',
};

export const METADATA_SCHEMA: MetadataField[] = [
  { name: 'tier', dataType: 'VARCHAR', maxLength: 64, enableMatch: true },
  { name: 'category', dataType: 'VARCHAR', maxLength: 128, enableMatch: true },
  { name: 'status', dataType: 'VARCHAR', maxLength: 64, enableMatch: true },
];

export const configFor = (table: string): TableConfig => TABLES[table] ?? {};

export const targetFor = (table: string): Target => configFor(table).target ?? 'knowledge';

export const hydraId = (table: string, pk: unknown): string => `${table}_${String(pk)}`;

export const relationLabel = (table: string, column: string, parentTable: string): string =>
  RELATION_LABELS[`${table}.${column}`] ?? `references_${parentTable}`;

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function renderGeneric(meta: TableMeta, row: Row): string {
  const fkColumns = new Set(meta.fks.map((fk) => fk.column));
  const parts = meta.columns
    .filter((column) => !fkColumns.has(column))
    .map((column) => [column, formatValue(row[column])] as const)
    .filter(([, value]) => value !== '')
    .map(([column, value]) => `${column}: ${value}`);
  return `${meta.table} — ${parts.join(', ')}`;
}

export function renderText(meta: TableMeta, row: Row): string {
  const template = configFor(meta.table).text;
  const text = template ? template(row) : renderGeneric(meta, row);
  if (!text.trim()) throw new Error('rendered text is empty');
  return text;
}

const WATERMARK_CANDIDATES = ['updated_at', 'modified_at', 'updatedAt', 'last_modified', 'created_at'];

export function watermarkColumn(meta: TableMeta): string | null {
  const explicit = configFor(meta.table).updatedAtColumn;
  if (explicit) return meta.columns.includes(explicit) ? explicit : null;
  return WATERMARK_CANDIDATES.find((column) => meta.columns.includes(column)) ?? null;
}

export function renderTitle(meta: TableMeta, row: Row): string {
  const custom = configFor(meta.table).title;
  return custom ? custom(row) : `${meta.table} ${String(row[meta.pk])}`;
}

export function renderMetadata(
  meta: TableMeta,
  row: Row,
): { metadata: Record<string, unknown>; additional: Record<string, unknown> } {
  return {
    metadata: configFor(meta.table).metadata?.(row) ?? {},
    additional: { table: meta.table, source_pk: String(row[meta.pk]) },
  };
}

export function contentHash(text: string, metadata: unknown, relations: unknown): string {
  return createHash('md5')
    .update(text)
    .update(JSON.stringify(metadata))
    .update(JSON.stringify(relations ?? null))
    .digest('hex');
}

export function assertColumns(meta: TableMeta, row: Row): void {
  for (const column of meta.columns) {
    if (!(column in row)) throw new Error(`schema drift: column "${column}" missing from row`);
  }
}
