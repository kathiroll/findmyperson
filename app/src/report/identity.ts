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

/**
 * The platform's CSPRNG. NOT VERIFIED ON A DEVICE: this assumes `globalThis.crypto.getRandomValues`
 * exists under Hermes; if the native projects land without it, supply a polyfill or pass
 * `randomBytes` to `createDataStore`. It throws rather than falling back to Math.random.
 */
export function platformRandomBytes(length: number): Uint8Array {
  const crypto = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } })
    .crypto;
  if (crypto?.getRandomValues === undefined) {
    throw new Error('no secure random source on this platform');
  }
  return crypto.getRandomValues(new Uint8Array(length));
}
