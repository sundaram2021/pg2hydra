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

For `DATABASE_URL`, use Supabase's **session pooler** string (Project Settings → Database →
Connection string → Session pooler):

```
postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres
```

The direct `db.<project-ref>.supabase.co` host resolves to IPv6 only, so it fails with
`connect ENETUNREACH` on GitHub Codespaces, most CI runners, and any network without IPv6.
The pooler has an IPv4 address and works everywhere.

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
