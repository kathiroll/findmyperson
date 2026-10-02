/**
 * Canonical JSON: the one byte sequence a JSON value is signed as.
 *
 * The form is RFC 8785 (JSON Canonicalization Scheme):
 *   - no whitespace;
 *   - object members sorted by key, comparing UTF-16 code units;
 *   - numbers written the way ECMAScript's Number-to-string does (so 1.0 is "1", 1e21 is
 *     "1e+21", negative zero is "0");
 *   - strings escaped minimally, exactly as JSON.stringify does;
 *   - array order kept as given.
 *
 * It takes any JSON value, including fields this version of the code does not know. That is
 * what lets an old app verify a payload that gained fields: the signature covers the document
 * as received, not the subset a schema recognises.
 */

/** Thrown when a value has no canonical JSON form (it is not JSON data). */
export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalJsonError';
  }
}

function hasLoneSurrogate(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = text.charCodeAt(i + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) {
        return true;
      }
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function canonicalString(text: string, path: string): string {
  if (hasLoneSurrogate(text)) {
    throw new CanonicalJsonError(`${path}: string contains a lone surrogate`);
  }
  return JSON.stringify(text);
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function serialise(value: unknown, path: string, ancestors: readonly object[]): string {
  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError(`${path}: ${String(value)} is not a JSON number`);
      }
      return JSON.stringify(value);
    case 'string':
      return canonicalString(value, path);
    case 'object':
      break;
    default:
      throw new CanonicalJsonError(`${path}: ${typeof value} is not a JSON value`);
  }
  if (ancestors.includes(value)) {
    throw new CanonicalJsonError(`${path}: cyclic reference`);
  }
  const chain = [...ancestors, value];
  if (Array.isArray(value)) {
    const items: string[] = [];
    // Index loop, not map: map would skip the holes of a sparse array.
    for (let i = 0; i < value.length; i++) {
      items.push(serialise(value[i], `${path}[${i}]`, chain));
    }
    return `[${items.join(',')}]`;
  }
  if (!isPlainObject(value)) {
    throw new CanonicalJsonError(`${path}: only plain objects and arrays are JSON values`);
  }
  // Default sort compares UTF-16 code units, which is the order RFC 8785 requires.
  const members = Object.keys(value)
    .sort()
    .map((key) => {
      const memberPath = `${path}.${key}`;
      return `${canonicalString(key, memberPath)}:${serialise(value[key], memberPath, chain)}`;
    });
  return `{${members.join(',')}}`;
}

/**
 * Returns the canonical JSON text of a value. Throws CanonicalJsonError for anything that is
 * not JSON data: undefined, functions, symbols, bigint, NaN, infinities, class instances
 * (including Date and Map), lone surrogates and cycles. A signer that passes such a value has a
 * bug, and failing loudly beats signing something the verifier cannot reproduce.
 */
export function canonicalJson(value: unknown): string {
  return serialise(value, '$', []);
}
