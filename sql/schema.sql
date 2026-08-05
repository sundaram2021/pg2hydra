CREATE SCHEMA IF NOT EXISTS migration_meta;

CREATE TABLE IF NOT EXISTS migration_meta.checkpoints (
  source_table text PRIMARY KEY,
  last_pk      text NOT NULL,
  rows_done    bigint NOT NULL DEFAULT 0,
  finished_at  timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS migration_meta.id_map (
  source_table    text NOT NULL,
  source_pk       text NOT NULL,
  hydra_source_id text NOT NULL,
  content_hash    text NOT NULL,
  migrated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (source_table, source_pk)
);

CREATE TABLE IF NOT EXISTS migration_meta.sync_state (
  source_table    text PRIMARY KEY,
  watermark_column text,
  last_synced_at  timestamptz,
  last_run_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS migration_meta.failures (
  id           bigserial PRIMARY KEY,
  source_table text NOT NULL,
  source_pk    text,
  stage        text NOT NULL,
  error        text NOT NULL,
  payload      jsonb,
  resolved     boolean NOT NULL DEFAULT false,
  failed_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS failures_open_idx
  ON migration_meta.failures (source_table) WHERE NOT resolved;
