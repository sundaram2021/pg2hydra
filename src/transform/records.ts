import type { Rendered, TablePlan } from '../types.ts';
import { clean, fields, isoTime, keyOf, readableDate } from './text.ts';

function belongsTo(plan: TablePlan, row: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const relation of plan.table.relations.many_to_one) {
    const values = relation.columns.map((column) => clean(row[column]));
    if (values.some((value) => value === null)) continue;
    const target = relation.references_table.split('.')[1];
    parts.push(`${target}/${values.join('-')}`);
  }
  if (parts.length === 0) return '';
  return ` Belongs to ${parts.join(' and ')}.`;
}

export function renderRecord(
  plan: TablePlan,
  row: Record<string, unknown>,
): Rendered {
  const { table } = plan;
  const key = keyOf(
    row,
    table.primary_key.length > 0 ? table.primary_key : [table.columns[0]!.name],
  );
  const label = `${table.table}/${key}`;
  const columns = table.columns.map((column) => column.name);
  const detail = fields(row, columns, table.primary_key);
  const links = belongsTo(plan, row);
  const text = detail
    ? `${label} - ${detail}.${links}`
    : `${label}${links ? ` links${links.replace(' Belongs to', '')}` : ' has no additional fields.'}`;
  return { id: key, key: label, text, time: null };
}

export function renderEpisode(
  plan: TablePlan,
  row: Record<string, unknown>,
): Rendered {
  const { table } = plan;
  const time = plan.time_column ? isoTime(row[plan.time_column]) : null;
  const key = keyOf(row, table.primary_key);
  const label = `${table.table}/${key}`;
  const skip = [...table.primary_key];
  if (plan.time_column) skip.push(plan.time_column);
  const detail = fields(
    row,
    table.columns.map((column) => column.name),
    skip,
  );
  const when = time ? `On ${readableDate(time)}, ` : '';
  const text = `${when}${label} was recorded${detail ? ` with ${detail}` : ''}.${belongsTo(plan, row)}`;
  return { id: key, key: label, text, time };
}

export function renderMemory(
  plan: TablePlan,
  row: Record<string, unknown>,
): Rendered {
  const { table } = plan;
  const key = keyOf(row, table.primary_key);
  const label = `${table.table}/${key}`;
  const detail = fields(
    row,
    table.columns.map((column) => column.name),
    table.primary_key,
  );
  const text = `${label} is a ${plan.entity} in the ${table.schema} dataset. Known details: ${detail || 'none recorded'}.${belongsTo(plan, row)}`;
  return { id: key, key: label, text, time: null };
}

export function renderFor(
  plan: TablePlan,
  row: Record<string, unknown>,
): Rendered {
  if (plan.layer === 'episode') return renderEpisode(plan, row);
  if (plan.layer === 'memory') return renderMemory(plan, row);
  return renderRecord(plan, row);
}
