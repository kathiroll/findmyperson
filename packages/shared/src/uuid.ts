/** A lowercase RFC 4122 version 4 UUID: the form of device ids and idempotency keys. */
export const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isUuidV4(value: unknown): value is string {
  return typeof value === 'string' && UUID_V4_PATTERN.test(value);
}

/**
 * Builds a version 4 UUID from 16 random bytes (RFC 4122 section 4.4). The bytes are passed in
 * because this package has no source of randomness of its own: Node and Hermes each have a
 * different one, and tests want fixed bytes.
 */
export function uuidV4FromBytes(bytes: Uint8Array): string {
  if (bytes.length !== 16) {
    throw new RangeError('a UUID needs exactly 16 bytes');
  }
  const b = Array.from(bytes);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const hex = b.map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-');
}
