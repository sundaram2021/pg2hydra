export function normalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>))
      out[key] = normalize(entry);
    return out;
  }
  return value;
}

export function normalizeRow(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) out[key] = normalize(value);
  return out;
}

export function scalar(value: unknown): string {
  const normalized = normalize(value);
  if (normalized === null) return 'null';
  if (typeof normalized === 'object') return JSON.stringify(normalized);
  return String(normalized);
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
