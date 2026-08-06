import { config } from '../config.ts';
import { log } from '../util/log.ts';
import { pool, sleep, withRetry } from '../util/async.ts';
import type { Hydra } from './client.ts';
import type { HydraDocument } from '../types.ts';

type UploadResult = {
  id?: string;
  error?: string | null;
  relations_created?: number;
  relations_error?: string | null;
};

function buildForm(group: HydraDocument[]): FormData {
  const form = new FormData();
  form.append('type', 'knowledge');
  form.append('database', config.hydraDatabase);
  if (config.hydraCollection) form.append('collection', config.hydraCollection);
  form.append('upsert', 'true');

  for (const document of group) {
    form.append(
      'documents',
      new Blob([document.text], { type: 'text/markdown' }),
      document.filename,
    );
  }

  form.append(
    'document_metadata',
    JSON.stringify(
      group.map((document) => ({
        id: document.id,
        ...(config.declareMetadataSchema
          ? { metadata: document.metadata }
          : {}),
        additional_metadata: config.declareMetadataSchema
          ? document.additional_metadata
          : { ...document.metadata, ...document.additional_metadata },
        relations: { ids: document.relations },
      })),
    ),
  );

  return form;
}

async function send(
  client: Hydra,
  group: HydraDocument[],
): Promise<UploadResult[]> {
  const response = await client.fetch('/context/ingest', {
    method: 'POST',
    body: buildForm(group),
  });
  const payload = (await response.json()) as {
    success?: boolean;
    data?: { results?: UploadResult[] };
    error?: { message?: string };
  };
  if (!response.ok || payload.success === false) {
    const error = new Error(
      payload.error?.message ?? `ingest failed with ${response.status}`,
    );
    Object.assign(error, { statusCode: response.status });
    throw error;
  }
  return payload.data?.results ?? [];
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    out.push(items.slice(index, index + size));
  return out;
}

export async function uploadDocuments(
  client: Hydra,
  documents: HydraDocument[],
  label: string,
): Promise<{ ids: string[]; edges: number }> {
  if (documents.length === 0) return { ids: [], edges: 0 };
  const groups = chunk(documents, config.uploadChunk);
  const ids: string[] = [];
  let edges = 0;
  let done = 0;

  await pool(groups, config.concurrency, async (group) => {
    const results = await withRetry(
      `upload ${label}`,
      config.maxRetries,
      async () => {
        if (config.requestDelayMs > 0) await sleep(config.requestDelayMs);
        return send(client, group);
      },
    );

    for (const result of results) {
      if (result.error)
        log.warn(`ingest error for ${result.id ?? 'unknown'}: ${result.error}`);
      else if (result.id) ids.push(result.id);
      if (result.relations_error)
        log.warn(
          `relation error for ${result.id ?? 'unknown'}: ${result.relations_error}`,
        );
      edges += result.relations_created ?? 0;
    }

    done += group.length;
    log.info(
      `${label}: ${done}/${documents.length} documents, ${edges} graph edges`,
    );
    if (config.batchDelayMs > 0) await sleep(config.batchDelayMs);
  });

  return { ids, edges };
}
