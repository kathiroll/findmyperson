# App navigation shell

React Navigation 7 (native-stack + bottom-tabs). `routes.ts` is the single definition of route names, params and deep links.

| Route                                  | Where it lives               | Reached from                                                                     |
| -------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------- |
| `Onboarding`                           | root stack (initial)         | app start                                                                        |
| `Main` → `Home`, `History`, `Settings` | bottom tabs                  | after onboarding                                                                 |
| `CaptureHealth`                        | root stack                   | Home, Settings (`SettingsScreen.onOpenCaptureHealth` is the diagnostics seam)    |
| `PermissionFlow`                       | root stack                   | Onboarding, Settings, CaptureHealth (placeholders), `findmyperson://permissions` |
| `ReportForm`                           | root stack                   | Home                                                                             |
| `LiveReport`                           | root stack `{reportId}`      | Home, `findmyperson://report/<id>`                                               |
| `Bystander`                            | root stack modal `{matchId}` | `findmyperson://match/<id>`                                                      |

Match notifications should carry `matchNotificationUrl(id)`; reply notifications `reportNotificationUrl(id)`.

Unverified: registering the `findmyperson` URL scheme (Android intent filter, iOS `CFBundleURLTypes`) and handing a tapped notification's URL to `Linking` belong with the native projects and the notification task; nothing here ran on a device.

## Store maintenance (`app/src/store/`)

`AppNavigator` renders `StoreMaintenance` once, inside the capture and data-store providers. It calls `DataStore.runMaintenance()` when the app starts, on every return to the foreground (`AppState` `active`) and on every `onSampleWritten` from the capture module. The first call opens the store (`createDataStore` keeps the handle, and a delete-all replaces it); each call runs `store.runMaintenance(now)`: stay derivation, the retention purge and, when due and allowed, the weekly VACUUM. It never rejects, and a store that cannot be opened is tried again at the next trigger. `AppNavigator` takes a `dataStore` prop and defaults to the real one. The vacuum is off on Android: `ANDROID_VACUUM_ENABLED` in `retention.ts`. Tests run it against a recording store and against a real SQLCipher file under Node; nothing ran on a device.

## Bundle fetch (`app/src/fetch/`, `DataStore.runFetchCycle`)

`DataStore.runFetchCycle(input)` runs one cycle of the bundle fetcher (`runFetchCycle` of `@findmyperson/shared`, described in that package's README) against the store, opening it first if nothing has yet: it needs no provider and no screen, so a background wake can call `createDataStore(...).runFetchCycle(...)` directly. Its statements take turns with maintenance and delete-all, and the network requests in between hold nothing. `createHttpTransport({ origin })` is the transport over `fetch`. **Nothing calls it yet**: no task has supplied the watch list (B3.7), the CDN origin, the pinned keys, an Ed25519 verify for Hermes, or a native answer to "is this connection metered", and no background trigger is wired. Tests run it against a real SQLCipher file and an in-memory CDN under Node; nothing ran on a device, and whether the platform HTTP cache lets every padded request reach the CDN is unverified (see `httpTransport.ts`).

## Permission flow (`app/src/permissions/`)

`PermissionFlow` renders `PermissionFlowScreen`, one screen whose stage (`stages.ts`: `disclosure`, `purpose`, `upgrade`, `limited`, `complete`, `denied`, `restricted`) comes only from `getStatus().permission`; device remedies (battery, autostart, hibernation, Background App Refresh, Low Power Mode, precise location) show only while their health flag is raised. All calls go through the capture module (`requestPermission`, `openSystemSettings`, `getStatus`), supplied by `CaptureProvider`; `AppNavigator` takes a `capture` prop and defaults to the native module. Tests drive it with the in-repo fake, which implements the same interface; nothing ran on a device. C2.7/C2.8 should navigate to `PermissionFlow` rather than re-ask.
