#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { assertConfig, config } from './config.ts';
import {
  applySchema,
  countRows,
  explainConnectionError,
  openFailures,
  recentFailures,
  planTables,
  pool,
  progress,
  syncState,
} from './db.ts';
import {
  assertDatabaseReady,
  createDatabase,
  databaseSnapshot,
  describeSnapshot,
  waitForDatabaseReady,
} from './hydra.ts';
import { METADATA_SCHEMA } from './mapping.ts';
import { migrate, redrive, sync, watch } from './migrate.ts';

const USAGE = `pg2hydra — Postgres -> HydraDB migration engine

Usage
  pg2hydra bootstrap            Create the HydraDB database and wait until it is ready
  pg2hydra init                 Create the migration_meta bookkeeping schema
  pg2hydra plan                 Print the FK-ordered table plan
  pg2hydra migrate [options]    Run the backfill (resumable, idempotent)
  pg2hydra sync [options]       Incremental pass: changed rows + deletes
  pg2hydra redrive [options]    Retry dead-lettered rows
  pg2hydra status               Per-table progress, sync watermarks, open failures
  pg2hydra failures             Show recent failures with their error messages

Options
  -t, --table <name>   Restrict to a table (repeatable). Default: TABLES env or all
      --dry-run        Extract + transform only, no writes
      --restart        Reset checkpoints and re-scan (content hashes skip unchanged rows)
      --watch          (sync) Keep running every SYNC_INTERVAL_SECONDS
      --no-wait        (bootstrap) Create the database and exit without polling
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      table: { type: 'string', short: 't', multiple: true },
      'dry-run': { type: 'boolean', default: false },
      restart: { type: 'boolean', default: false },
      watch: { type: 'boolean', default: false },
      'no-wait': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const command = positionals[0] ?? 'help';
  const tables = (values.table ?? []).flatMap((t) => t.split(',')).map((t) => t.trim()).filter(Boolean);

  if (values.help || command === 'help') {
    console.log(USAGE);
    return;
  }

  switch (command) {
    case 'bootstrap': {
      assertConfig();
      const existing = await databaseSnapshot();
      if (existing.ready) {
        console.log(`HydraDB database "${config.hydra.database}" is already ready for ingestion`);
        break;
      }
      if (existing.missing) {
        await createDatabase(METADATA_SCHEMA);
        console.log(`HydraDB database "${config.hydra.database}" requested`);
      }
      if (values['no-wait']) {
        console.log('not waiting (--no-wait)');
        break;
      }
      console.log(
        `waiting up to ${Math.round(config.bootstrapTimeoutMs / 1000)}s, polling every ${Math.round(config.bootstrapPollMs / 1000)}s`,
      );
      const snapshot = await waitForDatabaseReady(config.bootstrapTimeoutMs, (poll, elapsed) => {
        console.log(`  [${String(Math.round(elapsed / 1000)).padStart(4)}s] ${describeSnapshot(poll)}`);
      });
      if (!snapshot.ready) {
        console.error(`\nstill not ready after ${Math.round(config.bootstrapTimeoutMs / 1000)}s.`);
        console.error(`last status: ${JSON.stringify(snapshot.raw)}`);
        throw new Error(
          'database did not become ready. Raise BOOTSTRAP_TIMEOUT_MS, or run migrate with HYDRA_SKIP_PREFLIGHT=true to try ingesting anyway.',
        );
      }
      console.log('database ready for ingestion');
      break;
    }

    case 'init': {
      assertConfig(false);
      await applySchema();
      console.log('migration_meta schema ready');
      break;
    }

    case 'plan': {
      assertConfig(false);
      const { metas, order } = await planTables(tables);
      for (const [index, table] of order.entries()) {
        const meta = metas.get(table);
        const parents = meta?.fks.map((fk) => `${fk.column}->${fk.parentTable}`) ?? [];
        console.log(
          `${String(index + 1).padStart(3)}. ${table}  pk=${meta?.pk || '(none)'}` +
            (parents.length ? `  fks: ${parents.join(', ')}` : ''),
        );
      }
      break;
    }

    case 'migrate': {
      assertConfig();
      await assertDatabaseReady();
      await migrate({ tables, dryRun: values['dry-run'], restart: values.restart });
      break;
    }

    case 'sync': {
      assertConfig();
      await assertDatabaseReady();
      const options = { tables, dryRun: values['dry-run'] };
      if (values.watch) await watch(options);
      else await sync(options);
      break;
    }

    case 'redrive': {
      assertConfig();
      await assertDatabaseReady();
      await redrive(tables);
      break;
    }

    case 'failures': {
      assertConfig(false);
      const rows = await recentFailures(20);
      if (!rows.length) console.log('no open failures');
      for (const row of rows) {
        console.log(
          `\n${row.source_table} [${row.stage}]${row.source_pk ? ` pk=${row.source_pk}` : ''} ${row.failed_at.toISOString()}`,
        );
        console.log(row.error);
      }
      break;
    }

    case 'status': {
      assertConfig(false);
      const rows = await progress();
      if (!rows.length) console.log('no checkpoints yet');
      for (const row of rows) {
        const total = await countRows(row.source_table);
        const done = Number(row.rows_done);
        const percent = total ? Math.min(100, Math.round((done / total) * 100)) : 100;
        console.log(
          `${row.source_table.padEnd(28)} ${String(done).padStart(9)}/${String(total).padEnd(9)} ` +
            `${String(percent).padStart(3)}%  last_pk=${row.last_pk}` +
            (row.finished_at ? '  [finished]' : ''),
        );
      }
      const watermarks = await syncState();
      if (watermarks.length) {
        console.log('\nSync watermarks:');
        for (const w of watermarks) {
          console.log(
            `  ${w.source_table.padEnd(28)} ${(w.watermark_column ?? 'full re-scan').padEnd(14)} ` +
              `synced through ${w.last_synced_at?.toISOString() ?? '—'}`,
          );
        }
      }

      const failures = await openFailures();
      if (failures.length) {
        console.log('\nOpen failures:');
        for (const f of failures) console.log(`  ${f.source_table} [${f.stage}] ${f.n}`);
        console.log('Re-drive with: pg2hydra redrive');
      }
      break;
    }

    default:
      console.error(`Unknown command "${command}"\n`);
      console.log(USAGE);
      process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    const explanation = explainConnectionError(err);
    console.error(`\nx ${err instanceof Error ? err.message : String(err)}`);
    if (explanation) console.error(`\n${explanation}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (config.databaseUrl) await pool.end().catch(() => {});
  });
