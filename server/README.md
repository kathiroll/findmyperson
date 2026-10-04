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
- **Run it**: the server runs a pass every `FMP_SHARD_INTERVAL_SEC` (default 60) when `FMP_SHARD_OUT_DIR` is set; `dist/cli.js compile` (from `src/shards/cli.ts`) runs one pass and `dist/cli.js keygen <key_id>` makes a key. The environment is listed in `src/shards/worker.ts`. Run one compiler per store.
- **Cloudflare R2 and cache purge** (`src/shards/r2.ts`). `R2ObjectStore` talks to R2's S3 API (SigV4, region `auto`, `node:crypto` + `fetch`, no SDK); `CloudflareCdnInvalidator` calls the zone's `purge_cache` API in batches of 30 URLs. Bundle puts carry `immutable` cache headers and `index.json` a 60 s one. A failed purge throws, and the compiler retries those paths next pass. Environment (all deployment secrets or config, never committed; setting `FMP_R2_BUCKET` selects R2 over `FMP_SHARD_OUT_DIR`, and a partial set fails at start):

  | Variable                                            | What                                                                         |
  | --------------------------------------------------- | ---------------------------------------------------------------------------- |
  | `FMP_R2_BUCKET`                                     | Bucket name                                                                  |
  | `FMP_R2_ACCOUNT_ID`                                 | Cloudflare account id (the S3 endpoint is `<id>.r2.cloudflarestorage.com`)   |
  | `FMP_R2_ACCESS_KEY_ID` / `FMP_R2_SECRET_ACCESS_KEY` | R2 API token's S3 credentials, Object Read & Write on that bucket only       |
  | `FMP_CDN_ORIGIN`                                    | Public https origin devices fetch from (the bucket's custom domain), no path |
  | `FMP_CDN_ZONE_ID`                                   | Zone that owns that domain                                                   |
  | `FMP_CDN_API_TOKEN`                                 | Cloudflare API token with Zone > Cache Purge on that zone only               |

  The tests use a fake S3 endpoint; a live-bucket test runs only when `FMP_R2_TEST_BUCKET`, `FMP_R2_TEST_ACCOUNT_ID`, `FMP_R2_TEST_ACCESS_KEY_ID` and `FMP_R2_TEST_SECRET_ACCESS_KEY` are set, and is skipped otherwise. R2 serves directly only through a custom domain (not `r2.dev` in production), which is what `FMP_CDN_ORIGIN` must be; the device-side origin setting is a separate task and must use the same value.

**Bundle size, synthetic 100-report shard** (measured and asserted in `src/shards/bundleSize.test.ts`):

| 100 reports in one res-5 shard                | Bytes     | gzip -9   | Per report          |
| --------------------------------------------- | --------- | --------- | ------------------- |
| Typical: 9 KB thumbnail (12,000 base64 chars) | 1,274,566 | 915,251   | 12.7 KB (9.2 gzip)  |
| No photo                                      | 69,066    | 8,853     | 0.7 KB              |
| Largest photo the schema allows               | 3,351,366 | 2,529,364 | 33.5 KB (25.3 gzip) |

The photo is nearly all of it, compression only undoes its base64 expansion, and a device re-downloads the whole bundle when any report in its shard changes.

## The offline matching harness (plan 8.4, task M5.1)

`src/harness/` runs `matchReport` from `@findmyperson/shared`, unchanged, over synthetic populations, and measures how many of the people who really crossed a missing person's path it finds and how many others it notifies. It is a measuring tool: the running server does not import it.

```
pnpm --filter @findmyperson/server harness
node server/dist/match-harness.js --scenario dense-urban --devices 8000 --reports 600 --seed 7
node server/dist/match-harness.js --capture-rate 0.4 --outage-min 240 --json
```

The same options and seed always print the same numbers. The defaults, 4,000 phones and 400 reports per scenario, take about a minute.

**What is simulated** (`mobility.ts`; every assumption is a named number there). Three days of a population in a square area: homes, workplaces and venues for all its residents, and a sample of those residents carrying the app, who commute, run errands and go out. Each phone stores one fix per 15 minutes, loses 20% of them in runs of about an hour, and gets each fix wrong by 10 to 20 m normally, 70 to 90 m when degraded, and 450 to 600 m on a cell tower alone. Stays are what `extractStays` makes of the fixes. Nothing here comes from real users.

| Scenario    | Area    | Residents per km2 | Layout                                                 |
| ----------- | ------- | ----------------- | ------------------------------------------------------ |
| dense-urban | 25 km2  | 20,000            | Blocks of flats, 3,750 venues, 6,000 workplaces        |
| suburban    | 64 km2  | 2,500             | Houses; shops and work gathered around a dozen centres |
| rural       | 900 km2 | 120               | 25 villages, farms between them                        |

**What is measured** (`evaluate.ts`). A report is one simulated person last seen at some moment of the second day, with the pin off by up to 0.8 of the stated radius (100, 250, 500 or 1,000 m) and a stated window of 30 minutes to 4 hours that holds the moment. The truth is worked out from true positions, minute by minute:

- **crossed**: at some minute of the window the missing person was inside the stated area and this person was within 50 m of them. "Still" if the bystander was then in a stop of 15 minutes or more, "moving" otherwise.
- **in the area**: did not cross, but was truly inside the stated area during the stated window.
- **outside**: neither.
- **recall**: crossers that matched, out of all crossers. **False-positive rate**: phones that matched without crossing, out of all that did not cross; it is a share of every phone in the simulated area, so it shrinks as the area grows, and the count per report is the figure to read. **Precision**: crossers among the phones that matched.

Counts per report are for 10% of residents carrying the app and scale in proportion with that share.

**Results at the shipped parameters** (150 m, 30 minutes, criteria read on the grid), default run, seed 20261004:

| Scenario    | Recall | still | moving | False-positive rate | Precision | Notified per report | crossed | in the area | outside |
| ----------- | ------ | ----- | ------ | ------------------- | --------- | ------------------- | ------- | ----------- | ------- |
| dense-urban | 79.6%  | 97.0% | 58.4%  | 8.24%               | 1.4%      | 4,171               | 58      | 1,700       | 2,414   |
| suburban    | 82.9%  | 96.1% | 40.0%  | 4.59%               | 2.2%      | 750                 | 16      | 306         | 427     |
| rural       | 90.7%  | 96.2% | 66.1%  | 1.59%               | 3.5%      | 177                 | 6.2     | 71          | 100     |

**What other parameters would do.** "As written" is the rule of plan 8.1 with no rounding of the criteria, which does not have the anti-oracle property (see "Matching" in `packages/shared/README.md`); "half" and "double" are the same design at 75 m / 15 min and 300 m / 60 min.

| Scenario    | Parameters | Recall | False-positive rate | Notified per report |
| ----------- | ---------- | ------ | ------------------- | ------------------- |
| dense-urban | as written | 76.5%  | 6.43%               | 3,263               |
| dense-urban | half       | 74.9%  | 5.59%               | 2,843               |
| dense-urban | double     | 88.2%  | 16.09%              | 8,095               |
| suburban    | as written | 81.3%  | 3.54%               | 581                 |
| suburban    | half       | 80.2%  | 3.06%               | 504                 |
| suburban    | double     | 87.8%  | 9.11%               | 1,473               |
| rural       | as written | 88.8%  | 1.26%               | 142                 |
| rural       | half       | 87.2%  | 1.10%               | 125                 |
| rural       | double     | 93.6%  | 2.82%               | 311                 |

**With poor capture** (`--capture-rate 0.4 --outage-min 240`: 40% of slots, losses four hours at a time), shipped parameters:

| Scenario    | Recall | still | moving | False-positive rate | Notified per report |
| ----------- | ------ | ----- | ------ | ------------------- | ------------------- |
| dense-urban | 58.5%  | 73.1% | 40.7%  | 5.68%               | 2,880               |
| suburban    | 58.1%  | 67.7% | 27.2%  | 3.12%               | 510                 |
| rural       | 65.9%  | 70.2% | 46.8%  | 1.09%               | 122                 |

Reading the numbers:

- **Someone who was stopped near the missing person is found: 96 to 97% in all three scenarios.** Someone moving past is found 40 to 66% of the time. That is the dwell-based design the granularity report describes, and it is where nearly all the missed crossings are.
- **Recall follows capture, not the constants.** At 40% capture it falls to 58 to 66%. Doubling both constants adds 3 to 9 points with healthy capture and 6 to 11 with poor capture, and nearly doubles the notifications either way.
- **Almost everyone notified did not cross.** In the dense city a report notifies about 4,200 phones at 10% adoption, of which 58 crossed: 1,300 phones for a 100 m report, 13,800 for a 1,000 m one. Precision is 1.4 to 3.5% across the scenarios.
- **The constants are not the main lever on that.** 1,700 of the 4,200 were truly inside the area the reporter stated, so no allowance however small gets dense-urban precision above about 3%. The rest, 58% of notifications, are the cost of the 150 m and 30 minutes, the grid and fix error; for a 100 m report they are 88%. Halving the constants removes a third of the dense-urban notifications and 5 points of its recall. The stated radius and the share of people carrying the app decide the volume.
- **Reading the criteria on the grid costs 25 to 29% more notifications** than the rule as written and finds 2 to 3 points more crossers.

Limits of the measurement:

- It is a model. The absolute figures move with its assumptions, above all the mix of radii reporters state and the 50 m that defines a crossing; the comparisons between rows are steadier than any one figure.
- Every phone captures equally well, every stay is derived from fixes (no iOS visit rows), travel is a straight line, and all three days are working days.
- A pass at vehicle speed between two whole minutes is not counted as a crossing, so it is in neither recall figure.
- Reports whose pin is within 1,500 m of the edge of the area are not used, so that every search area is full of people.
- `harness.test.ts` runs a smaller version (1,000 phones, 100 reports) with the unit tests and holds its figures within a band; it guards against change, and the tables above are from the full run.

## Decisions built as decided (addendum 2026-10-03)

- One response per `(report, device)`: a UNIQUE constraint, no other cap.
- Device identity is the plain client-generated id; no attestation or phone verification.
- Moderation (`src/moderation.ts`): text with a link or payment identifier is held and logged; everything else is delivered. Regex heuristic, limits documented in the file.

## Open points for review

- A widening edit on an already-released report stays released (no re-review), so a poster could widen after the call.
- `ReportSchema.review_state` is additive and optional; while it is not `released`, `status` is a placeholder. The app's `own_report` table and `applyServerReport` do not know `review_state` yet.
- Push to the reporter on a new response is not built (separate task).
- The plan names h3's `polygonToCells` + `compactCells` for the shard cover. The compiler uses `searchAreaCells` and `shardKeysForCells` from `@findmyperson/shared` instead, because `polygonToCells` is not a cover and devices derive shards the shared way.

## Running it

The sources import each other, and `@findmyperson/shared`, without file extensions and the shared package ships as TypeScript, so plain `node src/main.ts` cannot load them (Node's type stripping does not resolve those imports). `build.mjs` bundles the two entries with esbuild into `dist/` (git-ignored); `node` runs that with no flags. `fastify` and `zod` stay external, so run from a checkout with `pnpm install` done.

```
pnpm --filter @findmyperson/server build
FMP_OPERATOR_DEVICE_IDS=<id> node server/dist/main.js        # or: pnpm --filter @findmyperson/server start
node server/dist/cli.js compile | keygen <key_id>
```

`src/entrypoints.test.ts` builds and runs both entries under plain `node`, so a regression fails `pnpm test`.
