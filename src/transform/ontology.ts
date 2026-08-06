import type { TableObject, TablePlan } from '../types.ts';

function tidyDefault(value: string | null): string | null {
  if (!value) return null;
  if (value.includes('nextval(')) return 'auto-generated';
  const simple = value.replace(/::[a-z ]+/gi, '').replace(/^'|'$/g, '');
  return `defaults to ${simple}`;
}

function columnLine(
  table: TableObject,
  name: string,
  type: string,
  nullable: boolean,
  fallback: string | null,
): string {
  const role: string[] = [];
  if (table.primary_key.includes(name)) role.push('primary key');
  const reference = table.relations.many_to_one.find((relation) =>
    relation.columns.includes(name),
  );
  if (reference)
    role.push(
      `references ${reference.references_table}.${reference.references_columns.join(', ')}`,
    );
  role.push(nullable ? 'optional' : 'required');
  const shown = tidyDefault(fallback);
  if (shown) role.push(shown);
  return `- ${name} (${type}) - ${role.join(', ')}.`;
}

function relationshipLines(table: TableObject): string[] {
  const lines: string[] = [];
  for (const relation of table.relations.many_to_one) {
    lines.push(
      `- Each ${table.table} row belongs to one ${relation.references_table} row, linked by ${table.table}.${relation.columns.join(', ')} to ${relation.references_table}.${relation.references_columns.join(', ')}.`,
    );
  }
  for (const relation of table.relations.one_to_many) {
    lines.push(
      `- Each ${table.table} row can have many ${relation.table} rows, linked by ${relation.table}.${relation.columns.join(', ')}.`,
    );
  }
  for (const relation of table.relations.many_to_many) {
    lines.push(
      `- ${table.table} connects to ${relation.target_table} in a many-to-many relationship through ${relation.through}.`,
    );
  }
  if (table.relations.self_referencing)
    lines.push(`- ${table.table} references itself, forming a hierarchy.`);
  if (lines.length === 0)
    lines.push(`- ${table.table} has no foreign key relationships.`);
  return lines;
}

export function renderOntology(plan: TablePlan): string {
  const { table } = plan;
  const lines: string[] = [];

  lines.push(`# ${table.qualified_name}`);
  lines.push('');
  const identity =
    table.primary_key.length > 0
      ? `Each row is identified by ${table.composite_key ? 'the composite key ' : ''}${table.primary_key.join(' and ')}.`
      : 'Rows have no primary key.';
  lines.push(
    `${table.qualified_name} is a PostgreSQL ${table.kind} holding ${table.row_count ?? 0} rows. ${identity}`,
  );
  if (table.comment) lines.push(table.comment);
  lines.push(
    `Its rows are stored in HydraDB as ${plan.layer === 'memory' ? 'memories, one per entity' : plan.layer === 'episode' ? 'time-ordered episodes' : 'knowledge records'}.`,
  );

  lines.push('');
  lines.push('## Columns');
  for (const column of table.columns) {
    lines.push(
      columnLine(
        table,
        column.name,
        column.data_type,
        column.nullable,
        column.default,
      ),
    );
  }
  for (const unique of table.unique_keys)
    lines.push(`- Unique constraint on ${unique.join(' and ')}.`);

  lines.push('');
  lines.push('## Relationships');
  for (const line of relationshipLines(table)) lines.push(line);

  if (table.view_definition) {
    lines.push('');
    lines.push('## Definition');
    lines.push(table.view_definition);
  }

  return `${lines.join('\n')}\n`;
}
