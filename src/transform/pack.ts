import { config } from '../config.ts';
import type { HydraDocument, Rendered, TablePlan } from '../types.ts';

export function ontologyId(qualified: string): string {
  return `pg::${qualified}::table`;
}

function partName(plan: TablePlan): string {
  return plan.layer === 'episode' ? 'episodes' : 'rows';
}

function relationsFor(plan: TablePlan): string[] {
  return [
    ontologyId(plan.table.qualified_name),
    ...plan.table.related_tables.map(ontologyId),
  ];
}

function header(plan: TablePlan, from: number, to: number): string {
  const { table } = plan;
  const kind =
    plan.layer === 'episode'
      ? `Time-ordered events from ${table.qualified_name}`
      : `Records from ${table.qualified_name}`;
  return `# ${table.qualified_name} - ${partName(plan)} ${from}-${to}\n\n${kind}, a PostgreSQL ${table.kind}. Each line is one row identified by ${table.primary_key.join(' and ') || 'position'}.\n\n`;
}

export function packDocuments(
  plan: TablePlan,
  records: Rendered[],
  startIndex: number,
  startOffset: number,
): HydraDocument[] {
  const documents: HydraDocument[] = [];
  let bucket: Rendered[] = [];
  let bytes = 0;
  let index = startIndex;
  let offset = startOffset;

  const flush = (): void => {
    if (bucket.length === 0) return;
    const from = offset + 1;
    const to = offset + bucket.length;
    const times = bucket
      .map((record) => record.time)
      .filter((time): time is string => time !== null)
      .sort();
    const suffix = String(index).padStart(5, '0');

    documents.push({
      id: `pg::${plan.table.qualified_name}::${partName(plan)}::${suffix}`,
      filename: `${plan.table.qualified_name} (${partName(plan)} ${from}-${to}).md`,
      text:
        header(plan, from, to) +
        bucket.map((record) => record.text).join('\n') +
        '\n',
      metadata: {
        pg_schema: plan.table.schema,
        pg_table: plan.table.table,
        pg_kind: plan.table.kind,
        pg_part: plan.layer === 'episode' ? 'episode' : 'rows',
        pg_database: config.hydraDatabase,
      },
      additional_metadata: {
        source_layer: plan.layer,
        batch_index: index,
        row_from: from,
        row_to: to,
        row_count: bucket.length,
        related_tables: plan.table.related_tables,
        ...(times.length > 0
          ? { event_start: times[0], event_end: times[times.length - 1] }
          : {}),
      },
      relations: relationsFor(plan),
    });

    offset += bucket.length;
    index += 1;
    bucket = [];
    bytes = 0;
  };

  for (const record of records) {
    const size = Buffer.byteLength(record.text) + 1;
    if (bucket.length > 0 && bytes + size > config.docTargetBytes) flush();
    bucket.push(record);
    bytes += size;
  }
  flush();

  return documents;
}
