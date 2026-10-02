import { STORE_FILE_NAME } from './cipher';
import { SCHEMA_VERSION } from './migrations';
import { INSERT_LOCATION_SAMPLE_SQL, SAMPLE_SOURCES } from './tables/locationSample';
import { CLOSE_VISIT_STAY_SQL, INSERT_VISIT_STAY_SQL } from './tables/stay';

/**
 * Everything the native capture modules may do to the store, as data.
 *
 * Kotlin and Swift cannot import TypeScript, so this object is written out as
 * contracts/native-writer.json (nativeWriter.test.ts keeps the file in step). The native
 * modules read that file at build time and run exactly these statements and no others. The
 * meaning of each parameter is documented next to the statement's definition in store/tables/.
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
} as const;
