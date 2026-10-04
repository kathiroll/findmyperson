import { DatabaseSync } from 'node:sqlite';
import type {
  LatLon,
  Person,
  QueryId,
  ReviewState,
  ReportStatus,
  TimeWindow,
} from '@findmyperson/shared';
import { INITIAL_REVIEW_STATE } from './lifecycle';

/**
 * The server's database: Node's built-in SQLite, so the same code runs in tests (`:memory:`) and
 * on a single box. The device-side store (shared/src/store) is the phone's own database and has
 * no server tables, so the server schema lives here. Reports are rare; there is no write-volume
 * story, and moving this to Postgres later means replacing this file only.
 *
 * Two constraints carry the project's decisions and are enforced by the database itself:
 *   - reports.review_state starts 'pending' and only takes the three lifecycle values;
 *   - responses is UNIQUE (query_id, device_id): one response per device per report, no cap
 *     beyond that (addendum 2026-10-03, decision 1).
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS devices (
  device_id     TEXT PRIMARY KEY,
  platform      TEXT NOT NULL,
  app_version   TEXT NOT NULL,
  push_provider TEXT,
  push_token    TEXT,
  registered_at INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reports (
  query_id           TEXT PRIMARY KEY,
  reporter_device_id TEXT NOT NULL,
  review_state       TEXT NOT NULL DEFAULT 'pending'
                     CHECK (review_state IN ('pending', 'released', 'rejected')),
  status             TEXT NOT NULL CHECK (status IN ('active', 'ended', 'expired')),
  revision           INTEGER NOT NULL,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  expires_at         INTEGER NOT NULL,
  ended_at           INTEGER,
  center_lat         REAL NOT NULL,
  center_lon         REAL NOT NULL,
  radius_m           INTEGER NOT NULL,
  window_from        INTEGER NOT NULL,
  window_to          INTEGER NOT NULL,
  person_json        TEXT NOT NULL,
  reporter_phone     TEXT NOT NULL,
  reviewed_at        INTEGER,
  reviewed_by        TEXT
);
CREATE INDEX IF NOT EXISTS reports_review_state ON reports (review_state, status);
CREATE TABLE IF NOT EXISTS responses (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  response_id   TEXT NOT NULL UNIQUE,
  query_id      TEXT NOT NULL,
  device_id     TEXT NOT NULL,
  text          TEXT NOT NULL,
  phone         TEXT,
  received_at   INTEGER NOT NULL,
  moderation    TEXT NOT NULL CHECK (moderation IN ('delivered', 'held')),
  held_reason   TEXT,
  UNIQUE (query_id, device_id)
);
CREATE TABLE IF NOT EXISTS response_reviews (
  response_id TEXT PRIMARY KEY,
  decision    TEXT NOT NULL CHECK (decision IN ('released', 'rejected')),
  reviewed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS idempotency (
  device_id    TEXT NOT NULL,
  key          TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status       INTEGER,
  body_json    TEXT,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (device_id, key)
);
CREATE TABLE IF NOT EXISTS shard_generations (
  shard        TEXT PRIMARY KEY,
  generation   INTEGER NOT NULL CHECK (generation >= 1),
  content_hash TEXT NOT NULL,
  query_count  INTEGER NOT NULL,
  issued_at    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS shard_index_state (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  index_hash TEXT NOT NULL,
  issued_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS shard_cdn_pending (
  path TEXT PRIMARY KEY
);
`;

export interface ReportRow {
  query_id: QueryId;
  reporter_device_id: string;
  review_state: ReviewState;
  status: ReportStatus;
  revision: number;
  created_at: number;
  updated_at: number;
  expires_at: number;
  ended_at: number | null;
  center: LatLon;
  radius_m: number;
  window: TimeWindow;
  person: Person;
  reporter_phone: string;
  reviewed_at: number | null;
  reviewed_by: string | null;
}

export interface ResponseRow {
  seq: number;
  response_id: string;
  query_id: string;
  device_id: string;
  text: string;
  phone: string | null;
  received_at: number;
  moderation: 'delivered' | 'held';
  held_reason: string | null;
}

export interface IdempotencyRow {
  request_hash: string;
  status: number | null;
  body_json: string | null;
}

/**
 * The shard compiler's memory of one shard (shards/compiler.ts). A row is never deleted, so a
 * shard that empties and later fills again continues its numbering instead of restarting at 1.
 */
export interface ShardGenerationRow {
  shard: string;
  /** The newest generation ever assigned to this shard. */
  generation: number;
  /** Hash of that generation's queries, or of the empty list once the shard has emptied. */
  content_hash: string;
  query_count: number;
  /** The bundle's `issued_at`, kept so a rewrite of the same generation is byte-identical. */
  issued_at: number;
}

export interface ShardIndexStateRow {
  index_hash: string;
  issued_at: number;
}

type Row = Record<string, unknown>;

function toReport(r: Row): ReportRow {
  return {
    query_id: r.query_id as QueryId,
    reporter_device_id: r.reporter_device_id as string,
    review_state: r.review_state as ReviewState,
    status: r.status as ReportStatus,
    revision: r.revision as number,
    created_at: r.created_at as number,
    updated_at: r.updated_at as number,
    expires_at: r.expires_at as number,
    ended_at: r.ended_at as number | null,
    center: { lat: r.center_lat as number, lon: r.center_lon as number },
    radius_m: r.radius_m as number,
    window: { from: r.window_from as number, to: r.window_to as number },
    person: JSON.parse(r.person_json as string) as Person,
    reporter_phone: r.reporter_phone as string,
    reviewed_at: r.reviewed_at as number | null,
    reviewed_by: r.reviewed_by as string | null,
  };
}

export type NewReport = Omit<
  ReportRow,
  'review_state' | 'reviewed_at' | 'reviewed_by' | 'ended_at' | 'status' | 'revision'
>;

export class ServerDb {
  private readonly db: DatabaseSync;

  constructor(path: string = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    // The shard compiler can run as a second process on the same file (shards/cli.ts); wait for
    // its short write transactions instead of failing with SQLITE_BUSY.
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  // --- devices -------------------------------------------------------------------------------

  /** Registration replaces the stored state, so leaving the push token out deletes it. */
  upsertDevice(
    deviceId: string,
    platform: string,
    appVersion: string,
    push: { provider: string; token: string } | undefined,
    now: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO devices (device_id, platform, app_version, push_provider, push_token, registered_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (device_id) DO UPDATE SET platform = excluded.platform,
           app_version = excluded.app_version, push_provider = excluded.push_provider,
           push_token = excluded.push_token, updated_at = excluded.updated_at`,
      )
      .run(deviceId, platform, appVersion, push?.provider ?? null, push?.token ?? null, now, now);
  }

  // --- reports -------------------------------------------------------------------------------

  /** A new report is always `pending`: this is the only place a report row is created. */
  insertPendingReport(report: NewReport): void {
    this.db
      .prepare(
        `INSERT INTO reports (query_id, reporter_device_id, review_state, status, revision,
           created_at, updated_at, expires_at, center_lat, center_lon, radius_m,
           window_from, window_to, person_json, reporter_phone)
         VALUES (?, ?, ?, 'active', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        report.query_id,
        report.reporter_device_id,
        INITIAL_REVIEW_STATE,
        report.created_at,
        report.updated_at,
        report.expires_at,
        report.center.lat,
        report.center.lon,
        report.radius_m,
        report.window.from,
        report.window.to,
        JSON.stringify(report.person),
        report.reporter_phone,
      );
  }

  getReport(queryId: string): ReportRow | null {
    const row = this.db.prepare('SELECT * FROM reports WHERE query_id = ?').get(queryId);
    return row === undefined ? null : toReport(row);
  }

  listReportsByReviewState(state: ReviewState): ReportRow[] {
    return this.db
      .prepare('SELECT * FROM reports WHERE review_state = ? ORDER BY created_at, query_id')
      .all(state)
      .map(toReport);
  }

  /**
   * THE ONLY READ THE SHARD COMPILER MAY USE. Released, still-active, unexpired reports and
   * nothing else, so `pending` and `rejected` reports can never reach a bundle or a device.
   */
  listBroadcastable(now: number): ReportRow[] {
    return this.db
      .prepare(
        `SELECT * FROM reports
         WHERE review_state = 'released' AND status = 'active' AND expires_at > ?
         ORDER BY created_at, query_id`,
      )
      .all(now)
      .map(toReport);
  }

  /** Applies a review decision. Guarded on `pending`, so a lost race changes nothing. */
  setReviewState(queryId: string, next: ReviewState, reviewedBy: string, now: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE reports SET review_state = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ?
         WHERE query_id = ? AND review_state = 'pending'`,
      )
      .run(next, reviewedBy, now, now, queryId);
    return result.changes === 1;
  }

  updateReportCriteria(
    queryId: string,
    expectedRevision: number,
    next: { center: LatLon; radius_m: number; window: TimeWindow; person: Person },
    now: number,
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE reports SET center_lat = ?, center_lon = ?, radius_m = ?, window_from = ?,
           window_to = ?, person_json = ?, revision = revision + 1, updated_at = ?
         WHERE query_id = ? AND revision = ?`,
      )
      .run(
        next.center.lat,
        next.center.lon,
        next.radius_m,
        next.window.from,
        next.window.to,
        JSON.stringify(next.person),
        now,
        queryId,
        expectedRevision,
      );
    return result.changes === 1;
  }

  setReportStatus(queryId: string, status: ReportStatus, now: number): void {
    this.db
      .prepare(
        `UPDATE reports SET status = ?, updated_at = ?, ended_at = COALESCE(ended_at, ?)
         WHERE query_id = ?`,
      )
      .run(status, now, status === 'ended' ? now : null, queryId);
  }

  // --- responses -----------------------------------------------------------------------------

  /** Throws a UNIQUE error if (query_id, device_id) already has a response. */
  insertResponse(row: Omit<ResponseRow, 'seq'>): void {
    this.db
      .prepare(
        `INSERT INTO responses (response_id, query_id, device_id, text, phone, received_at, moderation, held_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.response_id,
        row.query_id,
        row.device_id,
        row.text,
        row.phone,
        row.received_at,
        row.moderation,
        row.held_reason,
      );
  }

  hasResponse(queryId: string, deviceId: string): boolean {
    return (
      this.db
        .prepare('SELECT 1 AS one FROM responses WHERE query_id = ? AND device_id = ?')
        .get(queryId, deviceId) !== undefined
    );
  }

  /** Delivered responses only: held ones are never returned by any read. Oldest first. */
  listDeliveredResponses(queryId: string, afterSeq: number, limit: number): ResponseRow[] {
    return this.db
      .prepare(
        `SELECT * FROM responses WHERE query_id = ? AND moderation = 'delivered' AND seq > ?
         ORDER BY seq LIMIT ?`,
      )
      .all(queryId, afterSeq, limit) as unknown as ResponseRow[];
  }

  /**
   * Held responses the operator has not decided yet, oldest first. A rejected one stays `held`
   * for good (so it is never delivered and still uses up the device's one response) and is told
   * apart by its row in `response_reviews`.
   */
  listHeldResponses(): ResponseRow[] {
    return this.db
      .prepare(
        `SELECT * FROM responses WHERE moderation = 'held'
           AND response_id NOT IN (SELECT response_id FROM response_reviews)
         ORDER BY seq`,
      )
      .all() as unknown as ResponseRow[];
  }

  /**
   * Delivers a held response the operator has not decided yet; false if there is none by that
   * id. The row is re-inserted so it takes a new `seq`: the reporter pages by `seq`, and a
   * response released where it was held would be behind a cursor they have already passed.
   * Call it through `decideHeldResponse` in moderation.ts.
   */
  releaseHeldResponse(responseId: string, now: number): boolean {
    return this.transaction(() => {
      const held = this.db
        .prepare(
          `SELECT * FROM responses WHERE response_id = ? AND moderation = 'held'
             AND response_id NOT IN (SELECT response_id FROM response_reviews)`,
        )
        .get(responseId) as unknown as ResponseRow | undefined;
      if (held === undefined) {
        return false;
      }
      this.db.prepare('DELETE FROM responses WHERE seq = ?').run(held.seq);
      this.insertResponse({ ...held, moderation: 'delivered' });
      this.recordResponseReview(responseId, 'released', now);
      return true;
    });
  }

  /** Marks a held response as never to be delivered; false if there is none left to decide. */
  rejectHeldResponse(responseId: string, now: number): boolean {
    return this.transaction(() => {
      const held = this.db
        .prepare(
          `SELECT 1 AS one FROM responses WHERE response_id = ? AND moderation = 'held'
             AND response_id NOT IN (SELECT response_id FROM response_reviews)`,
        )
        .get(responseId);
      if (held === undefined) {
        return false;
      }
      this.recordResponseReview(responseId, 'rejected', now);
      return true;
    });
  }

  private recordResponseReview(
    responseId: string,
    decision: 'released' | 'rejected',
    now: number,
  ): void {
    this.db
      .prepare('INSERT INTO response_reviews (response_id, decision, reviewed_at) VALUES (?, ?, ?)')
      .run(responseId, decision, now);
  }

  // --- idempotency ---------------------------------------------------------------------------

  getIdempotency(deviceId: string, key: string): IdempotencyRow | null {
    const row = this.db
      .prepare(
        'SELECT request_hash, status, body_json FROM idempotency WHERE device_id = ? AND key = ?',
      )
      .get(deviceId, key);
    return row === undefined ? null : (row as unknown as IdempotencyRow);
  }

  beginIdempotency(deviceId: string, key: string, requestHash: string, now: number): void {
    this.db
      .prepare(
        'INSERT INTO idempotency (device_id, key, request_hash, created_at) VALUES (?, ?, ?, ?)',
      )
      .run(deviceId, key, requestHash, now);
  }

  finishIdempotency(deviceId: string, key: string, status: number, bodyJson: string): void {
    this.db
      .prepare('UPDATE idempotency SET status = ?, body_json = ? WHERE device_id = ? AND key = ?')
      .run(status, bodyJson, deviceId, key);
  }

  forgetIdempotency(deviceId: string, key: string): void {
    this.db.prepare('DELETE FROM idempotency WHERE device_id = ? AND key = ?').run(deviceId, key);
  }

  // --- shard compiler state (shards/compiler.ts is the only caller) --------------------------

  listShardGenerations(): ShardGenerationRow[] {
    return this.db
      .prepare('SELECT * FROM shard_generations ORDER BY shard')
      .all() as unknown as ShardGenerationRow[];
  }

  putShardGeneration(row: ShardGenerationRow): void {
    this.db
      .prepare(
        `INSERT INTO shard_generations (shard, generation, content_hash, query_count, issued_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (shard) DO UPDATE SET generation = excluded.generation,
           content_hash = excluded.content_hash, query_count = excluded.query_count,
           issued_at = excluded.issued_at`,
      )
      .run(row.shard, row.generation, row.content_hash, row.query_count, row.issued_at);
  }

  getShardIndexState(): ShardIndexStateRow | null {
    const row = this.db
      .prepare('SELECT index_hash, issued_at FROM shard_index_state WHERE id = 1')
      .get();
    return row === undefined ? null : (row as unknown as ShardIndexStateRow);
  }

  putShardIndexState(state: ShardIndexStateRow): void {
    this.db
      .prepare(
        `INSERT INTO shard_index_state (id, index_hash, issued_at) VALUES (1, ?, ?)
         ON CONFLICT (id) DO UPDATE SET index_hash = excluded.index_hash,
           issued_at = excluded.issued_at`,
      )
      .run(state.index_hash, state.issued_at);
  }

  /** CDN paths whose invalidation has not been confirmed yet. Survives a failed or killed run. */
  listPendingCdnPaths(): string[] {
    return this.db
      .prepare('SELECT path FROM shard_cdn_pending ORDER BY path')
      .all()
      .map((row) => row.path as string);
  }

  addPendingCdnPaths(paths: readonly string[]): void {
    const insert = this.db.prepare('INSERT OR IGNORE INTO shard_cdn_pending (path) VALUES (?)');
    for (const path of paths) {
      insert.run(path);
    }
  }

  clearPendingCdnPaths(paths: readonly string[]): void {
    const remove = this.db.prepare('DELETE FROM shard_cdn_pending WHERE path = ?');
    for (const path of paths) {
      remove.run(path);
    }
  }
}
