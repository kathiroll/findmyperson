# App navigation shell

React Navigation 7 (native-stack only; there is no tab bar, as in the v2 mockups). `routes.ts` is the single definition of route names, params and deep links.

| Route                 | Where it lives               | Reached from                                                                     |
| --------------------- | ---------------------------- | -------------------------------------------------------------------------------- |
| `Onboarding`          | root stack (initial)         | app start                                                                        |
| `Home`                | root stack                   | after onboarding, `findmyperson://home`                                          |
| `History`, `Settings` | root stack                   | Home's hamburger menu, `findmyperson://history`, `findmyperson://settings`       |
| `CaptureHealth`       | root stack                   | Home, Settings (`SettingsScreen.onOpenCaptureHealth` is the diagnostics seam)    |
| `PermissionFlow`      | root stack                   | Onboarding, Settings, CaptureHealth (placeholders), `findmyperson://permissions` |
| `ReportForm`          | root stack                   | Home's hamburger menu ("Report a missing person"), `findmyperson://new-report`   |
| `LiveReport`          | root stack `{reportId}`      | Home, `findmyperson://report/<id>`                                               |
| `Bystander`           | root stack modal `{matchId}` | `findmyperson://match/<id>`                                                      |

Home (`app/src/home/`) is the v2 Home artboard: brand header with the hamburger, the capture-health row, "Thank you…" copy with the swipe-away note (hidden while the reporter has an active report; read from `own_report` through `DataStore.getActiveReport`, shown as a `LiveReportCard`, "under review" while the server still holds it), and the "If you're curious" list, whose links are the mockups' placeholders and go nowhere yet. The menu entries are "Report a missing person" → `ReportForm`, "History" → `History`, "Settings" → `Settings`. The mockup's "Report a bug" and "About" have no screen and are not listed until they do.

Match notifications should carry `matchNotificationUrl(id)`; reply notifications `reportNotificationUrl(id)`.

Unverified: registering the `findmyperson` URL scheme (Android intent filter, iOS `CFBundleURLTypes`) and handing a tapped notification's URL to `Linking` belong with the native projects and the notification task; nothing here ran on a device.

## Store maintenance (`app/src/store/`)

`AppNavigator` renders `StoreMaintenance` once, inside the capture and data-store providers. It calls `DataStore.runMaintenance()` at the moments `useAppWake` names: when the app starts, on every return to the foreground (`AppState` `active`) and on every `onSampleWritten` from the capture module. The first call opens the store (`createDataStore` keeps the handle, and a delete-all replaces it); each call runs `store.runMaintenance(now)`: stay derivation, the retention purge and, when due and allowed, the weekly VACUUM. It never rejects, and a store that cannot be opened is tried again at the next trigger. `AppNavigator` takes a `dataStore` prop and defaults to the real one. The vacuum is off on Android: `ANDROID_VACUUM_ENABLED` in `retention.ts`. Tests run it against a recording store and against a real SQLCipher file under Node; nothing ran on a device.

## Report fetch (`app/src/fetch/`, `DataStore.runFetchCycle`)

`AppNavigator` renders `ReportFetch` once, beside `StoreMaintenance`. Both use `useAppWake` (`app/src/store/`), the one definition of when the app does background work: at start, on every return to the foreground and on every `onSampleWritten`. At each of those `ReportFetch` calls the fetch trigger (`trigger.ts`), which runs cycles of the bundle fetcher (`runFetchCycle` of `@findmyperson/shared`, described in that package's README) through `DataStore.runFetchCycle`.

- **The trigger supplies the fetcher's inputs**: the transport (`createHttpTransport`, over `fetch`), the Ed25519 verify (`ed25519.ts`, tweetnacl; its header says why and what was checked on Hermes), the random source (`random.ts`) and the metered answer (the capture module's `getNetworkConditions`). The watch list is left to the store: `DataStore.runFetchCycle` reads the `subscription` table when none is given. That table is empty until the subscription manager (B3.7) exists, so a cycle today follows no shard.
- **The CDN origin and the trusted keys are not set.** They are `REPORT_CDN_ORIGIN` and `REPORT_TRUSTED_KEYS` in `reportCdn.ts`, and wait for the storage and CDN decision (fmp-storage-cdn-provider). Until both have a value every wake ends as `unconfigured`: nothing is asked of the store or the network. `reportCdn.test.ts` says so, checks that whatever is filled in parses, and refuses the published test key.
- **How often.** A wake within `FETCH_TRIGGER_MIN_INTERVAL_SEC` of a completed cycle does nothing. A failed cycle waits for the fetcher's backoff; one put off for a metered connection is asked again after `FETCH_TRIGGER_RECHECK_SEC`. These waits are in memory, so a new process asks at once; the fetcher's own gates are in the store.
- **`deferred`**: while a completed cycle leaves changed shards waiting, the next runs at once, up to `FETCH_TRIGGER_MAX_CYCLES` per wake. **`rematch`**: `onRematch` is told how many reports owe a retrospective pass. Its default is `matchRunnerNotBuilt`, a TODO for the match runner (M5.2); the debt itself is in the store (`listReportsAwaitingRetrospective`).
- **Not covered:** a wake with no JavaScript in it (the app's process is gone) does not fetch; there is no headless task.

`DataStore.runFetchCycle` opens the store first if nothing has yet, and its statements take turns with maintenance and delete-all; the network requests in between hold nothing. `AppNavigator` takes a `fetchTrigger` prop and defaults to the real one. Tests run the real navigator against a recording fetch cycle, and the trigger against a real SQLCipher file, a stand-in CDN and the test signing key, under Node. Nothing ran on a device, and whether the platform HTTP cache lets every padded request reach the CDN is unverified (see `httpTransport.ts`).

## Permission flow (`app/src/permissions/`)

`PermissionFlow` renders `PermissionFlowScreen`, one screen whose stage (`stages.ts`: `disclosure`, `purpose`, `upgrade`, `limited`, `complete`, `denied`, `restricted`) comes only from `getStatus().permission`; device remedies (battery, autostart, hibernation, Background App Refresh, Low Power Mode, precise location) show only while their health flag is raised. All calls go through the capture module (`requestPermission`, `openSystemSettings`, `getStatus`), supplied by `CaptureProvider`; `AppNavigator` takes a `capture` prop and defaults to the native module. Tests drive it with the in-repo fake, which implements the same interface; nothing ran on a device. C2.7/C2.8 should navigate to `PermissionFlow` rather than re-ask.

## Report submission (`app/src/report/`, route `ReportForm`)

`ReportForm` renders `ReportSubmitScreen`: name, up to two optional photos (each shrunk to a 256 px thumbnail on the phone by `makeThumbnail`; a third is refused with a message, `addPhoto` in `form.ts`), a required E.164 phone, last-seen location, date and time, details, and the mockup's privacy banner. Everything validates in `form.ts` before anything is queued. "Broadcast report" writes a durable `own_report` row (`DataStore.enqueueReport`), then `runReportQueue` POSTs `/v1/reports` (`api.ts`, endpoint and schemas from `@findmyperson/shared`) with the device header and the row's idempotency key. The server holds it as `pending`: the screen says it is being reviewed, never that it is live. Offline or a 5xx keeps the row queued with backoff; the screen retries while open and `StoreMaintenance` retries at app start and foreground. On success it `replace`s to `LiveReport { reportId }`, whose body is a plain "Submitted, under review" placeholder until the active-report screen (R4.3) lands. No OTP or phone verification, by decision.

Unverified / not supplied: `API_BASE_URL` (`api.ts`) is `null` until a backend is deployed, so submits stay queued. No image picker, resizer or map library is in the app: `ReportServicesProvider` takes `photo` and `location` ports; without them "Add photo" is hidden and the location is typed as latitude/longitude. The radius (500 m) and the +-30 min window around the last-seen time are provisional defaults. `globalThis.crypto.getRandomValues` under Hermes is assumed. Nothing ran on a device.
