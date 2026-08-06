# pg2hydra

Migration engine that turns a PostgreSQL database into agent-ready context in [HydraDB](https://hydradb.com).

The output is written to be read by an AI agent, not by a parser. Every record becomes one clean line of prose that names its entity, its fields, and the entities it points at. No JSON envelopes, no escaped quotes, no duplicated payloads.

## The three layers

HydraDB stores knowledge, memories, and episodes. Each table is routed to the layer that fits it:

| Layer         | What goes there                                                       | How it is stored                                                            |
| ------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| **Ontology**  | every table and view                                                  | one knowledge document describing columns, keys, and relationships in prose |
| **Knowledge** | reference and lookup tables                                           | records packed into knowledge documents                                     |
| **Episodes**  | tables with a timestamp column                                        | records ordered oldest-first, each stamped with its event time              |
| **Memories**  | person-like tables (`users`, `customers`, or a table with an `email`) | one memory per entity, in its own collection (`customers:7`)                |

Routing is automatic and overridable with `MEMORY_TABLES` and `EPISODE_TABLES`.

## What the agent actually reads

Ontology:

```
# public.orders

public.orders is a PostgreSQL table holding 120 rows. Each row is identified by id.
Its rows are stored in HydraDB as time-ordered episodes.

## Columns
- id (integer) - primary key, required, auto-generated.
- customer_id (integer) - references public.customers.id, required.
- status (text) - required, defaults to pending.

## Relationships
- Each orders row belongs to one public.customers row, linked by orders.customer_id to public.customers.id.
- Each orders row can have many public.order_items rows, linked by public.order_items.order_id.
```

Episodes, chronological:

```
On 2026-08-01 14:46:01Z, orders/120 was recorded with customer_id: 1; status: pending. Belongs to customers/1.
```

Knowledge records, one line each:

```
products/1 - sku: SKU-0001; name: Nimbus Headphones v1; price_cents: 10037; category_id: 4. Belongs to categories/4.
product_tags/1-2 links products/1 and tags/2.
```

Memories, one per entity in its own collection:

```
customers/1 is a customer in the public dataset. Known details: email: user1@example.com; full_name: Bruno Costa 1; country: BR.
```

Null columns are omitted rather than rendered as `null`, values are whitespace-normalised, and long values are truncated, so nothing arrives as noise.

## Why documents, not app records

The `app_knowledge` ingest path stores the JSON of the whole wire record and indexes _that_ as the searchable text. Retrieval then returns chunks that begin:

```
{"id":"pg::public.orders::rows::00001","tenant_id":"...","content":{"text":"","html_base64":"","csv_base64":"","markdown":"# public.orders\n\n...
```

That is plumbing, escaped quotes, and empty fields eating an agent's context window. The engine uploads real markdown documents instead, so the stored text is exactly the text above and nothing else. A cleanliness assertion in the verify step fails the run if envelope keys or escaped quotes reappear in retrieved chunks.

## Batching

Documents are packed to a byte budget (`DOC_TARGET_BYTES`, 24 KB), never by row count, and a record is never split across documents. A 4-column table and a 40-column table therefore produce consistently sized documents, and chunk boundaries always fall between records.

## Graph formation

Two kinds of edges are written:

1. **Declared relations** — every document carries `relations.ids` linking it to its table's ontology document and to the ontology of every table it references. The ingest response reports the count, logged as `graph edges N`.
2. **Extractable triplets** — each line names both endpoints (`orders/99 ... Belongs to customers/20`), so HydraDB's graph phase has explicit subject-predicate-object text to work from.

Retrieval uses `mode: "thinking"` with `graph_context: true`, which is what activates relation expansion.

## Run it

```bash
pnpm install
pnpm db:up          # postgres + demo schema on :5432
cp .env.example .env
pnpm migrate:dry    # introspect and render only, writes ./out
pnpm migrate        # migrate to HydraDB
```

`pnpm migrate:dry` needs no HydraDB key and writes exactly the text that would be uploaded, so you can read it before sending anything.

The demo schema covers every relationship type: `customers → orders → order_items` (one-to-many), `order_items` and `product_tags` (composite keys, many-to-many), `categories.parent_id` (self reference), and `order_summary` (view).

## Configuration

| Variable                           | Default                                               | Purpose                                          |
| ---------------------------------- | ----------------------------------------------------- | ------------------------------------------------ |
| `DATABASE_URL`                     | `postgresql://postgres:postgres@localhost:5432/appdb` | source database                                  |
| `PG_SCHEMA`                        | `public`                                              | schema to migrate                                |
| `TABLES` / `SKIP_TABLES`           | empty                                                 | restrict the run                                 |
| `HYDRA_DB_API_KEY`                 | —                                                     | required for a live migration                    |
| `HYDRA_DATABASE`                   | `pg2hydra_demo`                                       | target HydraDB database                          |
| `MEMORY_TABLES` / `EPISODE_TABLES` | empty                                                 | override automatic layer routing                 |
| `MIGRATE_MEMORIES`                 | `true`                                                | write per-entity memories                        |
| `BATCH_SIZE`                       | `1000`                                                | rows read from Postgres per query                |
| `DOC_TARGET_BYTES`                 | `24000`                                               | target size of one uploaded document             |
| `UPLOAD_CHUNK`                     | `20`                                                  | documents per ingest request                     |
| `CONCURRENCY`                      | `2`                                                   | parallel ingest requests                         |
| `DECLARE_METADATA_SCHEMA`          | `false`                                               | declare filterable metadata at database creation |
| `WAIT_FOR_GRAPH`                   | `false`                                               | wait for `completed` instead of `graph_creation` |
| `VERIFY`                           | `true`                                                | query and cleanliness check after migrating      |

Migration is idempotent: IDs are derived from schema, table, layer, and batch index, and every ingest uses `upsert: true`.

## Layout

```
src/
  config.ts              env parsing
  classify.ts            routes each table to knowledge, episodes, or memories
  types.ts               shared types
  pg/                    pool, introspection, relationships, batched reads
  transform/
    text.ts              value cleaning, null omission, truncation
    ontology.ts          table definition documents
    records.ts           record, episode, and memory lines
    pack.ts              byte-budget packing, never splits a record
    source.ts            ontology documents and memory items
  hydra/
    client.ts            provisioning, failure detection, indexing status
    upload.ts            multipart document ingest
    memories.ts          per-collection memory ingest
    verify.ts            retrieval, cleanliness assertion, stats
  index.ts               orchestrator
```

## Notes on the HydraDB API

Two behaviours worth knowing, both observed against the live API:

- **Do not declare `database_metadata_schema` at creation.** Databases created with it report ready, then flip to a permanently failed state (`cancel in-flight ingestion workflows: context deadline exceeded`). Databases created without it stay healthy. `DECLARE_METADATA_SCHEMA` is therefore `false` by default, and the `pg_*` fields are sent as free-form `additional_metadata`, filterable via `metadata_filters.additional_metadata`. `ensureDatabase` also checks `failed_databases` and fails immediately instead of polling a dead database for five minutes.
- **`graph_creation` can persist.** Sources are fully searchable in that state and declared relations are accepted at ingest, but `GET /context/relations` only publishes triplets once a source reaches `completed`, which did not happen within an hour in testing. `WAIT_FOR_GRAPH` stays `false` so runs do not block on it.
