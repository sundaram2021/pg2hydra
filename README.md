# pg2hydra

Deterministic, resumable, foreign-key-aware migration engine from **PostgreSQL → HydraDB**
(`hydradb.com`, the AI context platform — not the columnar Postgres fork).

This is not a like-for-like migration. PostgreSQL is relational OLTP; HydraDB is a context
graph for agents. Rows become **Knowledge** or **Memory** sources, and foreign keys become
explicit graph **relations**. No LLM sits in the critical path: templates in, sources out,
so the same row always produces the same document.

```
plan → extract → transform → load → verify
 FK     keyset     template    SDK      /context/status
 order  paging     + relations ingest   polled to terminal
                       │
        migration_meta.*  (checkpoints · id_map · sync_state · failures)
```

## Quickstart

```bash
npm install
docker compose up -d                     # Postgres 16 seeded with sample relational data
cp .env.example .env                     # set HYDRA_DB_API_KEY and HYDRA_DATABASE

node src/index.ts bootstrap              # create the HydraDB database, wait until ready
node src/index.ts init                   # create the migration_meta bookkeeping schema
node src/index.ts plan                   # show the FK-ordered table plan
node src/index.ts migrate                # backfill
node src/index.ts status                 # progress, watermarks, failures
```

The seed schema (`sql/seed.sql`) is deliberately shaped to exercise the engine: parent/child
FKs, a junction table, a self-referencing `employees.manager_id`, a per-user table that maps
to Memories, and an `audit_log` that is skipped.

`bootstrap` must run before the first migrate. HydraDB provisions a database asynchronously,
so it calls `databases.create` (tolerating 409 if it already exists) and then polls
`databases.status` until `infra.readyForIngestion` is true.

Then keep it current:

```bash
node src/index.ts sync                   # one incremental pass: changed rows + deletes
node src/index.ts sync --watch           # keep syncing every SYNC_INTERVAL_SECONDS
node src/index.ts migrate --dry-run      # extract + transform only, no writes
node src/index.ts redrive                # retry dead-lettered rows
```

Stop it at any point — `Ctrl+C`, crash, deploy — and re-run. It resumes from the last
checkpoint, and rows whose content hash is unchanged are never re-uploaded.

## Layer 2: Relational-to-Graph Mapper

PostgreSQL has rows and foreign keys; HydraDB has sources, metadata and relations. This layer
is the whole translation, and it lives in `src/mapping.ts` plus the transform half of
`src/migrate.ts`.

```
┌─────────────────────────────────────────────────────────────┐
│  Schema-to-Graph Transformer                                │
├─────────────────────────────────────────────────────────────┤
│  1. Entity Extraction                                       │
│     • Primary key → deterministic source id {table}_{pk}    │
│     • Table classified as knowledge | memory | skip         │
│                                                             │
│  2. Relationship Extraction                                 │
│     • Foreign keys → relations.hydradb_source_ids           │
│     • Edge label carried in relations.properties            │
│     • Junction tables → a source holding both edges         │
│     • Self-references → patched in a second pass            │
│                                                             │
│  3. Content Rendering                                       │
│     • Row → one source (row-per-chunk)                      │
│     • Template per table, generic col: value fallback       │
│     • FK columns omitted from prose — they are edges        │
│                                                             │
│  4. Metadata Schema Designer                                │
│     • METADATA_SCHEMA declares filterable fields            │
│     • Declared at database creation, enable_match: true     │
│     • Bookkeeping goes to free-form additional_metadata     │
└─────────────────────────────────────────────────────────────┘
```

Table classification and templates:

```ts
export const TABLES = {
  customers: {
    target: 'knowledge',
    text: (r) => `Customer ${r.name} (${r.email}), ${r.tier} tier`,
    metadata: (r) => ({ tier: r.tier }),
  },
  user_preferences: {
    target: 'memory',
    userIdColumn: 'user_id',
    text: (r) => `User preference: ${r.key} = ${r.value}`,
  },
  audit_log: { target: 'skip' },
};

export const RELATION_LABELS = {
  'orders.customer_id': 'belongs_to_customer',
  'employees.manager_id': 'reports_to',
};

export const METADATA_SCHEMA = [
  { name: 'tier', dataType: 'VARCHAR', maxLength: 64, enableMatch: true },
];
```

Anything you don't list still migrates: the generic renderer emits `col: value` pairs and
edges default to `references_<parent>`. A row becomes:

```json
{
  "id": "orders_5001",
  "title": "Order #5001",
  "type": "orders",
  "kind": "record",
  "provider": "postgres",
  "external_id": "5001",
  "content": { "text": "Order #5001: 3 items totalling 478, status shipped" },
  "metadata": { "status": "shipped" },
  "additional_metadata": { "table": "orders", "source_pk": "5001" },
  "relations": {
    "hydradb_source_ids": ["customers_120"],
    "properties": { "relation": "belongs_to_customer" }
  }
}
```

`metadata` carries only fields declared in `METADATA_SCHEMA`, keeping them on the fast
pre-filtered query path; engine bookkeeping goes to `additional_metadata`. Memory rows take
the same shape with `infer: false`, so a stored fact is never re-interpreted. Ids are
`{table}_{pk}` — stable and recomputable from the row alone, which is what makes every write
an idempotent upsert.

Because forceful relations live within one store, an FK that crosses the knowledge/memory
boundary is dropped with a warning rather than written as a dangling edge.

## Layer 3: Streaming Ingestion Pipeline

HydraDB ingestion is asynchronous. The engine treats it as a queue, never as an INSERT.

```
┌─────────────────────────────────────────────────────────────┐
│  Ingestion Orchestrator                                     │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  PostgreSQL ──► [Keyset Extractor] ──► [Transformer]        │
│                      │                      │               │
│                 checkpoints             id_map lookup       │
│                 last_pk                 (FK → source id)    │
│                                             │               │
│                                             ▼               │
│                                    ┌─────────────────┐      │
│                                    │  content_hash   │      │
│                                    │  unchanged?     │──┐   │
│                                    │  skip entirely  │  │   │
│                                    └────────┬────────┘  │   │
│                                             │           │   │
│                                             ▼           │   │
│                                    ┌─────────────────┐  │   │
│                                    │ client.context  │  │   │
│                                    │ .ingest()       │  │   │
│                                    │ ≤20 per request │  │   │
│                                    │ CONCURRENCY     │  │   │
│                                    │ workers, paced  │  │   │
│                                    └────────┬────────┘  │   │
│                                             │           │   │
│                                             ▼           │   │
│                                    ┌─────────────────┐  │   │
│                                    │ client.context  │  │   │
│                                    │ .status()       │  │   │
│                                    │ poll by id →    │  │   │
│                                    │ completed |     │  │   │
│                                    │ graph_creation  │  │   │
│                                    │ | failed        │  │   │
│                                    └────────┬────────┘  │   │
│                                             │           │   │
│                     ┌───────────────────────┴───┐       │   │
│                     ▼                           ▼       │   │
│              ┌─────────────┐            ┌────────────┐  │   │
│              │  id_map     │◄───────────│  failures  │  │   │
│              │  + hash     │  accepted  │ dead-letter│  │   │
│              └──────┬──────┘            └────────────┘  │   │
│                     │                                   │   │
│                     ▼                                   │   │
│              checkpoint advances ◄──────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

Properties that fall out of this shape:

- **Backpressure.** `UPLOAD_CHUNK` is capped at HydraDB's documented 20 sources per request,
  `CONCURRENCY` bounds in-flight requests, and `REQUEST_DELAY_MS` paces them.
- **No fire-and-forget.** A batch is only accepted once `context.status` reports a terminal
  state per source id. Timeouts and failures dead-letter instead of being assumed good.
- **Crash safety.** `id_map` is written before the checkpoint advances, so a crash can only
  repeat work, never lose a mapping.
- **Failure isolation.** One bad row goes to `migration_meta.failures`; the batch continues.
  `redrive` retries them once the cause is fixed.
- **Incremental.** `sync` watermarks on a timestamp column (`updated_at`, `modified_at`,
  `created_at`, or one you name), reads past `last_synced_at` minus an overlap window, and
  reconciles deletes by finding `id_map` rows whose source row is gone — children first, so
  no edge is left pointing at a deleted node.

## Layout

```
docker-compose.yml  local Postgres 16
sql/seed.sql        sample relational data
sql/schema.sql      checkpoints · id_map · sync_state · failures
src/config.ts       env loading and tunables
src/db.ts           introspection, FK graph, keyset extraction, bookkeeping I/O
src/hydra.ts        @hydradb/sdk client: bootstrap, ingest, status, delete
src/mapping.ts      ← edit this: targets, templates, relation labels, metadata schema
src/migrate.ts      the engine: prepare → load → verify → commit, plus self-ref, sync, redrive
src/index.ts        CLI
```
