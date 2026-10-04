# @findmyperson/shared

The contracts every other part of findmyperson imports: what a report, a stay, a match, a signature and an API call look like. They are defined once, here. The app, the server and the native modules build against these definitions and do not write their own.

It is pure TypeScript with no I/O, no clock and no randomness of its own, so the same code runs on the server (Node) and in the app (Hermes). Anything that needs a runtime service takes it as an argument: the Ed25519 primitive, the SQLite driver, the random bytes for an id.

## Map

| Area                    | Files                                                | What it defines                                                                                    |
| ----------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Constants               | `src/constants.ts`                                   | 150 m, 30 min, 30 days, H3 resolutions, size caps. Each says whether it is decided or provisional  |
| Geometry                | `src/geo/distance.ts`                                | `haversineMeters`, the only distance function                                                      |
| Geo-sharding            | `src/geo/h3.ts`                                      | Cell of a point, shard and push cells, neighbour ring, search-area cover                           |
| Canonical JSON, signing | `src/payload/canonical.ts`, `src/payload/signing.ts` | The bytes that are signed and how a signature is written                                           |
| Broadcast payload       | `src/payload/query.ts`, `src/payload/bundle.ts`      | `BroadcastQuery`, `ShardBundle`, `ShardIndex`, and verified reading of both files                  |
| Widen-only edit rule    | `src/payload/widening.ts`                            | `isWideningEdit`, `classifyCriteriaEdit`                                                           |
| API shapes              | `src/api/`                                           | The six endpoints, the error shape, the idempotency convention                                     |
| Device identity seam    | `src/identity/deviceIdentity.ts`                     | `DeviceIdentity`, `DeviceAuthenticator`, and in-memory stubs                                       |
| On-device store         | `src/store/`                                         | Cipher parameters, migration v1, one typed access module per table, the table-ownership list       |
| Stay derivation         | `src/stay/`                                          | `deriveStays`, the writer of 'derived' rows in `stay`, and the pure `extractStays`. See below      |
| Matching                | `src/match/`                                         | `matchReport`, the rule that decides whether a device's history crossed a report. See below        |
| Retention               | `src/retention/`                                     | `purgeExpired`, the weekly `VACUUM`, and `createRetentionMaintenance`, the store's hook. See below |
| Bundle fetcher          | `src/fetch/`                                         | `runFetchCycle`: the signed index and shard bundles, verified, into `report_cache`. See below      |
| Cross-language files    | `contracts/`                                         | Golden vectors and generated copies for Kotlin, Swift and third parties. See its README            |

`src/testing/` is test support (in-memory SQLite, Ed25519 from Node's crypto, sample documents). It is not exported and may use Node freely; nothing else in `src/` may, and `src/purity.test.ts` enforces that.

## Choices worth knowing

- **Schema library: zod.** It was already installed by the workspace task and named by the architecture plan, it gives the TypeScript type and the runtime check from one definition, and zod 4 emits JSON Schema itself, which is how the files under `contracts/` are produced. No schema transforms its input, because a signed document must be canonicalised from the bytes as received.
- **Verify before parsing.** Signatures are checked on the raw JSON value, then a schema is applied. `readShardBundle` and `readShardIndex` do both in that order; use them instead of calling the pieces.
- **Unknown versions are skipped, unknown members are ignored.** `parseBroadcastQuery` checks `v` first and never parses a version it does not know.
- **The widen-only rule is a coverage test.** An edit is allowed when the new search disc covers the old one and the new window contains the old one. A per-edit distance allowance was rejected because it can be spent again on every edit. The reasoning is at the top of `src/payload/widening.ts`.
- **A shard is the parent of a res-7 cell,** not the res-5 cell containing the point. See `shardCellOf` in `src/geo/h3.ts`.
- **The schema version is `PRAGMA user_version`.** TypeScript owns migrations; the native modules only check the version and run the statements in `contracts/native-writer.json`.
- **This package opens nothing.** The store section defines the schema, the migrations and the queries over a `SqlDatabase`. `@findmyperson/encrypted-store` supplies that database on a phone: the key, the backup-excluded file, the cipher checks and the native writer.
- **Seams, not policy.** Device identity, reporter verification and rate limiting are open captain decisions. This package fixes the interface each one plugs into (`DeviceIdentity`, the `phone_verification` field, the `rate_limited` error) and implements none of them.

## Stay derivation

`deriveStays(db)` turns the fixes the native module has written since the last run into `stay` rows. Call it on every capture wake and every app foreground, before matching (which reads the rows) and before the retention purge (which would otherwise delete fixes not yet looked at). It takes no clock and returns the ids it inserted, updated and deleted. `extractStays(samples, visits)` is the same rules as a pure function over a list, for the offline matching harness and for tests.

The rules are at the top of `src/stay/extract.ts`; `contracts/stay-vectors.json` holds a worked trace for each. In short: fixes within 150 m of their running centroid for 15 minutes are an open stay, the first fix beyond 150 m closes it, and a stay that resumes at the same place within `STAY_MERGE_GAP_SEC` continues the earlier row.

- **Restarts.** Nothing is kept in memory between runs. The open 'derived' row is the dwell in progress, and a run continues from its columns; the `kv` cursor is the last fix finished with, and the fixes of a dwell still too short to be a stay are after it and are read again. A run is one transaction, so a process killed part-way leaves no trace. A stay therefore survives any number of restarts as one row, and closes on the first fix elsewhere, however much later that is.
- **Visit rows (iOS).** A closed row from another writer covers its interval within 150 m of its coordinate, and nothing is derived there. iOS reports a visit minutes to hours late, usually after the same dwell was derived from fixes, so each run first removes any 'derived' row a closed visit now overlaps and derives that stretch again; only what the visit does not cover comes back. Visit rows are never written here. With no visit rows (Android) every stay is derived.
- **An open visit row covers nothing.** It records an arrival, and iOS sometimes never reports the departure. Until it does, an open 'visit' row and an open 'derived' row can both describe the dwell in progress; once the departure is written the derived one goes.
- **A deleted id can still be named by a `match`.** `StayDerivationResult.deleted` lists the 'derived' rows a run removed. A match whose `stay_id` is one of them has lost that row; a row covering the same place and time is still in the table.

Limits a consumer should know:

- A stay has no maximum time between fixes, so it also bridges a stretch in which capture was off altogether, if the device is at the same place on both sides. The plan gives no gap threshold; adding one is a decision for whoever owns matching quality.
- Every stored fix counts, whatever its `accuracy_m`. One wild fix closes a stay; if the device is back within the merge gap the stay continues, otherwise there are two.
- Fixes are taken in stored order. If the clock was set back their times are not in order, and stays derived either side of the change can overlap in time.

## Matching

`matchReport(query, history, params)` returns the evidence in a device's history that it crossed the path of the person in a report: every matching stay, or, when no stay matches, every matching sample. The strongest evidence is first and the list is empty when there is none. It opens no store and reads no clock; the caller passes the rows and the time.

```ts
const results = matchReport(report.query, { stays, samples }, matchParamsAt(nowSeconds));
if (results[0] !== undefined) {
  await insertMatchIfAbsent(db, { ...results[0], created_at: nowSeconds });
}
```

The rule is at the top of `src/match/matchReport.ts`, and `contracts/match-vectors.json` holds a worked case for each branch and each boundary. In short: evidence is a stay that overlaps, or a sample taken inside, `[window.from - 30 min, window.to + 30 min]`, within `radius_m + 150 m` of the report's centre.

- **The criteria are read on a grid, and that is a security property.** Before the rule is applied the radius is rounded up to a multiple of 150 m and the two ends of the window are rounded outward to 30-minute marks (`coarsenCriteria`). Plan 8.3 relies on a reporter gaining nothing from precision finer than the two constants. The rule as plan 8.1 writes it does not give that: a 5 m radius reaches 155 m and a 140 m radius reaches 290 m, so the two reports differ on anyone in between. Read on the grid they are the same report. Two reports that agree on the grid return identical results on any history; the tests under "anti-oracle" check that, and check that the rule without the rounding would tell the reports apart. Do not add a way to match more finely.
- **The rounding is outward only.** Nothing the rule finds on the report as written is lost, and a report already on the grid (radius 0, 150, 300 and so on, window ends on a half hour) is matched exactly as written. The price is reach: up to 150 m and 30 minutes beyond the report as written, which is more notifications. `server/README.md` has the measured cost.
- **Pick rows with `matchBounds`, not with the report as written.** It gives the time range and the distance outside which nothing is evidence, and it is null when nothing can be. The res-7 cover to read is `searchAreaCells(coarse.center, coarse.radius_m)` for `coarse = coarsenCriteria(query, params)`; the report's own `cells` is the cover of the radius as written and can be a cell short.
- **`now` decides two things.** A report at or past `expires_at` matches nothing. History older than `RETENTION_SEC` is not evidence, exactly as if the purge had just run, so a phone whose purge is late matches the same as one whose purge is not.
- **A result is a `match` row without its time.** `{ ...result, created_at }` is a `NewMatch`.

Limits a consumer should know:

- Nothing calls `matchReport` yet. The match runner (retrospective and prospective passes, the `last_matched_at` cursor) is a separate task.
- `dt_sec` is measured from the window as read on the grid, so it is never more than 30 minutes; it is not the distance in time from the window as written.
- Every row counts, whatever its `accuracy_m` and whichever writer made it. A fix from a cell tower can be hundreds of metres off and match or miss on that error. An open visit row counts as the instant of its arrival.
- The centre is not rounded. Moving the pin between reports is the attack the one-report-a-day limit bounds.
- The widen-only rule (`src/payload/widening.ts`) judges criteria as written. An edit it permits can move the pin inside one 150 m step, and on the grid that moves the search disc without growing it, so evidence at the far edge matches the old revision and not the new one. A reporter cannot see this happen: a device that already matched keeps its `match` row and nothing is reported back. Rounding the radius at intake, before the edit rule looks at it, would close it; that is not done.

## Retention

"Kept for 30 days, then deleted" is made true by one function. Pass it to the store when opening it, and call `store.runMaintenance(now)` on every app foreground and on every capture wake that runs JavaScript:

```ts
const store = await openStore({
  vault,
  driver,
  maintenance: createRetentionMaintenance({ deviceConditions }),
});
await store.runMaintenance(nowSeconds);
```

One run is `runRetention(db, nowTs, options)`: `deriveStays`, then `purgeExpired`, then `vacuumIfDue`. Call `runRetention` directly to get what it did back.

What the purge deletes, as of the time it is given:

| Table               | Deleted                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `location_sample`   | fixes older than `RETENTION_SEC`                                                         |
| `stay`              | rows that ended before that cutoff; a row still running across it has its start moved up |
| `report_cache`      | reports at or past `expires_at`                                                          |
| `match`             | rows whose report is no longer cached                                                    |
| `outbound_response` | sent and failed tips older than `OUTBOUND_RESPONSE_TERMINAL_RETENTION_SEC` (7 days)      |

- **It remembers nothing.** The cutoff is computed from the time passed in, on every run, and no run is skipped because of an earlier one. After the app was closed for weeks, or the clock was changed, one run deletes everything that is then past retention. `purge.last_run_at` is written for diagnostics and never read.
- **One transaction.** Fixes and stays go by the same cutoff together, so no stay claims a time whose fixes are gone and no fix outlives its stay. `deriveStays` is one transaction as well, and the store's connection runs one at a time, so the purge never sees half a derivation run. Two `runRetention` calls at once are one run.
- **A stay longer than retention is cut, not kept whole.** A phone that has not moved for 40 days has a stay 30 days long. Its row and id stay; `sample_count` and the centroid still count the fixes that were deleted.
- **Derivation runs first, inside the run.** If it throws, the purge still runs and the error is thrown afterwards. Purging first would also leave nothing before the cutoff; deriving first keeps the row a `match` may name.
- **The derivation cursor follows.** Sample ids are rowids, so deleting the newest rows lets later fixes take ids the cursor has already passed. The purge pulls the cursor back in the same transaction.
- **The vacuum** runs at most once per `VACUUM_INTERVAL_SEC`, and only when `deviceConditions()` says the phone is both charging and idle. No answer counts as not charging. It is followed by a WAL checkpoint, without which the file on disk does not shrink. A vacuum that fails (the native writer was busy) is not recorded and is tried on the next run. Nothing schedules it: a vacuum that is due waits for the next run that finds the phone charging and idle. `vacuum: 'disabled'` in the options switches it off altogether, and every run then reports `disabled`.

Who calls it, and what happens when nobody can:

- **The app** (`app/src/store/`) opens the store and calls `runMaintenance` when it starts, every time it returns to the foreground, and on every stored sample the capture module reports. `deviceConditions` is the capture module's `getDeviceConditions`.
- **A capture wake with no JavaScript** purges natively. Both capture modules run the four purge statements of `contracts/native-writer.json` (`deleteSamplesBeforeSql`, `deleteStaysEndedBeforeSql`, `trimStaysStartedBeforeSql`, `rewindStayCursorSql`) in one transaction, with the cutoff `retentionSec` behind the device clock, at most once an hour per process. They are the statements `purgeExpired` itself runs on those two tables, so a phone on which the app is never opened still holds 30 days of fixes and stays and no more. `src/store/nativeWriter.test.ts` holds the native sequence to the TypeScript purge on 60 days of data. The other three tables hold no location history and wait for the TypeScript purge.

Limits a consumer should know:

- **The vacuum is switched off on Android.** `ANDROID_VACUUM_ENABLED` in `app/src/store/retention.ts` is false, so the app passes `vacuum: 'disabled'` there. `packages/encrypted-store/README.md` describes why: the TypeScript and Kotlin connections do not see each other's file locks, and a fix written while `VACUUM` rewrites the file is a far longer exposure than a fix meeting a single write. Settle that question, then set the flag. On iOS the vacuum runs.
- **No wake, no purge.** The native purge runs on capture wakes and the TypeScript one when the app runs. A phone on which capture was stopped and the app is never opened again is woken by neither, and keeps what it has until the app is next opened. Closing that needs a scheduled job of its own on each platform.
- **Idle is rare while JavaScript runs.** At start and on a foreground the app is on screen, so the vacuum waits. Its moment is a capture wake that reaches JavaScript with the app in the background and the phone on a charger.
- **Adding a purged table or column** that holds location history needs its statement in `purgeExpired`, in `NATIVE_WRITER_CONTRACT`, and in the purge of both capture modules; their contract tests fail until a new key is accounted for.
- **Rows dated in the future are kept.** A fix stored while the clock was ahead of where it is now is deleted only once the clock passes its date by 30 days. Deleting such rows would empty the store whenever a phone starts with its clock unset. A clock that jumps forward does delete everything it puts past retention.
- **`own_report`, `received_response` and `subscription` are not purged,** nor is a tip still waiting to be sent. `src/store/ownership.ts` records that retention for the first two is undecided.
- **A `match` can outlive its evidence.** Its `stay_id` or `sample_id` may name a row the purge has deleted while the report is still live. The match is kept, because deleting it would allow a second notification for the same report.
- **A time in milliseconds is refused** (`RangeError`), since it would put the cutoff after every row.

## Bundle fetcher

`runFetchCycle(db, input)` is one fetch cycle: read the signed `/index.json`, fetch the shard bundles whose generation moved, verify them, and write them to `report_cache`. It keeps nothing in memory and needs no UI, so a cold background wake can call it. The top of `src/fetch/cycle.ts` is the full account.

```ts
const result = await runFetchCycle(store.db, {
  watch, // the shard-key list: H3 cell ids at res 5 or res 3, e.g. every `subscription.topic`
  nowTs, // Unix seconds
  transport, // FetchTransport: one GET per call (the app's is app/src/fetch/httpTransport.ts)
  trustedKeys, // the publisher's public keys, pinned in the app
  verify, // Ed25519Verify
  random, // () => number in [0, 1)
  network, // optional: () => Promise<{ metered: boolean }>
});
if (result.rematch > 0) {
  /* run the retrospective match pass */
}
```

- **The shard-key list is an input.** `watch` is a plain array of shard cells, the whole list on every call. Computing it is the subscription manager's job.
- **Nothing unverified is stored.** A bundle with a bad or missing signature, an untrusted key, or the signature of another shard or generation is dropped, reported through `log` only, and counted as a failed cycle so that backoff spaces out the next try.
- **One write per cycle.** Reports, removals, what is held of each shard and the index go into one transaction at the end. A cycle that fails before it has changed nothing; a bundle is stored whole or not at all. Reports a shard no longer lists are removed once no followed shard lists them.
- **Constant request count.** A cycle that reads an index makes exactly `FETCH_SHARD_REQUESTS_PER_CYCLE` shard requests after it, whatever the watch list or the changes. Changed shards beyond that wait (`result.deferred`); spare slots revalidate unchanged shards with `If-None-Match`, which costs one 304 each.
- **Cover shards.** The device also follows `FETCH_COVER_SHARDS` shards it does not need, chosen from its own res-3 regions by a secret in the store, and treats them exactly as watched ones. Their reports are in `report_cache` too, so nothing may present that table as "near you".
- **Metered connections.** With `network` reporting metered, or not answering, a cycle is put off until `FETCH_METERED_INTERVAL_SEC` after the last complete one, unless shards are still waiting or none ever completed.
- **Backoff.** After a failed cycle, calls return `skipped` without a request for `FETCH_BACKOFF_BASE_SEC`, doubling per failure up to `FETCH_BACKOFF_MAX_SEC`.

Limits a consumer should know:

- **Padding hides which followed shards the device was in, not that it fetched.** The CDN operator still sees the followed set as a whole, and so roughly the region. What else it does not hide is listed in `src/fetch/cycle.ts`.
- **How often to call is the caller's decision** on an unmetered connection. Each cycle is `1 + FETCH_SHARD_REQUESTS_PER_CYCLE` requests.
- **A shard dropped from the watch list keeps its reports** until they expire. Nothing deletes them on the way out, so a watch list that is briefly wrong cannot empty the cache.
- **The five `FETCH_*` constants are provisional.** None has been measured against real traffic.
- **Not built here:** the Ed25519 primitive for Hermes, the pinned key list, the CDN origin and the native answer to "is this connection metered". Each is an input.

## Exported types

Runtime exports are listed, and pinned, in `src/index.test.ts`. The exported types are:

- Geometry: `LatLon`, `H3Cell`
- Payload: `BroadcastQuery`, `UnsignedBroadcastQuery`, `ParsedBroadcastQuery`, `MatchCriteria`, `Person`, `PersonPhoto`, `TimeWindow`, `QueryId`, `ShardBundle`, `ShardIndex`, `VerifiedQuery`, `VerifiedBundle`
- Signing: `SignedKind`, `Ed25519Sign`, `Ed25519Verify`, `TrustedKeys`, `VerifyResult`, `VerifyFailure`
- Widen-only rule: `EditVerdict`, `EditViolation`
- API: `ApiErrorCode`, `ApiErrorBody`, `ApiErrorDetail`, `ApiEndpointName`, `IdempotencyKey`, `PushToken`, `DeviceRegistrationRequest`, `DeviceRegistrationResponse`, `ReportSubmitRequest`, `Report`, `ReportStatus`, `ReviewState`, `ReportResponse`, `ReportPatchRequest`, `PersonPatch`, `ReportEndRequest`, `EditableReport`, `ResponseSubmitRequest`, `ResponseSubmitResponse`, `ReceivedResponse`, `ResponseListQuery`, `ResponseListResponse`
- Identity: `DeviceId`, `DeviceIdentity`, `DeviceAuthenticator`, `AuthenticatedDevice`
- Stay derivation: `StaySample`, `CoveringStay`, `StayDerivationResult`
- Matching: `MatchQuery`, `MatchHistory`, `MatchStay`, `MatchSample`, `MatchParams`, `MatchResult`, `MatchBounds`
- Retention: `PurgeResult`, `DeviceConditions`, `RetentionOptions`, `RetentionRun`, `VacuumOutcome`
- Bundle fetcher: `FetchCycleInput`, `FetchCycleResult`, `FetchFailure`, `FetchLogEntry`, `FetchTransport`, `FetchRequest`, `FetchResponse`, `NetworkConditions`
- Store: `SqlValue`, `SqlRow`, `SqlExecutor`, `SqlDatabase`, `CipherParams`, `Migration`, `StoreTable`, `WritePath`, `LocationSample`, `NewLocationSample`, `SampleSource`, `Stay`, `NewStay`, `StayUpdate`, `StaySource`, `CachedReport`, `UpsertOutcome`, `Match`, `NewMatch`, `MatchState`, `Subscription`, `SubscriptionReason`, `OutboundResponse`, `NewOutboundResponse`, `OutboundResponseState`, `OwnReport`, `OwnReportState`, `StoredResponse`

## Commands

```sh
pnpm exec vitest run packages/shared       # this package's unit tests; no device or network
pnpm exec vitest run packages/shared -u    # also rewrite the generated files in contracts/
pnpm --filter @findmyperson/shared typecheck
```
