import {
  base64UrlDecode,
  ED25519_PUBLIC_KEY_BYTES,
  KEY_ID_PATTERN,
  type TrustedKeys,
} from '@findmyperson/shared';
import { CDN_ORIGIN_PATTERN } from './httpTransport';

/**
 * WHERE REPORTS COME FROM, AND WHOSE SIGNATURE IS BELIEVED. Both are unset.
 *
 * These two constants are the whole of what the storage and CDN decision (held for the captain
 * as fmp-storage-cdn-provider) has to fill in on the device. Until it does, the app asks nobody
 * for reports: the fetch trigger (./trigger.ts) runs at every wake, finds no source and stops
 * there, with nothing on the network. Everything else is wired and tested against a stand-in
 * origin and the test key of packages/shared/contracts/signing-vectors.json.
 *
 * They are constants in the binary and not a setting, because that is what pinning means
 * (plan 6.4): a build trusts the keys it was built with and nothing a server says later.
 */

/**
 * The CDN the shard compiler publishes to: `https://host`, no path, no trailing slash. It is
 * where `/index.json` and `/shards/<cell>/<generation>.json` are served from (server/README.md).
 */
export const REPORT_CDN_ORIGIN: string | null = null;

/**
 * The publisher's public keys, by key id: each value is the 32 bytes as unpadded base64url,
 * which is the `public_key` that `cli.ts keygen` prints on the server. List every key
 * `KeyRing.trustedAt` returns for the release date (server/src/shards/keys.ts says how a
 * rotation overlaps), so a build keeps verifying across a key change.
 */
export const REPORT_TRUSTED_KEYS: Readonly<Record<string, string>> = {};

/** A place to fetch reports from and the keys to check them with. */
export interface ReportSource {
  origin: string;
  trustedKeys: TrustedKeys;
}

/**
 * The source the two values describe, or null when either is missing: an origin with no key
 * could not verify anything, and keys with no origin have nothing to verify.
 *
 * Throws RangeError for a value that is present and wrong. A build must not start fetching
 * from somewhere a typo names, or go quiet because one key of two did not parse.
 */
export function reportSourceOf(
  origin: string | null,
  keys: Readonly<Record<string, string>>,
): ReportSource | null {
  const trustedKeys: Record<string, Uint8Array> = {};
  for (const [keyId, encoded] of Object.entries(keys)) {
    const bytes = base64UrlDecode(encoded);
    if (!KEY_ID_PATTERN.test(keyId) || bytes?.length !== ED25519_PUBLIC_KEY_BYTES) {
      throw new RangeError(`trusted key ${keyId} is not a key id with 32 bytes of base64url`);
    }
    trustedKeys[keyId] = bytes;
  }
  if (origin !== null && !CDN_ORIGIN_PATTERN.test(origin)) {
    throw new RangeError('the CDN origin must be https://host with no path');
  }
  if (origin === null || Object.keys(trustedKeys).length === 0) {
    return null;
  }
  return { origin, trustedKeys };
}

/** What this build was given: null until REPORT_CDN_ORIGIN and REPORT_TRUSTED_KEYS are set. */
export const configuredReportSource = (): ReportSource | null =>
  reportSourceOf(REPORT_CDN_ORIGIN, REPORT_TRUSTED_KEYS);
