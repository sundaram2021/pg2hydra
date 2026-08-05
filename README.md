# pg2hydra

Deterministic, resumable, foreign-key-aware migration engine from **Supabase Postgres → HydraDB**.

No LLM in the critical path. Every row becomes the same document every time: templates in, documents out.
Foreign keys become explicit HydraDB `relations` — no inference, no extraction step.

```
plan → extract → transform → load → verify
 FK     keyset     template     batched   /context/status
 order  paging     + relations  upsert    polled to terminal
                       │
        migration_meta.*  (checkpoints · id_map · sync_state · failures)
```

## Install

```bash
npm install
cp .env.example .env    # fill in DATABASE_URL, HYDRA_DB_API_KEY, HYDRA_DATABASE
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

Then keep it current:

```bash
node src/index.ts sync                       # one incremental pass: changed rows + deletes
node src/index.ts sync --watch               # keep syncing every SYNC_INTERVAL_SECONDS
node src/index.ts sync --dry-run -t orders   # see what a pass would change
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
  "title": "Order #5001",
  "type": "orders",
  "kind": "record",
  "provider": "postgres",
  "external_id": "5001",
  "content": { "text": "Order #5001: 3 items, status shipped, placed 2026-01-02" },
  "metadata": { "status": "shipped" },
  "additional_metadata": { "table": "orders", "source_pk": "5001" },
  "relations": {
    "hydradb_source_ids": ["customers_120"],
    "properties": { "relation": "belongs_to_customer" }
  }
}
```

It is sent as one item of the `app_knowledge` array on `POST /context/ingest` (multipart —
HydraDB rejects a JSON body with 415). `metadata` carries only fields you declared in the
database metadata schema, so it stays on the fast pre-filtered query path; engine bookkeeping
goes to the free-form `additional_metadata`. Memory rows take the same shape via the `memories`
array, with `infer: false` so a stored fact is never re-interpreted.

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
| Rate-limit safety | bounded worker pool (`CONCURRENCY`) + exponential backoff with jitter, honours `Retry-After`; 400/413/415/422 fail fast instead of retrying |
| Backpressure | `BATCH_SIZE`, `UPLOAD_CHUNK`, `BATCH_DELAY_MS` — point `DATABASE_URL` at a read replica when you have one |
| Schema drift | the transformer validates expected columns per batch and fails fast instead of rendering blanks |
| Verified ingestion | `GET /context/status` is polled per source id to a terminal state before rows are accepted (`VERIFY=false` to skip) |
| Batch limits respected | `UPLOAD_CHUNK` is capped at HydraDB's documented 20 sources per ingest request, paced by `REQUEST_DELAY_MS` |
| Incremental | `sync` watermarks on a timestamp column and re-ingests only what moved |
| Deletes propagate | rows in `id_map` with no surviving source row are deleted from HydraDB, children before parents |

## Layout

```
sql/schema.sql     checkpoints · id_map · sync_state · failures
src/config.ts      env loading and tunables
src/db.ts          introspection, FK graph, keyset extraction, bookkeeping I/O
src/hydra.ts       HydraDB v2 client: multipart ingest, status polling, delete, retry/backoff
src/mapping.ts     ← edit this: templates, targets, relation labels, watermark columns
src/migrate.ts     the engine: prepare → load → verify → commit, plus self-ref, sync and re-drive passes
src/index.ts       CLI
```

## Incremental sync

`sync` is the steady-state counterpart to `migrate`. Per table it:

1. Picks a watermark column — `updatedAtColumn` from `src/mapping.ts`, else the first of
   `updated_at` / `modified_at` / `updatedAt` / `last_modified` / `created_at` that exists.
   Tables with none fall back to a full keyset re-scan, where content hashing keeps the cost at
   "read the rows" — unchanged rows never reach the network.
2. Reads everything newer than `last_synced_at` minus `SYNC_OVERLAP_SECONDS`, so rows committed
   slightly out of clock order aren't stepped over.
3. Runs the same `prepare → load → verify → commit` path as the backfill — same templates, same
   deterministic ids, same upsert. Self-referencing edges are included, since every row already
   exists in `id_map` by this point.
4. Advances `migration_meta.sync_state.last_synced_at` to the highest timestamp it actually saw,
   never to wall-clock time.
5. Reconciles deletes: ids in `id_map` whose source row is gone are removed from HydraDB
   (`DELETE /context` with `X-HydraDB-Delete-Status: strict`) and dropped from `id_map`. Children
   are processed before parents so no edge is left pointing at a deleted node. Turn off with
   `SYNC_DELETES=false`.

`sync --watch` loops at `SYNC_INTERVAL_SECONDS`; a failed pass is logged and the next one still runs.
Run it as a long-lived process or drop the one-shot `sync` into cron — the watermark makes both safe.
