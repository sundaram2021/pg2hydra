# pg2hydra

Migration engine that turns a PostgreSQL database into an agent-ready context graph in [HydraDB](https://hydradb.com).

Every table becomes one **table object** carrying its keys and relationships at the top level. Every row is JSON-stringified and nested inside batched row documents that point back at that object. HydraDB indexes both and builds the context graph from them.

## How the mapping works

| PostgreSQL                  | HydraDB                                             |
| --------------------------- | --------------------------------------------------- |
| table / view                | one knowledge source `pg::<schema>.<table>::object` |
| rows                        | batched sources `pg::<schema>.<table>::rows::00000` |
| primary key / composite key | top-level `primary_key`, `composite_key`            |
| foreign key                 | `relations.many_to_one` + `relations.one_to_many`   |
| junction table              | `relations.many_to_many`, `junction: true`          |
| self reference              | `self_referencing: true`                            |
| view                        | `kind: "view"` + `view_definition`                  |

A table object looks like this:

```json
{
  "id": "pg::public.order_items::object",
  "qualified_name": "public.order_items",
  "kind": "table",
  "primary_key": ["order_id", "product_id"],
  "composite_key": true,
  "columns": [
    { "name": "order_id", "data_type": "integer", "nullable": false }
  ],
  "relations": {
    "many_to_one": [
      { "columns": ["order_id"], "references_table": "public.orders" }
    ],
    "one_to_many": [],
    "many_to_many": [
      { "through": "public.order_items", "target_table": "public.products" }
    ],
    "junction": true
  },
  "related_tables": ["public.orders", "public.products"],
  "row_count": 348
}
```

Each row batch renders one entry per row, so the graph extractor sees both the literal record and the edge it participates in:

```
## order_items/1-2
{"order_id":1,"product_id":2,"quantity":2,"unit_cents":9901}
order_id: 1; product_id: 2; quantity: 2; unit_cents: 9901
order_items/1-2 belongs to orders/1 via order_id. order_items/1-2 belongs to products/2 via product_id.
```

## Graph formation

Two layers of edges are written, so the graph is explicit rather than inferred from embeddings alone:

1. **Forceful relations** — every source declares `relations.ids`. Table objects link to the objects of the tables they reference; row batches link to their own table object and its neighbours. The ingest response reports how many edges were created (`graph edges N` in the logs).
2. **Entity triplets** — the rendered text states each relationship in natural language, which HydraDB's graph extraction turns into entity/relation triplets during its `graph_creation` phase.

Retrieval uses `mode: "thinking"` with `graph_context: true`, which is what activates forceful-relation expansion.

## Run it

```bash
pnpm install
pnpm db:up          # postgres + demo schema on :5432
cp .env.example .env
pnpm migrate:dry    # introspect only, writes ./out
pnpm migrate        # migrate to HydraDB
```

`pnpm migrate:dry` needs no HydraDB key. It writes every table object and a row sample to `./out` so you can inspect the mapping before sending anything.

The demo schema in `scripts/seed.sql` covers every relationship type on purpose: `customers → orders → order_items` (one-to-many), `order_items` and `product_tags` (composite primary keys and many-to-many), `categories.parent_id` (self reference), and `order_summary` (view).

## Configuration

| Variable                 | Default                                               | Purpose                                          |
| ------------------------ | ----------------------------------------------------- | ------------------------------------------------ |
| `DATABASE_URL`           | `postgresql://postgres:postgres@localhost:5432/appdb` | source database                                  |
| `PG_SCHEMA`              | `public`                                              | schema to migrate                                |
| `TABLES` / `SKIP_TABLES` | empty                                                 | restrict the run                                 |
| `HYDRA_DB_API_KEY`       | —                                                     | required for a live migration                    |
| `HYDRA_DATABASE`         | `pg2hydra_demo`                                       | target HydraDB database                          |
| `HYDRA_COLLECTION`       | empty                                                 | optional collection scope                        |
| `BATCH_SIZE`             | `1000`                                                | rows read per batch, one batch is one source     |
| `UPLOAD_CHUNK`           | `20`                                                  | sources per ingest request                       |
| `CONCURRENCY`            | `2`                                                   | parallel ingest requests                         |
| `MAX_RETRIES`            | `6`                                                   | retries with exponential backoff                 |
| `VERIFY`                 | `true`                                                | run a query and graph check after migrating      |
| `WAIT_FOR_GRAPH`         | `false`                                               | wait for `completed` instead of `graph_creation` |

Migration is idempotent: source IDs are derived from schema, table, and batch index, and every ingest uses `upsert: true`. Re-running updates in place instead of duplicating.

Rows are streamed batch by batch and flushed as soon as `UPLOAD_CHUNK × CONCURRENCY` sources are buffered, so memory stays flat regardless of table size.

## Layout

```
src/
  config.ts            env parsing
  types.ts             shared types
  pg/
    client.ts          pool and identifier quoting
    introspect.ts      tables, columns, primary and unique keys, views
    relations.ts       foreign keys, cardinality, junction detection
    rows.ts            batched row reader
  transform/
    value.ts           postgres value normalisation
    render.ts          table object and row batch rendering
    source.ts          HydraDB source payloads and graph edges
  hydra/
    client.ts          database provisioning and indexing status
    ingest.ts          chunked, concurrent, retrying upload
    verify.ts          post-migration query and graph check
  index.ts             orchestrator
```

## Notes

- `graph_creation` is an intermediate state. Sources are fully queryable in it, and forceful relations are already written at ingest, but `GET /context/relations` only reports triplets once a source reaches `completed`. In testing, sources stayed in `graph_creation` for well over half an hour, so `WAIT_FOR_GRAPH` defaults to `false`. Turn it on only if your account's graph phase is finishing promptly, otherwise the run will block.
- `.env` in this repo contains a real API key. Rotate it and untrack the file: `git rm --cached .env`.
