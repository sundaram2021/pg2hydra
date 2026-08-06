export type Column = {
  name: string;
  data_type: string;
  nullable: boolean;
  default: string | null;
  position: number;
};

export type ManyToOne = {
  constraint: string;
  columns: string[];
  references_table: string;
  references_columns: string[];
  on_delete: string;
};

export type OneToMany = {
  constraint: string;
  table: string;
  columns: string[];
  local_columns: string[];
};

export type ManyToMany = {
  through: string;
  local_columns: string[];
  target_table: string;
  target_columns: string[];
};

export type TableShape = {
  schema: string;
  table: string;
  kind: 'table' | 'view';
  comment: string | null;
  columns: Column[];
  primary_key: string[];
  composite_key: boolean;
  unique_keys: string[][];
  view_definition: string | null;
  estimated_rows: number;
};

export type Relations = {
  many_to_one: ManyToOne[];
  one_to_many: OneToMany[];
  many_to_many: ManyToMany[];
  self_referencing: boolean;
  junction: boolean;
};

export type TableObject = TableShape & {
  id: string;
  qualified_name: string;
  relations: Relations;
  related_tables: string[];
  row_count: number | null;
};

export type RowBatch = {
  table: TableObject;
  index: number;
  offset: number;
  rows: Record<string, unknown>[];
};

export type HydraSource = {
  id: string;
  title: string;
  type: string;
  timestamp: string;
  content: { markdown: string };
  tenant_metadata: Record<string, string>;
  additional_metadata: Record<string, unknown>;
  relations: { ids: string[]; properties?: Record<string, unknown> };
};
