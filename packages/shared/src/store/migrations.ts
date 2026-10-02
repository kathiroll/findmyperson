import type { SqlDatabase, SqlExecutor } from './driver';

/**
 * Schema migrations for the on-device store (plan 4.6).
 *
 * The schema version is SQLite's `PRAGMA user_version`. It is readable in one statement before
 * any table exists, and it changes inside the same transaction as the schema, so the version
 * can never disagree with the tables.
 *
 * TypeScript owns migrations. The native capture module never creates or alters a table: on
 * open it reads `PRAGMA user_version` and, unless the value is one it was built for, it writes
 * nothing and reports a health problem. Its two write paths are fixed in
 * contracts/native-writer.json.
 *
 * A released migration is frozen. To change the schema, append a new migration; never edit an
 * old one. contracts/migration-v1.sql is a checked copy of version 1, and migrations.test.ts
 * fails if this file and that copy differ.
 *
 * Constraints follow one rule. Tables written only by TypeScript carry CHECK and UNIQUE
 * constraints for every invariant that can be stated as one. The two tables written natively
 * (`location_sample`, `stay`) carry none beyond NOT NULL: a failed constraint there would drop
 * a location fix in the background where nothing can report it.
 */
export interface Migration {
  /** The `user_version` the database has once this migration is applied. */
  version: number;
  name: string;
  /** One SQL statement per entry, run in order inside a single transaction. */
  statements: readonly string[];
}

export const MIGRATION_V1: Migration = {
  version: 1,
  name: 'initial schema',
  statements: [
    `-- Raw periodic location fixes. Written by the native capture module only.
CREATE TABLE location_sample (
  id          INTEGER PRIMARY KEY,
  ts_utc      INTEGER NOT NULL,  -- time of the fix, Unix seconds
  lat         REAL    NOT NULL,
  lon         REAL    NOT NULL,
  accuracy_m  REAL    NOT NULL,
  source      TEXT    NOT NULL,  -- SampleSource
  h3_r7       TEXT    NOT NULL,  -- res-7 cell of (lat, lon): matching pre-filter
  h3_r5       TEXT    NOT NULL   -- res-5 PARENT of h3_r7: subscription bookkeeping
)`,
    `CREATE INDEX ix_sample_ts ON location_sample(ts_utc)`,
    `CREATE INDEX ix_sample_cell ON location_sample(h3_r7, ts_utc)`,

    `-- Dwell intervals, the primary matching unit. Written by TypeScript stay derivation
-- (source 'derived') and by the iOS module from CLVisit (source 'visit').
CREATE TABLE stay (
  id            INTEGER PRIMARY KEY,
  start_ts      INTEGER NOT NULL,
  end_ts        INTEGER NOT NULL,  -- for an open stay: the latest time known to be inside it
  lat           REAL    NOT NULL,  -- centroid
  lon           REAL    NOT NULL,
  radius_m      REAL    NOT NULL,
  h3_r7         TEXT    NOT NULL,  -- res-7 cell of the centroid
  sample_count  INTEGER NOT NULL,  -- 0 for a 'visit' row
  closed        INTEGER NOT NULL DEFAULT 0,
  source        TEXT    NOT NULL   -- StaySource
)`,
    `CREATE INDEX ix_stay_cell ON stay(h3_r7, start_ts, end_ts)`,
    `CREATE INDEX ix_stay_end ON stay(end_ts)`,

    `-- Verified broadcast queries, as received.
CREATE TABLE report_cache (
  query_id         TEXT    PRIMARY KEY,
  payload_json     TEXT    NOT NULL,  -- the signed entry verbatim, unknown members included
  version          INTEGER NOT NULL,  -- payload "v"
  received_at      INTEGER NOT NULL,  -- when the stored revision was received
  expires_at       INTEGER NOT NULL,
  revision         INTEGER NOT NULL,
  last_matched_at  INTEGER            -- prospective-pass cursor; NULL = retrospective pass due
)`,
    `CREATE INDEX ix_report_cache_expires ON report_cache(expires_at)`,

    `-- Local match decisions. Never leaves the device.
CREATE TABLE "match" (
  id          INTEGER PRIMARY KEY,
  query_id    TEXT    NOT NULL,
  revision    INTEGER NOT NULL,  -- the report revision that matched
  stay_id     INTEGER,           -- evidence: a stay, or
  sample_id   INTEGER,           -- a single sample
  distance_m  REAL    NOT NULL,
  dt_sec      INTEGER NOT NULL,  -- gap between the evidence and the window, 0 if inside
  state       TEXT    NOT NULL
              CHECK (state IN ('new', 'notified', 'opened', 'dismissed', 'responded')),
  created_at  INTEGER NOT NULL,
  UNIQUE (query_id),             -- at most one notification per report, ever
  CHECK (stay_id IS NOT NULL OR sample_id IS NOT NULL)
)`,

    `-- Topics this device is subscribed to.
CREATE TABLE subscription (
  topic         TEXT    PRIMARY KEY,  -- H3 cell id
  res           INTEGER NOT NULL CHECK (res IN (3, 5)),
  reason        TEXT    NOT NULL CHECK (reason IN ('visited', 'ring', 'ancestor', 'coarsened')),
  added_at      INTEGER NOT NULL,
  refreshed_at  INTEGER NOT NULL
)`,

    `-- Durable send queue for a bystander's tip.
CREATE TABLE outbound_response (
  id               INTEGER PRIMARY KEY,
  query_id         TEXT    NOT NULL,
  idempotency_key  TEXT    NOT NULL,
  text             TEXT    NOT NULL,
  share_phone      INTEGER NOT NULL CHECK (share_phone IN (0, 1)),
  phone            TEXT,
  state            TEXT    NOT NULL CHECK (state IN ('queued', 'sending', 'sent', 'failed')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER,           -- earliest retry time; NULL once sent or failed
  last_error       TEXT,              -- ApiErrorCode of the last failed attempt
  response_id      TEXT,              -- server id from the acknowledgement
  created_at       INTEGER NOT NULL,
  sent_at          INTEGER,
  UNIQUE (query_id),                  -- one tip per report from this device
  UNIQUE (idempotency_key),
  CHECK ((share_phone = 1) = (phone IS NOT NULL))
)`,

    `-- The reporter's own reports, and the durable queue that submits them.
CREATE TABLE own_report (
  id                INTEGER PRIMARY KEY,
  idempotency_key   TEXT    NOT NULL,
  query_id          TEXT,              -- NULL until the server acknowledges the submit
  state             TEXT    NOT NULL
                    CHECK (state IN ('queued', 'sending', 'active', 'ended', 'expired', 'failed')),
  request_json      TEXT    NOT NULL,  -- the ReportSubmitRequest as queued
  report_json       TEXT,              -- the Report as last returned by the server
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   INTEGER,
  last_error        TEXT,
  responses_cursor  TEXT,              -- cursor for GET /v1/reports/:id/responses
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  UNIQUE (idempotency_key),
  UNIQUE (query_id),
  CHECK ((query_id IS NULL) = (report_json IS NULL)),
  CHECK ((query_id IS NULL) = (state IN ('queued', 'sending', 'failed')))
)`,

    `-- Tips received for the reporter's own reports.
CREATE TABLE received_response (
  response_id  TEXT    PRIMARY KEY,  -- server id; makes a repeated fetch harmless
  query_id     TEXT    NOT NULL,
  text         TEXT    NOT NULL,
  phone        TEXT,                 -- NULL = the responder stayed anonymous
  received_at  INTEGER NOT NULL,     -- when the server received it
  fetched_at   INTEGER NOT NULL,
  read_at      INTEGER               -- NULL = unread
)`,
    `CREATE INDEX ix_received_response_query ON received_response(query_id, received_at)`,

    `-- Small named values: cursors and the like. Keys are listed in tables/kv.ts.
CREATE TABLE kv (
  k  TEXT PRIMARY KEY,
  v  TEXT NOT NULL
)`,
  ],
};

/** Every migration, oldest first. Versions are consecutive and start at 1. */
export const MIGRATIONS: readonly Migration[] = [MIGRATION_V1];

/** The schema version this build of the code expects. */
export const SCHEMA_VERSION = 1;

/** The store was written by a newer app version than this code. It must not be touched. */
export class SchemaTooNewError extends Error {
  constructor(
    readonly found: number,
    readonly supported: number,
  ) {
    super(`store schema is version ${found}, this build supports up to ${supported}`);
    this.name = 'SchemaTooNewError';
  }
}

/** Reads `PRAGMA user_version`. A database with no schema yet reports 0. */
export async function readSchemaVersion(db: SqlExecutor): Promise<number> {
  const value = (await db.execute('PRAGMA user_version'))[0]?.user_version;
  if (typeof value !== 'number') {
    throw new Error('PRAGMA user_version returned no value');
  }
  return value;
}

/**
 * Brings the store up to the newest migration. Each migration runs in its own transaction
 * together with its version bump, so an interrupted run leaves the store at a whole version.
 * Running it again is a no-op. Throws SchemaTooNewError rather than touch a newer store.
 */
export async function migrate(
  db: SqlDatabase,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<{ from: number; to: number }> {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(`migration at position ${index} must have version ${index + 1}`);
    }
  });
  const from = await readSchemaVersion(db);
  if (from > migrations.length) {
    throw new SchemaTooNewError(from, migrations.length);
  }
  for (const migration of migrations.slice(from)) {
    await db.transaction(async (tx) => {
      // Re-read inside the transaction: another connection may have migrated in between.
      if ((await readSchemaVersion(tx)) >= migration.version) {
        return;
      }
      for (const statement of migration.statements) {
        await tx.execute(statement);
      }
      // PRAGMA takes no bound parameters; `version` is an integer from this file.
      await tx.execute(`PRAGMA user_version = ${migration.version}`);
    });
  }
  return { from, to: migrations.length };
}

/** A migration as one SQL script, the form committed under contracts/ for native tests. */
export function renderMigrationSql(migration: Migration): string {
  const header = [
    `-- findmyperson on-device store, schema version ${migration.version} (${migration.name}).`,
    '-- GENERATED from packages/shared/src/store/migrations.ts. Do not edit by hand.',
    '-- Statements are separated by a line holding only ";".',
  ].join('\n');
  return `${header}\n\n${migration.statements.join('\n;\n\n')}\n;\n\nPRAGMA user_version = ${migration.version}\n;\n`;
}
