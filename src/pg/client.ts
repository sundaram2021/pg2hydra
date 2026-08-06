import { Pool } from 'pg';
import { config } from '../config.ts';

export const pgPool = new Pool({
  connectionString: config.databaseUrl,
  max: Math.max(2, config.concurrency + 1),
  application_name: 'pg2hydra',
});

export async function query<T extends Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const result = await pgPool.query(text, values);
  return result.rows as T[];
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export async function closePg(): Promise<void> {
  await pgPool.end();
}
