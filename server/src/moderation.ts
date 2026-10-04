/**
 * Response moderation: the captain's decision, nothing broader (addendum 2026-10-03).
 *
 * Every response passes through `moderateResponse` before relay. Text containing a link or a
 * payment identifier is HELD: stored, never delivered, logged for manual review. Everything else
 * is delivered immediately and reviewed after the fact. There is deliberately no threat or abuse
 * classifier here.
 *
 * LIMITS: this is a regex heuristic on normalised text, not a security boundary. It catches
 * obvious schemes, bare domains on common TLDs, "dot" spellings, crypto addresses (BTC, ETH,
 * TRON), UPI ids and "send money" phrasing. It misses links split across words or sentences,
 * unusual TLDs, homoglyphs beyond NFKC folding, addresses with injected characters, and payment
 * requests phrased in unlisted words or languages. It also over-holds: an email address looks
 * like a UPI id. Over-holding is the intended failure direction.
 *
 * A held response waits for the operator, who decides it with `decideHeldResponse` (the operator
 * page, operatorPage.ts): release delivers it to the reporter, reject keeps it undelivered for
 * good. Both are final, and nothing else moves a response out of `held`.
 */
import type { ServerDb } from './db';

export type ModerationReason = 'url' | 'crypto_address' | 'upi_id' | 'payment_phrase';

export type ModerationVerdict = { held: false } | { held: true; reason: ModerationReason };

const TLDS =
  'com|net|org|io|co|in|me|app|dev|xyz|info|biz|online|site|top|club|link|click|ly|gl|to|cc|tv|us|uk|ru|cn|ai|shop|store|live|pro|page|cloud';

const URL_PATTERNS: readonly RegExp[] = [
  /\b[a-z][a-z0-9+.-]{1,15}:\/\//,
  /\bwww\./,
  new RegExp(`\\b[a-z0-9-]+(\\.[a-z0-9-]+)*\\.(${TLDS})\\b`),
  /\b(bit\.ly|t\.co|tinyurl|wa\.me|t\.me)\b/,
];

const CRYPTO_PATTERNS: readonly RegExp[] = [
  /\b0x[a-f0-9]{40}\b/,
  /\bbc1[a-z0-9]{25,59}\b/,
  /\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b/,
  /\bT[1-9A-HJ-NP-Za-km-z]{33}\b/,
];

const UPI_PATTERN = /\b[a-z0-9._-]{2,}@[a-z][a-z0-9]{1,}\b/;

const PAYMENT_PATTERNS: readonly RegExp[] = [
  /\b(send|transfer|wire|pay|give)\s+(me\s+|us\s+)?(some\s+|the\s+|a\s+)?(money|cash|funds|payment|crypto|bitcoin|btc|eth|usdt)\b/,
  /\b(western union|moneygram|gift ?cards?|paytm|phonepe|gpay|google pay|venmo|cash ?app|paypal|zelle|upi)\b/,
  /\b(reward|fee|payment)\s+(first|upfront|in advance)\b/,
];

/** NFKC folds full-width and similar forms; zero-width characters are stripped. */
function normalise(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, '')
    .replace(/\s*[[({]\s*(\.|dot)\s*[\])}]\s*/gi, '.')
    .replace(/\s+dot\s+/gi, '.');
}

export function moderateResponse(text: string): ModerationVerdict {
  const original = text.normalize('NFKC');
  const folded = normalise(text).toLowerCase();
  // Case-sensitive Base58 patterns run on the unlowered text.
  if (CRYPTO_PATTERNS.some((p) => p.test(original) || p.test(folded))) {
    return { held: true, reason: 'crypto_address' };
  }
  if (URL_PATTERNS.some((p) => p.test(folded))) {
    return { held: true, reason: 'url' };
  }
  if (UPI_PATTERN.test(folded)) {
    return { held: true, reason: 'upi_id' };
  }
  if (PAYMENT_PATTERNS.some((p) => p.test(folded))) {
    return { held: true, reason: 'payment_phrase' };
  }
  return { held: false };
}

export type HeldResponseAction = 'release' | 'reject';

/**
 * The operator's decision on a held response. False when `responseId` is not a held response
 * awaiting a decision (unknown, never held, or already decided), in which case nothing changed.
 */
export function decideHeldResponse(
  db: Pick<ServerDb, 'releaseHeldResponse' | 'rejectHeldResponse'>,
  responseId: string,
  action: HeldResponseAction,
  now: number,
): boolean {
  return action === 'release'
    ? db.releaseHeldResponse(responseId, now)
    : db.rejectHeldResponse(responseId, now);
}
