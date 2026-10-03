import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A ULID (Crockford base32, 48-bit millisecond time then 80 random bits). */
export function newUlid(nowMs: number = Date.now()): string {
  let time = '';
  let t = nowMs;
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(10);
  let bits = 0n;
  for (const b of bytes) {
    bits = (bits << 8n) | BigInt(b);
  }
  let random = '';
  for (let i = 0; i < 16; i++) {
    random = ALPHABET[Number(bits & 31n)] + random;
    bits >>= 5n;
  }
  return time + random;
}
