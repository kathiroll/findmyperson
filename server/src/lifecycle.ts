import type { ReviewState } from '@findmyperson/shared';

/**
 * THE REPORT LIFECYCLE: the manual-review gate (plan addendum 2026-10-03).
 *
 *   pending --release--> released     the operator confirmed it by phone; now broadcastable
 *   pending --reject---> rejected     the operator declined it; never broadcast
 *
 * Every report is born `pending`. `released` and `rejected` are final. There is no automatic
 * transition: nothing in the server (timer, widening edit, retry, idempotent replay) calls
 * `transition`; only the operator-only release and reject endpoints do.
 *
 * Only `released` reports may reach a shard bundle, a compiled broadcast or any device. The one
 * place that expresses that is `listBroadcastable` in db.ts, and the shard compiler must read
 * reports only through it.
 */

export type ReviewAction = 'release' | 'reject';

export const INITIAL_REVIEW_STATE: ReviewState = 'pending';

const NEXT_STATE: Readonly<Record<ReviewAction, ReviewState>> = {
  release: 'released',
  reject: 'rejected',
};

export type Transition =
  { ok: true; next: ReviewState } | { ok: false; reason: 'already_decided'; current: ReviewState };

/** The only legal moves are pending -> released and pending -> rejected. */
export function transition(current: ReviewState, action: ReviewAction): Transition {
  if (current !== 'pending') {
    return { ok: false, reason: 'already_decided', current };
  }
  return { ok: true, next: NEXT_STATE[action] };
}
