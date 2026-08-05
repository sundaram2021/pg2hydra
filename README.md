# pg2hydra

Deterministic, resumable, foreign-key-aware migration engine from **Supabase Postgres → HydraDB**.

No LLM in the critical path. Every row becomes the same document every time: templates in, documents out.
Foreign keys become explicit HydraDB `relations` — no inference, no extraction step.

```
plan → extract → transform → load → verify
 FK     keyset     template     batched   ingestion
 order  paging     + relations  upsert    confirmation
                       │
                 migration_meta.*  (checkpoints · id_map · failures)
```

## Install

```bash
npm install
cp .env.example .env    # fill in DATABASE_URL and HYDRA_BASE_URL / HYDRA_API_KEY
npm run build           # optional — the CLI also runs straight from src on Node 22+
```

## Use

```bash
node src/index.ts init                       # create the migration_meta schema
node src/index.ts plan                       # show the FK-ordered table plan
node src/index.ts migrate --dry-run          # extract + transform only, no writes
node src/index.ts migrate                    # run the backfill (resumable)
node src/index.ts migrate -t customers       # one table
node src/index.ts status                     # % complete per table + open failures
node src/index.ts redrive                    # retry dead-lettered rows
node src/index.ts migrate --restart          # re-scan from zero; unchanged rows are skipped by hash
```

Stop it at any point — `Ctrl+C`, crash, deploy — and re-run. It resumes from the last checkpoint,
and rows whose content hash is unchanged are never re-uploaded.

## Configure the mapping

`src/mapping.ts` is the only file you edit per project. Three things live there:

```ts
export const TABLES = {
  customers: {
    target: 'knowledge',                               // knowledge | memory | skip
    text: (r) => `Customer ${r.name}, email ${r.email}, joined ${r.created_at}`,
  },
  user_preferences: {
    target: 'memory',                                  // user-scoped fact
    userIdColumn: 'user_id',
    text: (r) => `User preference: ${r.key} = ${r.value}`,
  },
  audit_log: { target: 'skip' },                        // never migrated
};

export const RELATION_LABELS = {
  'orders.customer_id': 'belongs_to_customer',          // child.fk_column -> edge label
  'order_items.order_id': 'part_of_order',
};
```

Anything you don't list still migrates: the generic renderer emits `col: value` pairs
(FK columns excluded — they're edges, not prose) and edges default to `references_<parent>`.

A row becomes:

```json
{
  "id": "orders_5001",
  "content": "Order #5001: 3 items, status shipped, placed 2026-01-02",
  "document_metadata": { "table": "orders", "source_pk": "5001", "status": "shipped" },
  "relations": {
    "cortex_source_ids": ["customers_120"],
    "properties": { "relation": "belongs_to_customer" }
  }
}
```

Document ids are `{table}_{pk}` — stable and recomputable from the source row alone, which is
what makes every write an idempotent upsert.

## How the guarantees are implemented

| Guarantee | Mechanism |
| --- | --- |
| Resumable | `migration_meta.checkpoints.last_pk` + keyset paging (`WHERE pk > last_pk`, never `OFFSET`) |
| Idempotent | deterministic ids + `upsert: true` on every write |
| Cheap re-runs | `content_hash` in `id_map`; unchanged rows are skipped before any network call |
| No mapping lost on crash | `id_map` is written **before** the checkpoint advances — a crash can only repeat work |
| Parents before children | FK graph from `information_schema`, topologically sorted; multi-table cycles throw loudly |
| Self-references | `employees.manager_id` is migrated without the self edge, then patched in a second pass |
| No orphan graph | a parent missing from `id_map` is a hard per-row failure, never a silent skip |
| Failure isolation | one bad row goes to `migration_meta.failures`; the batch continues |
| Rate-limit safety | bounded worker pool (`CONCURRENCY`) + exponential backoff with jitter, honours `Retry-After` |
| Backpressure | `BATCH_SIZE`, `UPLOAD_CHUNK`, `BATCH_DELAY_MS` — point `DATABASE_URL` at a read replica when you have one |
| Schema drift | the transformer validates expected columns per batch and fails fast instead of rendering blanks |
| Verified ingestion | `verify_processing` is polled to a terminal state before rows are accepted (`VERIFY=false` to skip) |

## HydraDB API assumptions

The client is deliberately thin. It sends:

- `POST {HYDRA_KNOWLEDGE_PATH}` → `{ documents: [...], upsert: true }`
- `POST {HYDRA_MEMORY_PATH}` → `{ memories: [...], upsert: true }`
- `GET  {HYDRA_VERIFY_PATH}?job_id=…` → terminal `status` of `completed` / `errored`

All three paths are env-configurable, and a job id is read from `job_id`, `jobId` or `id`.
If your deployment differs, `src/hydra.ts` is the single file to adjust.

## Layout

```
sql/schema.sql     checkpoints · id_map · failures
src/config.ts      env loading and tunables
src/db.ts          introspection, FK graph, keyset extraction, bookkeeping I/O
src/hydra.ts       HTTP client: retry, backoff, verify, bounded-concurrency map
src/mapping.ts     ← edit this: templates, targets, relation labels
src/migrate.ts     the engine: prepare → load → verify → commit, plus self-ref and re-drive passes
src/index.ts       CLI
```

## Next: incremental sync

`--restart` gives you a cheap full re-sync (hash skipping means only changed rows are uploaded),
which is enough for periodic catch-up. For continuous sync, attach a Supabase logical replication
slot and feed changes through the same `prepare` → `load` path in `src/migrate.ts`; deletes map to a
HydraDB delete/deprecate call. Nothing else needs to change.
