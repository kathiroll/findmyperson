/**
 * Byte helpers written out by hand so this package needs no runtime beyond plain ECMAScript:
 * Hermes (the React Native engine) has had neither TextEncoder nor atob/btoa on every version
 * the app must run on, and Node's Buffer does not exist there at all.
 */

/** Encodes a string as UTF-8. Throws on a lone surrogate, which has no UTF-8 form. */
export function utf8Encode(text: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = text.charCodeAt(i + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) {
        throw new RangeError(`lone surrogate at index ${i}`);
      }
      code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new RangeError(`lone surrogate at index ${i}`);
    }
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Encodes bytes as base64url (RFC 4648 section 5) with no padding. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    const remaining = bytes.length - i;
    out += BASE64URL_ALPHABET.charAt(b0 >> 2);
    out += BASE64URL_ALPHABET.charAt(((b0 & 0x03) << 4) | (b1 >> 4));
    if (remaining > 1) {
      out += BASE64URL_ALPHABET.charAt(((b1 & 0x0f) << 2) | (b2 >> 6));
    }
    if (remaining > 2) {
      out += BASE64URL_ALPHABET.charAt(b2 & 0x3f);
    }
  }
  return out;
}

/**
 * Decodes unpadded base64url. Returns null for anything that is not the canonical encoding of
 * some byte string (wrong alphabet, padding, impossible length, or stray trailing bits), so two
 * different strings never decode to the same signature bytes.
 */
export function base64UrlDecode(text: string): Uint8Array | null {
  if (text.length % 4 === 1) {
    return null;
  }
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let buffer = 0;
  let bits = 0;
  let written = 0;
  for (let i = 0; i < text.length; i++) {
    const value = BASE64URL_ALPHABET.indexOf(text.charAt(i));
    if (value < 0) {
      return null;
    }
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[written++] = (buffer >> bits) & 0xff;
      buffer &= (1 << bits) - 1;
    }
  }
  return buffer === 0 ? out : null;
}
