# pg2hydra

Migrates a PostgreSQL database into [HydraDB](https://hydradb.com) as context an AI agent can read.

Tables, rows and foreign keys become plain-language documents. One line per row, naming the record, its fields and the records it points at:

```
products/1 - sku: SKU-0001; name: Nimbus Headphones v1; price_cents: 10037; category_id: 4. Belongs to categories/4.
On 2026-08-01 14:46:01Z, orders/120 was recorded with customer_id: 1; status: pending. Belongs to customers/1.
product_tags/1-2 links products/1 and tags/2.
```

## Architecture

```
Postgres ──► introspect ──► classify ──► render ──► pack ──► upload ──► HydraDB
             tables          layer       prose      byte      markdown
             columns         per          lines     budget    documents
             keys, FKs       table                            + memories
```

**introspect** reads tables, views, columns, primary and unique keys, and foreign keys, deriving one-to-many, many-to-one, many-to-many and self references.

**classify** routes each table to the HydraDB primitive that fits it:

| Layer      | Table                                                               | Stored as                                                    |
| ---------- | ------------------------------------------------------------------- | ------------------------------------------------------------ |
| Definition | every table and view                                                | one document describing columns, keys and relationships      |
| Knowledge  | reference tables                                                    | record lines packed into documents                           |
| Episodes   | tables with a timestamp column                                      | record lines ordered oldest first, stamped with event time   |
| Memories   | person-like tables (`users`, `customers`, anything with an `email`) | one memory per entity, in its own collection (`customers:7`) |

Automatic, and overridable with `MEMORY_TABLES` / `EPISODE_TABLES`.

**render** turns each row into one line. Null columns are omitted, whitespace is normalised, long values are truncated.

**pack** groups lines into documents up to `DOC_TARGET_BYTES` (24 KB), never splitting a record, so documents stay a consistent size whether a table is narrow or wide.

**upload** sends real markdown documents to `POST /context/ingest`. Each one declares `relations.ids` pointing at its own table definition and those of the tables it references, which is what forms the graph. Rows stream batch by batch, so memory use stays flat regardless of table size.

Source IDs are derived from schema, table, layer and batch index, and every ingest uses `upsert: true`, so re-running updates in place instead of duplicating.

## Project structure

```
src/
  index.ts               orchestrator
  config.ts              env parsing
  classify.ts            routes tables to knowledge, episodes or memories
  types.ts               shared types
  pg/
    client.ts            connection pool
    introspect.ts        tables, columns, keys, views
    relations.ts         foreign keys and cardinality
    rows.ts              batched reads
  transform/
    text.ts              value cleaning
    ontology.ts          table definition documents
    records.ts           record, episode and memory lines
    pack.ts              byte-budget packing
    source.ts            document and memory payloads
  hydra/
    client.ts            provisioning and indexing status
    upload.ts            document ingest
    memories.ts          memory ingest
    verify.ts            post-migration checks
scripts/seed.sql         demo schema and data
docker-compose.yml       local Postgres
```

## Local setup

Requires Node 24+, pnpm and Docker.

```bash
pnpm install
pnpm db:up                  # Postgres with the demo schema on :5432
cp .env.example .env        # add your HYDRA_DB_API_KEY
pnpm migrate:dry            # render only, writes ./out
pnpm migrate                # migrate to HydraDB
```

`pnpm migrate:dry` needs no API key. It writes exactly the text that would be uploaded to `./out`, so you can read it first.

The demo schema covers every relationship type: `customers → orders → order_items`, composite keys on `order_items` and `product_tags`, a many-to-many through `product_tags`, a self reference on `categories.parent_id`, and an `order_summary` view.

Other scripts: `pnpm build`, `pnpm typecheck`, `pnpm format`, `pnpm db:down`.

## Notes

- Create HydraDB databases without a metadata schema. Declaring `database_metadata_schema` at creation caused databases to report ready and then fail permanently, so `DECLARE_METADATA_SCHEMA` defaults to `false` and the `pg_*` fields ship as `additional_metadata`.
- Sources become searchable at `graph_creation` and reach `completed` when the graph pass finishes. `WAIT_FOR_GRAPH=false` means the run does not block on that phase.
- This is a full-copy migration. There is no incremental sync and no delete propagation yet, and rows are paged without a snapshot, so migrate from a quiet or static database.
