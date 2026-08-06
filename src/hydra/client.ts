import { HydraDBClient } from '@hydradb/sdk';
import type { HydraDB } from '@hydradb/sdk';
import { config } from '../config.ts';
import { log } from '../util/log.ts';
import { waitFor, withRetry } from '../util/async.ts';

export type Hydra = HydraDBClient;

const METADATA_SCHEMA: HydraDB.TenantsCustomPropertyDefinition[] = [
  'pg_schema',
  'pg_table',
  'pg_kind',
  'pg_part',
  'pg_database',
].map((name) => ({
  name,
  dataType: 'VARCHAR',
  enableMatch: true,
  enableDenseEmbedding: false,
  enableSparseEmbedding: false,
  maxLength: 256,
}));

export function createClient(): Hydra {
  if (!config.hydraApiKey) throw new Error('HYDRA_DB_API_KEY is not set');
  return new HydraDBClient({
    token: config.hydraApiKey,
    baseUrl: config.hydraBaseUrl,
    timeoutInSeconds: Math.ceil(config.requestTimeoutMs / 1000),
    maxRetries: 0,
  });
}

function alreadyExists(error: unknown): boolean {
  const status = (error as { statusCode?: number })?.statusCode;
  const message = String((error as { message?: string })?.message ?? '');
  return status === 409 || /already[_ ]exists/i.test(message);
}

export async function ensureDatabase(client: Hydra): Promise<void> {
  const database = config.hydraDatabase;
  try {
    await client.databases.create({
      database,
      databaseMetadataSchema: METADATA_SCHEMA,
    });
    log.info(`created database ${database}`);
  } catch (error) {
    if (!alreadyExists(error)) throw error;
    log.info(`database ${database} already exists`);
  }

  await waitFor(
    `database ${database} readiness`,
    config.bootstrapTimeoutMs,
    5000,
    async () => {
      const response = await withRetry(
        'databases.status',
        config.maxRetries,
        () => client.databases.status({ database }),
      );
      return Boolean(response.data?.infra?.readyForIngestion);
    },
  );
  log.done(`database ${database} ready for ingestion`);
}

export async function waitIndexed(
  client: Hydra,
  ids: string[],
  requireGraph = config.waitForGraph,
): Promise<void> {
  if (ids.length === 0) return;
  const pending = new Set(ids);
  const settled = requireGraph
    ? ['completed']
    : ['completed', 'graph_creation'];

  await waitFor(
    `indexing of ${ids.length} sources`,
    config.verifyTimeoutMs,
    3000,
    async () => {
      const response = await withRetry(
        'context.status',
        config.maxRetries,
        () =>
          client.context.status({
            database: config.hydraDatabase,
            ...(config.hydraCollection
              ? { collection: config.hydraCollection }
              : {}),
            ids: [...pending],
          }),
      );

      for (const status of response.data?.statuses ?? []) {
        const state = status.indexingStatus ?? '';
        if (!status.id) continue;
        if (settled.includes(state)) pending.delete(status.id);
        if (state === 'failed' || state === 'errored') {
          log.warn(
            `indexing failed for ${status.id}: ${status.errorMessage || 'unknown error'}`,
          );
          pending.delete(status.id);
        }
      }
      if (pending.size > 0)
        log.info(
          `indexing: ${ids.length - pending.size}/${ids.length} settled`,
        );
      return pending.size === 0;
    },
  );
  log.done(`indexed ${ids.length} sources`);
}
