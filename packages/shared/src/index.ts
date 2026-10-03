/**
 * @findmyperson/shared: the contracts every other part of the project imports.
 *
 * What a report, a stay, a match, a signature and an API call look like is defined here once.
 * The app, the server and the native modules build against these definitions and do not write
 * their own. See packages/shared/README.md for a map, and contracts/ for the files native code
 * and third parties consume.
 */
export const packageName = '@findmyperson/shared';

export * from './constants';
export * from './uuid';

// Geometry and geo-sharding.
export * from './geo/distance';
export * from './geo/h3';

// Broadcast payload, signing and the widen-only edit rule.
export * from './payload/encoding';
export * from './payload/canonical';
export * from './payload/signing';
export * from './payload/primitives';
export * from './payload/query';
export * from './payload/bundle';
export * from './payload/widening';

// Backend API shapes.
export * from './api/errors';
export * from './api/idempotency';
export * from './api/devices';
export * from './api/reports';
export * from './api/responses';
export * from './api/endpoints';

// Device identity seam.
export * from './identity/deviceIdentity';

// On-device store.
export * from './store/cipher';
export {
  StoreRowError,
  type SqlDatabase,
  type SqlExecutor,
  type SqlRow,
  type SqlValue,
} from './store/driver';
export * from './store/migrations';
export * from './store/nativeWriter';
export * from './store/ownership';
export * from './store/tables/locationSample';
export * from './store/tables/stay';
export * from './store/tables/reportCache';
export * from './store/tables/match';
export * from './store/tables/subscription';
export * from './store/tables/outboundResponse';
export * from './store/tables/ownReport';
export * from './store/tables/receivedResponse';
export * from './store/tables/kv';

// Stay derivation: the writer of 'derived' rows in `stay`.
export type { StaySample } from './stay/cluster';
export { extractStays, type CoveringStay } from './stay/extract';
export { deriveStays, type StayDerivationResult } from './stay/derive';

// Retention: the purge, the weekly VACUUM and the store's maintenance hook.
export { purgeExpired, type PurgeResult } from './retention/purge';
export {
  createRetentionMaintenance,
  runRetention,
  vacuumIfDue,
  type DeviceConditions,
  type RetentionOptions,
  type RetentionRun,
  type VacuumOutcome,
} from './retention/maintenance';
