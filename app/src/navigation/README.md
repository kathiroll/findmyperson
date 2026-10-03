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

## Permission flow (`app/src/permissions/`)

`PermissionFlow` renders `PermissionFlowScreen`, one screen whose stage (`stages.ts`: `disclosure`, `purpose`, `upgrade`, `limited`, `complete`, `denied`, `restricted`) comes only from `getStatus().permission`; device remedies (battery, autostart, hibernation, Background App Refresh, Low Power Mode, precise location) show only while their health flag is raised. All calls go through the capture module (`requestPermission`, `openSystemSettings`, `getStatus`), supplied by `CaptureProvider`; `AppNavigator` takes a `capture` prop and defaults to the native module. Tests drive it with the in-repo fake, which implements the same interface; nothing ran on a device. C2.7/C2.8 should navigate to `PermissionFlow` rather than re-ask.
