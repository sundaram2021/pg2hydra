import { createHash } from 'node:crypto';
import type { Row, TableMeta } from './db.ts';

/**
 * EDIT THIS FILE — it is the only place per-table behaviour lives.
 * Everything here is a pure function: same row in, same document out. No I/O,
 * no model calls, no randomness.
 */

export type Target =
  | 'knowledge' // shared entity, transactional row or link row -> knowledge graph
  | 'memory' //    user-scoped fact -> memory graph
  | 'skip'; //     never migrated (audit logs, ephemeral tables, ...)

export type TableConfig = {
  target?: Target;
  /** Row -> the text that gets embedded. */
  text?: (row: Row) => string;
  /** Extra metadata merged on top of { table, pk }. */
  metadata?: (row: Row) => Record<string, unknown>;
  /** Column holding the owning user id — required when target is 'memory'. */
  userIdColumn?: string;
  /** FK columns to ignore when building relations. */
  ignoreFks?: string[];
};

/** Per-table overrides. Any table not listed falls back to the generic renderer. */
export const TABLES: Record<string, TableConfig> = {
  customers: {
    target: 'knowledge',
    text: (r) => `Customer ${r.name}, email ${r.email}, joined ${r.created_at}`,
  },
  orders: {
    target: 'knowledge',
    text: (r) =>
      `Order #${r.id}: ${r.item_count} items, status ${r.status}, placed ${r.created_at}`,
    metadata: (r) => ({ status: r.status, total: r.total }),
  },
  order_items: {
    // Link row: one small document that carries both edges (order + product).
    // Use target: 'skip' instead if HydraDB should hold no node for it at all.
    target: 'knowledge',
    text: (r) => `${r.qty}x ${r.product_name} in order #${r.order_id}`,
  },
  user_preferences: {
    target: 'memory',
    userIdColumn: 'user_id',
    text: (r) => `User preference: ${r.key} = ${r.value}`,
  },
};

/** child_table.fk_column -> edge label. Falls back to `references_<parent>`. */
export const RELATION_LABELS: Record<string, string> = {
  'orders.customer_id': 'belongs_to_customer',
  'order_items.order_id': 'part_of_order',
  'order_items.product_id': 'references_product',
};

// ---------------------------------------------------------------------- helpers

export const configFor = (table: string): TableConfig => TABLES[table] ?? {};

export const targetFor = (table: string): Target => configFor(table).target ?? 'knowledge';

/** Stable, collision-free HydraDB id. Recomputable from the source row alone. */
export const hydraId = (table: string, pk: unknown): string => `${table}_${String(pk)}`;

export const relationLabel = (table: string, column: string, parentTable: string): string =>
  RELATION_LABELS[`${table}.${column}`] ?? `references_${parentTable}`;

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Generic renderer for tables without an explicit template: "col: value" pairs,
 * FK columns omitted (they are represented as edges, not prose).
 */
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

export function renderMetadata(meta: TableMeta, row: Row): Record<string, unknown> {
  const extra = configFor(meta.table).metadata?.(row) ?? {};
  return { table: meta.table, source_pk: String(row[meta.pk]), ...extra };
}

/** Change detector: unchanged rows are skipped on re-runs. */
export function contentHash(text: string, metadata: unknown, relations: unknown): string {
  return createHash('md5')
    .update(text)
    .update(JSON.stringify(metadata))
    .update(JSON.stringify(relations ?? null))
    .digest('hex');
}

/** Fails fast when a template references a column the schema no longer has. */
export function assertColumns(meta: TableMeta, row: Row): void {
  for (const column of meta.columns) {
    if (!(column in row)) throw new Error(`schema drift: column "${column}" missing from row`);
  }
}
