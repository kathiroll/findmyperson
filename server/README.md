# @findmyperson/server

Report intake and response relay (plan section 9). Fastify, Node's built-in SQLite, and the shapes in `@findmyperson/shared`; the route table comes from `API_ENDPOINTS`.

## The manual-review gate

Every report is `pending` on submit. Nothing pending is ever broadcast; only the operator's release moves it on (`src/lifecycle.ts`).

- `pending -> released | rejected`, both final, no automatic transition. A reporter sees the state in `review_state` (`GET /v1/reports/:id`).
- `ServerDb.listBroadcastable` is the only read the shard compiler uses: released, active, unexpired.
- On submit the operator alert fires (`src/alerts.ts`). It is a logged `report.pending` event; a real push/SMS/email channel plugs in there.
- Operator routes (`/v1/operator/...`): list, `release`, `reject`, held responses. Auth is a device-id allow-list on the forgeable stub (`FMP_OPERATOR_DEVICE_IDS`, empty means nobody). **Needs real operator authentication before this is exposed** (`src/operator.ts`).

## The shard compiler (plan 7, task B3.4)

`compileShards` in `src/shards/compiler.ts` turns the released reports into the signed static files devices fetch by location; the header of that file is the full account. One pass reads `listBroadcastable`, signs each report as a broadcast query, files it under every res-5 and res-3 shard its search area touches, and makes the object store match.

**Layout** (the paths of `@findmyperson/shared`, `payload/bundle.ts`, relative to the CDN origin):

| Path                                  | What                                                                | Cache               |
| ------------------------------------- | ------------------------------------------------------------------- | ------------------- |
| `/index.json`                         | Signed index: every shard that has reports, and its generation      | 60 s, replaced      |
| `/shards/<h3 cell>/<generation>.json` | Signed bundle of one shard; `<h3 cell>` is a res-5 or res-3 cell id | immutable, new path |

- A shard with no reports is absent from the index and has no bundle. A superseded or emptied bundle is deleted on publish, so a 404 on a bundle means "read the index again".
- **Generations** go up only when a shard's queries changed, never because a pass ran, and are never reused: the numbering lives in the `shard_generations` table, which must not be reset while devices hold caches. A signing-key switch re-signs everything, so it moves every shard up once.
- **Keys** (`src/shards/keys.ts`): Ed25519, several at once, each with `sign_from` and `verify_until`, so a new key can be announced, take over, and overlap with the old one. The rotation steps are at the top of that file.
- **Run it**: the server runs a pass every `FMP_SHARD_INTERVAL_SEC` (default 60) when `FMP_SHARD_OUT_DIR` is set; `src/shards/cli.ts compile` runs one pass and `cli.ts keygen <key_id>` makes a key. The environment is listed in `src/shards/worker.ts`. Run one compiler per store.
- **Not built: the bucket and CDN adapters.** No provider has been chosen. Publishing goes through two interfaces in `src/shards/storage.ts`; what exists is a store over a directory and a CDN stub that logs the paths it was asked to purge and purges nothing.

**Bundle size, synthetic 100-report shard** (measured and asserted in `src/shards/bundleSize.test.ts`):

| 100 reports in one res-5 shard                | Bytes     | gzip -9   | Per report          |
| --------------------------------------------- | --------- | --------- | ------------------- |
| Typical: 9 KB thumbnail (12,000 base64 chars) | 1,274,566 | 915,251   | 12.7 KB (9.2 gzip)  |
| No photo                                      | 69,066    | 8,853     | 0.7 KB              |
| Largest photo the schema allows               | 3,351,366 | 2,529,364 | 33.5 KB (25.3 gzip) |

The photo is nearly all of it, compression only undoes its base64 expansion, and a device re-downloads the whole bundle when any report in its shard changes.

## Decisions built as decided (addendum 2026-10-03)

- One response per `(report, device)`: a UNIQUE constraint, no other cap.
- Device identity is the plain client-generated id; no attestation or phone verification.
- Moderation (`src/moderation.ts`): text with a link or payment identifier is held and logged; everything else is delivered. Regex heuristic, limits documented in the file.

## Open points for review

- A widening edit on an already-released report stays released (no re-review), so a poster could widen after the call.
- `ReportSchema.review_state` is additive and optional; while it is not `released`, `status` is a placeholder. The app's `own_report` table and `applyServerReport` do not know `review_state` yet.
- Push to the reporter on a new response is not built (separate task).
- The run command below does not work under plain Node: the sources import each other without file extensions and use constructor parameter properties, which Node's type stripping does not handle. The tests run through Vitest, which does. The server and `src/shards/cli.ts` were run by hand with `--experimental-transform-types` and a resolver hook; a runner or a build step is still to be chosen.
- The plan names h3's `polygonToCells` + `compactCells` for the shard cover. The compiler uses `searchAreaCells` and `shardKeysForCells` from `@findmyperson/shared` instead, because `polygonToCells` is not a cover and devices derive shards the shared way.

Run: `FMP_OPERATOR_DEVICE_IDS=<id> node src/main.ts`.
