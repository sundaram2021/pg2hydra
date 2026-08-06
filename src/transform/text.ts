const MAX_VALUE = 400;

export function clean(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  let text: string;
  if (value instanceof Date) text = value.toISOString();
  else if (Buffer.isBuffer(value)) return null;
  else if (typeof value === 'object') text = JSON.stringify(value);
  else text = String(value);

  text = text.replace(/\s+/g, ' ').trim();
  if (text === '') return null;
  if (text.length > MAX_VALUE) text = `${text.slice(0, MAX_VALUE)}...`;
  return text;
}

export function fields(
  row: Record<string, unknown>,
  columns: string[],
  skip: string[],
): string {
  const parts: string[] = [];
  for (const column of columns) {
    if (skip.includes(column)) continue;
    const value = clean(row[column]);
    if (value === null) continue;
    parts.push(`${column}: ${value}`);
  }
  return parts.join('; ');
}

export function keyOf(row: Record<string, unknown>, primary: string[]): string {
  const parts = primary.map((column) => clean(row[column]) ?? 'null');
  return parts.join('-');
}

export function isoTime(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  const text = clean(value);
  if (text === null) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function readableDate(iso: string): string {
  return iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}
