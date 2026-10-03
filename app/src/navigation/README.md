# App navigation shell

React Navigation 7 (native-stack + bottom-tabs). `routes.ts` is the single definition of route names, params and deep links.

| Route                                  | Where it lives               | Reached from                       |
| -------------------------------------- | ---------------------------- | ---------------------------------- |
| `Onboarding`                           | root stack (initial)         | app start                          |
| `Main` → `Home`, `History`, `Settings` | bottom tabs                  | after onboarding                   |
| `CaptureHealth`                        | root stack                   | Home, Settings                     |
| `ReportForm`                           | root stack                   | Home                               |
| `LiveReport`                           | root stack `{reportId}`      | Home, `findmyperson://report/<id>` |
| `Bystander`                            | root stack modal `{matchId}` | `findmyperson://match/<id>`        |

Match notifications should carry `matchNotificationUrl(id)`; reply notifications `reportNotificationUrl(id)`.

Unverified: registering the `findmyperson` URL scheme (Android intent filter, iOS `CFBundleURLTypes`) and handing a tapped notification's URL to `Linking` belong with the native projects and the notification task; nothing here ran on a device.
