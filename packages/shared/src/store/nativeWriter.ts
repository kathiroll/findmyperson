import { RETENTION_SEC } from '../constants';
import { REWIND_STAY_CURSOR_SQL } from '../stay/derive';
import { STORE_FILE_NAME } from './cipher';
import { SCHEMA_VERSION } from './migrations';
import {
  DELETE_SAMPLES_BEFORE_SQL,
  INSERT_LOCATION_SAMPLE_SQL,
  SAMPLE_SOURCES,
} from './tables/locationSample';
import {
  CLOSE_VISIT_STAY_SQL,
  DELETE_STAYS_ENDED_BEFORE_SQL,
  INSERT_VISIT_STAY_SQL,
  TRIM_STAYS_STARTED_BEFORE_SQL,
} from './tables/stay';

/**
 * Everything the native capture modules may do to the store, as data.
 *
 * Kotlin and Swift cannot import TypeScript, so this object is written out as
 * contracts/native-writer.json (nativeWriter.test.ts keeps the file in step). The native
 * modules read that file at build time and run exactly these statements and no others. The
 * meaning of each parameter is documented next to the statement's definition in store/tables/.
 *
 * THE PURGE ON A NATIVE WAKE. The retention purge (retention/purge.ts) is TypeScript and runs
 * when JavaScript runs. A phone that keeps capturing while the app is never opened would hold
 * its history past retention, so a capture wake purges the two tables that hold location
 * history by itself, with the same statements the TypeScript purge runs:
 *
 *   cutoff = now - retentionSec, where now is the device clock in Unix seconds
 *
 *   deleteSamplesBeforeSql      (cutoff)
 *   deleteStaysEndedBeforeSql   (cutoff)
 *   trimStaysStartedBeforeSql   (cutoff, cutoff, cutoff)
 *   rewindStayCursorSql         ()
 *
 * in that order and in ONE transaction, for the reasons given in retention/purge.ts: fixes and
 * stays go together, and the stay-derivation cursor must be pulled back in the transaction that
 * deleted the newest fixes. The native purge does not derive stays first and does not need to
 * (purge.ts, ORDER). It leaves `report_cache`, `match` and `outbound_response` to the
 * TypeScript purge: none of them holds where the phone has been.
 */
export const NATIVE_WRITER_CONTRACT = {
  /**
   * The native module reads the store's version with `readSchemaVersionSql` on open. If it is
   * not this number it must not write, and reports the store as unusable in its status.
   */
  schemaVersion: SCHEMA_VERSION,
  readSchemaVersionSql: 'PRAGMA user_version',
  storeFileName: STORE_FILE_NAME,
  insertLocationSampleSql: INSERT_LOCATION_SAMPLE_SQL,
  sampleSources: SAMPLE_SOURCES,
  insertVisitStaySql: INSERT_VISIT_STAY_SQL,
  closeVisitStaySql: CLOSE_VISIT_STAY_SQL,
  /** RETENTION_SEC: how far behind the device clock the purge's cutoff is. */
  retentionSec: RETENTION_SEC,
  deleteSamplesBeforeSql: DELETE_SAMPLES_BEFORE_SQL,
  deleteStaysEndedBeforeSql: DELETE_STAYS_ENDED_BEFORE_SQL,
  trimStaysStartedBeforeSql: TRIM_STAYS_STARTED_BEFORE_SQL,
  rewindStayCursorSql: REWIND_STAY_CURSOR_SQL,
} as const;
