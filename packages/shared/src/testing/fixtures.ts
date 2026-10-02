import signing from '../../contracts/signing-vectors.json';
import type { VerifiedQuery } from '../payload/bundle';
import { parseBroadcastQuery, type BroadcastQuery } from '../payload/query';
import { signDocument, type TrustedKeys } from '../payload/signing';
import { ed25519FromSeed, hexToBytes } from './ed25519';

/**
 * TEST SUPPORT, not exported from the package. The signed sample documents from
 * contracts/signing-vectors.json, typed, plus helpers to derive variants of them.
 */
export const testKey = ed25519FromSeed(hexToBytes(signing.seed_hex));
export const testKeyId = signing.key_id;
export const trustedTestKeys: TrustedKeys = { [signing.key_id]: testKey.publicKey };

function documentOfKind(kind: string, position = 0): Record<string, unknown> {
  const found = signing.documents.filter((entry) => entry.kind === kind)[position];
  if (found === undefined) {
    throw new Error(`signing fixture has no ${kind} document at position ${position}`);
  }
  // A deep copy, so a test that mutates its document cannot affect another test.
  return JSON.parse(JSON.stringify(found.signed)) as Record<string, unknown>;
}

/** The plain signed sample query, as raw JSON. */
export const rawQuery = (): Record<string, unknown> => documentOfKind('query', 0);
/** The signed sample query that carries a member no schema knows (`future_field`). */
export const rawQueryWithUnknownField = (): Record<string, unknown> => documentOfKind('query', 1);
export const rawBundle = (): Record<string, unknown> => documentOfKind('bundle');
export const rawIndex = (): Record<string, unknown> => documentOfKind('index');

/** The sample query, parsed. */
export function sampleQuery(): BroadcastQuery {
  const parsed = parseBroadcastQuery(rawQuery());
  if (parsed.status !== 'ok') {
    throw new Error(`sample query is ${parsed.status}`);
  }
  return parsed.query;
}

/** A signed document with its `sig` removed, ready to be changed and signed again. */
export function withoutSig(
  document: Record<string, unknown>,
): Record<string, unknown> & { key_id: string } {
  const unsigned = Object.fromEntries(Object.entries(document).filter(([name]) => name !== 'sig'));
  return { ...unsigned, key_id: String(document.key_id) };
}

/** Re-signs a query after changing some members, as the publisher would for a new revision. */
export async function signedQueryWith(
  changes: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return signDocument('query', withoutSig({ ...rawQuery(), ...changes }), testKey.sign);
}

/** A cache-ready entry (typed view plus raw JSON) for a variant of the sample query. */
export async function verifiedQueryWith(changes: Record<string, unknown>): Promise<VerifiedQuery> {
  const raw = await signedQueryWith(changes);
  const parsed = parseBroadcastQuery(raw);
  if (parsed.status !== 'ok') {
    throw new Error(`variant query is ${parsed.status}`);
  }
  return { query: parsed.query, raw };
}
