-- pg2hydra migration bookkeeping. Lives in the SOURCE database so progress and
-- the source_pk -> hydra id mapping are transactionally close to the data.
-- Applied by: pg2hydra init

CREATE SCHEMA IF NOT EXISTS migration_meta;

-- One row per table: how far the keyset scan has advanced.
CREATE TABLE IF NOT EXISTS migration_meta.checkpoints (
  source_table text PRIMARY KEY,
  last_pk      text NOT NULL,
  rows_done    bigint NOT NULL DEFAULT 0,
  finished_at  timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- source row -> HydraDB object. Doubles as the FK resolver: a child row's
-- relations are built by looking its parents up here.
CREATE TABLE IF NOT EXISTS migration_meta.id_map (
  source_table    text NOT NULL,
  source_pk       text NOT NULL,
  hydra_source_id text NOT NULL,
  content_hash    text NOT NULL,
  migrated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_table, source_pk)
);

-- Rows that failed transform or load. Re-drivable without touching the checkpoint.
CREATE TABLE IF NOT EXISTS migration_meta.failures (
  id           bigserial PRIMARY KEY,
  source_table text NOT NULL,
  source_pk    text,
  stage        text NOT NULL,        -- transform | load | verify
  error        text NOT NULL,
  payload      jsonb,
  resolved     boolean NOT NULL DEFAULT false,
  failed_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS failures_open_idx
  ON migration_meta.failures (source_table) WHERE NOT resolved;
