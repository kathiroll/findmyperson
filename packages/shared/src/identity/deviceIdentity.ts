import { isUuidV4, uuidV4FromBytes } from '../uuid';

/**
 * The device identity seam (plan 12.2).
 *
 * Device identity is an open captain decision. What is fixed is that every API call is made as
 * some device, and that the server deduplicates and limits by that device. So callers code
 * against the two interfaces below and nothing else:
 *
 *   DeviceIdentity       on the phone: "who am I, and what do I attach to a request"
 *   DeviceAuthenticator  on the server: "which device sent this request, if any"
 *
 * The implementations here are stubs of option A in plan 12.2, a client-generated UUID sent as
 * is. They are safe to build against and trivially forgeable; they enforce no policy. The real
 * implementation (attestation, signed requests, whatever 12.2 resolves to) replaces the two
 * factory functions and touches no caller. Rate limits and moderation are separate seams and
 * are not decided here either.
 */

/** A device id: a lowercase RFC 4122 version 4 UUID. Opaque to everything but the stubs. */
export type DeviceId = string;

export function isDeviceId(value: unknown): value is DeviceId {
  return isUuidV4(value);
}

/** Client side: the identity of the phone this code is running on. */
export interface DeviceIdentity {
  /** The stable id of this device, created on first use. */
  getDeviceId(): Promise<DeviceId>;
  /**
   * Headers to add to an API request so the server knows which device sent it. Callers must
   * use this and never build an auth header themselves, so the scheme can change underneath.
   */
  authHeaders(): Promise<Readonly<Record<string, string>>>;
  /** Forgets the identity ("Delete all my data"). The next call creates a fresh one. */
  reset(): Promise<void>;
}

/** Server side: what the server knows about the caller once a request is authenticated. */
export interface AuthenticatedDevice {
  device_id: DeviceId;
}

/** Server side: turns request headers into a device, or null if the request is anonymous. */
export interface DeviceAuthenticator {
  authenticate(
    headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  ): Promise<AuthenticatedDevice | null>;
}

/** The stub's wire format: `Authorization: FMP-Device <uuid>`. */
export const DEVICE_AUTH_HEADER = 'Authorization';
export const DEVICE_AUTH_SCHEME = 'FMP-Device';

export function formatDeviceAuthorization(deviceId: DeviceId): string {
  return `${DEVICE_AUTH_SCHEME} ${deviceId}`;
}

/** Reads a stub Authorization header value. Returns null for anything else. */
export function parseDeviceAuthorization(value: string | undefined): DeviceId | null {
  if (value === undefined) {
    return null;
  }
  const [scheme, deviceId, ...rest] = value.split(' ');
  return scheme === DEVICE_AUTH_SCHEME && rest.length === 0 && isDeviceId(deviceId)
    ? deviceId
    : null;
}

/**
 * STUB. A device identity that lives only in memory, so it is lost when the process exits.
 * `randomBytes` is passed in because this package has no source of randomness of its own; give
 * it a cryptographic one outside tests.
 */
export function createInMemoryDeviceIdentity(options: {
  randomBytes: (length: number) => Uint8Array;
}): DeviceIdentity {
  let deviceId: DeviceId | null = null;
  const getDeviceId = async (): Promise<DeviceId> => {
    deviceId ??= uuidV4FromBytes(options.randomBytes(16));
    return deviceId;
  };
  return {
    getDeviceId,
    async authHeaders() {
      return { [DEVICE_AUTH_HEADER]: formatDeviceAuthorization(await getDeviceId()) };
    },
    async reset() {
      deviceId = null;
    },
  };
}

/**
 * STUB. Believes whatever device id the Authorization header claims. It proves nothing about
 * the caller; it exists so endpoints can be written against DeviceAuthenticator today.
 */
export function createStubDeviceAuthenticator(): DeviceAuthenticator {
  return {
    async authenticate(headers) {
      for (const [name, value] of Object.entries(headers)) {
        if (name.toLowerCase() === DEVICE_AUTH_HEADER.toLowerCase() && typeof value === 'string') {
          const deviceId = parseDeviceAuthorization(value);
          return deviceId === null ? null : { device_id: deviceId };
        }
      }
      return null;
    },
  };
}
