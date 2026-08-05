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
  /** Row -> short title shown in HydraDB search results. */
  title?: (row: Row) => string;
  /** Extra metadata merged on top of { table, pk }. */
  metadata?: (row: Row) => Record<string, unknown>;
  /** Column holding the owning user id — required when target is 'memory'. */
  userIdColumn?: string;
  /**
   * Timestamp column that incremental sync watermarks on. Auto-detected from
   * updated_at / modified_at / created_at when omitted.
   */
  updatedAtColumn?: string;
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

const WATERMARK_CANDIDATES = ['updated_at', 'modified_at', 'updatedAt', 'last_modified', 'created_at'];

/** The column incremental sync watermarks on, or null for a full re-scan. */
export function watermarkColumn(meta: TableMeta): string | null {
  const explicit = configFor(meta.table).updatedAtColumn;
  if (explicit) return meta.columns.includes(explicit) ? explicit : null;
  return WATERMARK_CANDIDATES.find((column) => meta.columns.includes(column)) ?? null;
}

export function renderTitle(meta: TableMeta, row: Row): string {
  const custom = configFor(meta.table).title;
  return custom ? custom(row) : `${meta.table} ${String(row[meta.pk])}`;
}

/**
 * `metadata` holds only what you declared in the HydraDB database metadata
 * schema (the fast, pre-filtered path). Engine bookkeeping goes to
 * `additional_metadata`, which is free-form and needs no schema declaration.
 */
export function renderMetadata(
  meta: TableMeta,
  row: Row,
): { metadata: Record<string, unknown>; additional: Record<string, unknown> } {
  return {
    metadata: configFor(meta.table).metadata?.(row) ?? {},
    additional: { table: meta.table, source_pk: String(row[meta.pk]) },
  };
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
