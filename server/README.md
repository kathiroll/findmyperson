# @findmyperson/server

Report intake and response relay (plan section 9). Fastify, Node's built-in SQLite, and the shapes in `@findmyperson/shared`; the route table comes from `API_ENDPOINTS`.

## The manual-review gate

Every report is `pending` on submit. Nothing pending is ever broadcast; only the operator's release moves it on (`src/lifecycle.ts`).

- `pending -> released | rejected`, both final, no automatic transition. A reporter sees the state in `review_state` (`GET /v1/reports/:id`).
- `ServerDb.listBroadcastable` is the only read the shard compiler may use: released, active, unexpired.
- On submit the operator alert fires (`src/alerts.ts`). It is a logged `report.pending` event; a real push/SMS/email channel plugs in there.
- Operator routes (`/v1/operator/...`): list, `release`, `reject`, held responses. Auth is a device-id allow-list on the forgeable stub (`FMP_OPERATOR_DEVICE_IDS`, empty means nobody). **Needs real operator authentication before this is exposed** (`src/operator.ts`).

## Decisions built as decided (addendum 2026-10-03)

- One response per `(report, device)`: a UNIQUE constraint, no other cap.
- Device identity is the plain client-generated id; no attestation or phone verification.
- Moderation (`src/moderation.ts`): text with a link or payment identifier is held and logged; everything else is delivered. Regex heuristic, limits documented in the file.

## Open points for review

- A widening edit on an already-released report stays released (no re-review), so a poster could widen after the call.
- `ReportSchema.review_state` is additive and optional; while it is not `released`, `status` is a placeholder. The app's `own_report` table and `applyServerReport` do not know `review_state` yet.
- Push to the reporter on a new response is not built (separate task).

Run: `FMP_OPERATOR_DEVICE_IDS=<id> node src/main.ts`.
