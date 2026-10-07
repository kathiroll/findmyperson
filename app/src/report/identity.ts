import {
  DEVICE_AUTH_HEADER,
  KV_KEYS,
  formatDeviceAuthorization,
  isDeviceId,
  kvDelete,
  kvGet,
  kvSet,
  uuidV4FromBytes,
  type DeviceIdentity,
  type SqlExecutor,
} from '@findmyperson/shared';

export { platformRandomBytes } from '../random';

/**
 * Device identity that survives restarts: the client-generated id (the real scheme, addendum
 * 2026-10-03) kept in the encrypted store's `kv`. "Delete all my data" drops the whole store, id
 * included, and the next call mints a new one.
 */
export function createStoreDeviceIdentity(
  db: SqlExecutor,
  randomBytes: (length: number) => Uint8Array,
): DeviceIdentity {
  const getDeviceId = async () => {
    const stored = await kvGet(db, KV_KEYS.deviceId);
    if (isDeviceId(stored)) return stored;
    const created = uuidV4FromBytes(randomBytes(16));
    await kvSet(db, KV_KEYS.deviceId, created);
    return created;
  };
  return {
    getDeviceId,
    async authHeaders() {
      return { [DEVICE_AUTH_HEADER]: formatDeviceAuthorization(await getDeviceId()) };
    },
    async reset() {
      await kvDelete(db, KV_KEYS.deviceId);
    },
  };
}
