# Building installable apps

Plain-language guide to getting an installable Android or iOS build of the real app (`app/`). The same scripts in `build/` run on your machine and in CI, so a local build is a faithful rehearsal of CI.

> **Status:** both `app/android` and `app/ios` are real native projects. The iOS project uses the React Native 0.87.1 template, New Architecture and Hermes; account/team selection is local. An unsigned archive proves compilation and resources, while install/permissions/background behaviour require a physical iPhone.

## What CI builds, and when

| Job     | Runs on                                  | Produces                                                      | Why                                                |
| ------- | ---------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------- |
| Android | every pull request, `main`, `v*` tags    | debug APK, always; signed release APK + AAB with the secrets  | Linux runners are cheap                            |
| iOS     | only pushes to `main`, `v*` tags, manual | signed `.ipa` + `.xcarchive` (unsigned archive if no secrets) | macOS runners cost roughly 10x Linux; never on PRs |

Definition: `.github/workflows/build.yml`. Built files are attached to the run as artifacts. The existing `ci.yml` (typecheck, lint, tests) is unchanged.

The Android job's artifact is `findmyperson-android-debug-<commit>`, holding `app-debug.apk`: the build to put on a phone (open the run on GitHub, **Artifacts**, download, unzip, `adb install -r app-debug.apk`). It needs no secrets, so it is there on every run, forks included. When the signing secrets are set the job also uploads `findmyperson-android-release-<commit>` (the signed APK and bundle).

Three more checks in the same workflow need no app project and run today. `store-android` (every pull request) runs the Kotlin unit tests of `packages/encrypted-store`, including its store and JNI code on real SQLCipher built for the runner. `android-linkcheck` (every pull request) runs `build/android-linkcheck.sh`: it builds a small APK of the native modules that touch the store and reads it, as described below. The `ios-capture-module` job also runs that package's Swift host check on the Mac, on `main` only.

`build/build-android.sh` ends with two checks on what Gradle produced, and either fails the build. The merged manifest must not let Android back up or transfer the app's data ("Backup exclusion" in `packages/encrypted-store/README.md`). The APK and bundle must hold exactly one SQLite, the SQLCipher inside op-sqlite's library, with the Kotlin store linked to it ("One SQLite library in the Android process" there). `build/android-linkcheck.sh` makes the same two checks on the link check's APK, which was the only APK there was before `app/android` existed; `packages/encrypted-store/android-linkcheck/README.md` describes it.

## Build on your own machine (the captain's path)

One-time toolchain, same as M0: JDK 17 and the Android command-line tools from Homebrew (`brew install openjdk@17`, `brew install --cask android-commandlinetools`, then `sdkmanager` for the platform and build-tools the project asks for), and Xcode 16 or newer for iOS. Install JS dependencies once from the repo root:

```sh
corepack enable
pnpm install
```

### Android (installable on a phone, no accounts, no secrets)

```sh
source build/env.sh
build/build-android.sh debug
```

`source build/env.sh` points the shell at the JDK and Android SDK (like `m0/env.sh`; your shell profile is untouched). The SDK needs platform 37, build tools 37.0.0, NDK 27.1.12297006 and CMake 3.22.1; with its licences accepted (`sdkmanager --licenses`) the build downloads whichever is missing. The first build takes several minutes, most of it compiling native code. The APK is `app/android/app/build/outputs/apk/debug/app-debug.apk`. Enable USB debugging on the phone as in `m0/android/README.md`, then `adb install -r` that file.

The debug APK carries its JavaScript, so it runs on a phone with nothing else running. It is signed with the React Native template's debug key (`app/android/app/debug.keystore`, public by design), the same on every machine and in CI, so one debug build installs over another without uninstalling. It is a debug build: not optimised, and not for distribution.

### The Android project (`app/android`)

It is the React Native 0.87 app template (`@react-native-community/template`), application id `dev.findmyperson.app`, with these differences, each commented where it is made:

| Where                                 | Difference from the template                                                                                            | Why                                                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `settings.gradle`, `app/build.gradle` | React Native, its Gradle plugin, its codegen and the Hermes compiler are found with `node --print require.resolve(...)` | pnpm does not put them at `node_modules/<name>` under `app/`                                                 |
| `settings.gradle`                     | Autolinking runs `@react-native-community/cli config` with `node`, and watches the workspace lockfile                   | Same command as the template's, without `npx`                                                                |
| `app/build.gradle`                    | `debuggableVariants = []`                                                                                               | The debug APK bundles its JavaScript instead of expecting a Metro server                                     |
| `app/build.gradle`                    | The `release` build type has no signing config                                                                          | The template signs release with the public debug key; here only `build/android-signing.init.gradle` signs it |
| `gradle.properties`                   | `reactNativeArchitectures` is `armeabi-v7a,arm64-v8a`                                                                   | The x86 ABIs are for emulators, which this project does not use                                              |
| `AndroidManifest.xml`                 | States the two backup rule files beside `allowBackup="false"`                                                           | "Backup exclusion" in `packages/encrypted-store/README.md`                                                   |

To move to a newer React Native, diff the new template's `android/` against this directory and carry those differences over.

The JavaScript side of the build is in `app/`: `index.js` (registers the navigator under the name `MainActivity.kt` asks for), `app.json`, `metro.config.js` (the workspace root as a watch folder, and `react` and `react-native` pinned to one copy: pnpm gives the workspace packages a second `react-native` directory, and without the pin Metro bundles both), `.babelrc` (the React Native preset, plus the one transform zod's `export * as` needs) and `react-native.config.js`. To see what autolinking links, run `node node_modules/@react-native-community/cli/build/bin.js config` in `app/`.

### iOS (installable on your own iPhone with a free Apple ID)

Use Xcode 16.1 or newer (React Native's minimum), Node 24, and current CocoaPods. On this Mac the build uses Xcode 16.2/iPhoneOS 18.2 SDK, Homebrew Ruby 4.0.7 and CocoaPods 1.17.0. `brew install ruby cocoapods` installs the latter without replacing macOS's Ruby or editing your shell profile; macOS Ruby 2.6 cannot install current CocoaPods dependencies. `pod install` uses the committed `Podfile.lock` and React Native's release artifacts; the first run needs network access and downloads large native frameworks.

```sh
build/build-ios.sh unsigned
```

Output: `app/ios/build/FindMyPerson.xcarchive`, an arm64 Release device archive. The script runs CocoaPods first and fails if the project is missing. It then checks the archive's Hermes bytecode, fonts, permission/background declarations, compiled capture/store/random modules and linker-map ownership of SQLite/SQLCipher symbols. `FindMyPerson-LinkMap-arm64.txt` is beside the archive. The unsigned result cannot be installed.

To sign for your phone, open `app/ios/FindMyPerson.xcworkspace` in Xcode. Add your Apple ID in **Xcode → Settings → Accounts**, connect and trust the iPhone, enable Developer Mode on it, select the `FindMyPerson` target, choose **Automatically manage signing** and your Personal Team, then select the physical iPhone and Run. Keep team/account changes local; never commit `DEVELOPMENT_TEAM` or provisioning material. The default identifier is `dev.findmyperson.app`; if that identifier is unavailable to your team, use a unique local identifier. Personal Team provisioning normally expires after seven days; rebuild/reinstall from Xcode when it expires. Background location needs no paid push entitlement.

The command-line alternative keeps the team in environment variables:

```sh
FMP_IOS_TEAM_ID=YOUR_PERSONAL_TEAM_ID build/build-ios.sh device
# Optional FMP_IOS_BUNDLE_ID overrides the local identifier.
xcrun devicectl device install app --device YOUR_DEVICE_ID \
  app/ios/build/DerivedData/Build/Products/Release-iphoneos/FindMyPerson.app
xcrun devicectl device process launch --device YOUR_DEVICE_ID dev.findmyperson.app
```

Find the device id with `xcrun devicectl list devices`. The phone must be cabled, unlocked and kept unlocked, with Developer Mode on: install fails with "developer disk image could not be mounted ... device is locked" otherwise, and the first launch may need the developer profile trusted under Settings > General > VPN & Device Management. If CocoaPods stops on an encoding error, prefix the build with `LANG=en_US.UTF-8`. This requires an Apple account configured in Xcode and a valid local signing identity/profile. `device` uses automatic development signing and permits Xcode to update provisioning. Both Debug and Release load bundled JavaScript with Metro unavailable; the bundle phase forces Debug bundling too. `app/ios/.xcode.env.local` is ignored for a machine-specific `NODE_BINARY` if Xcode's launch environment cannot find Node. No simulator or emulator is used.

### The iOS project (`app/ios`)

Diff against `@react-native-community/template@0.87.1` when upgrading:

| Where                    | Difference                                                                              | Purpose                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `Podfile`                | CLI resolved with Node; targeted `op-sqlite` modular headers; Hermes explicit           | pnpm resolution and Swift static-pod integration without making all RN headers modular |
| `FindMyPerson.xcodeproj` | `dev.findmyperson.app`, device-only platform, three font resources, forced bundle phase | actual arm64 app, bundled fonts and offline Debug launch                               |
| `AppDelegate.swift`      | component `findmyperson`; bundled URL in both configurations; explicit capture resume   | matches `app.json` and restores native capture independently of JS                     |
| `Info.plist`             | location usage descriptions, `location` background mode, `UIAppFonts`                   | permissions, background capture and PostScript font names                              |
| launch storyboard        | app name and local-history copy                                                         | no template tooling copy in the product                                                |

The store package supplies the backup-excluded/file-protected directory and Keychain key; the app never names or opens the store. Capture's production pod depends on that package and excludes its historical test opener. SQLCipher comes only from op-sqlite, configured in `app/package.json`. `react-native-get-random-values` 2.0.0 supplies iOS `SecRandomCopyBytes`/Android `SecureRandom` before the navigator is imported; the app rejects absent or malformed entropy and the library's insecure debugger fallback.

### If `xcodebuild` does not work on your Mac

On the machine M0 was built on, `xcodebuild` could not start (Xcode's CoreSimulator plug-in failed to load). `sudo xcodebuild -runFirstLaunch` partly fixed it. `build/build-ios.sh` checks `xcodebuild -version` first and exits with code 4 and a pointer here if it fails. The supported fallback is the native module's own iPhone SDK compile check:

```sh
sh packages/native-location-capture/ios/scripts/check-ios.sh
```

It builds the store dependency's Swift module, type-checks the production capture adapters against the real arm64 iPhone SDK and compiles H3/Objective-C/Turbo Module sources. It does not archive the application, link CocoaPods, bundle resources or sign/install anything. A successful fallback cannot substitute for the iOS archive acceptance check.

## Forks: build unsigned debug artifacts with no secrets

A fork or a clean checkout needs none of the signing material below. Android: `build/build-android.sh debug`. iOS: `build/build-ios.sh unsigned`. In GitHub Actions, forks have no access to this repository's secrets, so the same workflow automatically falls back to the debug APK and the unsigned archive.

## Signing material (CI secrets; never committed)

Nothing secret is in the repo: keystores, certificates and profiles are git-ignored, and the scripts only read environment variables. Add these under **Settings > Secrets and variables > Actions**. If the main secret of a platform is missing, that platform falls back to the unsigned build.

**Android** (the release keystore; create one with `keytool -genkeypair -v -storetype PKCS12 -keystore release.keystore -alias fmp -keyalg RSA -keysize 2048 -validity 10000`)

| Secret                          | Content                             |
| ------------------------------- | ----------------------------------- |
| `FMP_ANDROID_KEYSTORE_BASE64`   | `base64 -i release.keystore` output |
| `FMP_ANDROID_KEYSTORE_PASSWORD` | keystore password                   |
| `FMP_ANDROID_KEY_ALIAS`         | key alias (`fmp` in the example)    |
| `FMP_ANDROID_KEY_PASSWORD`      | key password                        |

Signing is injected by `build/android-signing.init.gradle`, a Gradle init script, so the app's own `build.gradle` never mentions secrets. Back the keystore up somewhere safe: if Google Play App Signing is not used, losing it means no more updates to the same app.

**iOS** (needs a paid Apple Developer account for distribution; a free Apple ID can only sign from Xcode for your own phone)

| Secret                    | Content                                                 |
| ------------------------- | ------------------------------------------------------- |
| `FMP_IOS_CERT_P12_BASE64` | Apple Distribution certificate exported as .p12, base64 |
| `FMP_IOS_CERT_PASSWORD`   | password chosen when exporting the .p12                 |
| `FMP_IOS_PROFILE_BASE64`  | provisioning profile (.mobileprovision), base64         |
| `FMP_IOS_PROFILE_NAME`    | the profile's name in the Apple developer portal        |
| `FMP_IOS_TEAM_ID`         | 10-character Apple team ID                              |
| `FMP_IOS_BUNDLE_ID`       | app bundle identifier                                   |

`build/ios-ci-signing.sh` imports these into a throwaway keychain on the CI runner. It is for CI only. `FMP_IOS_EXPORT_METHOD` (default `app-store-connect`) can be set to `ad-hoc` or `development` for other distribution types.

## Verified, and not verified yet

**Android, verified by building and reading the result** (on a Mac and in the `android` CI job; no phone, no emulator):

- `build/build-android.sh debug` produces `app-debug.apk` with no secrets: package `dev.findmyperson.app`, label `findmyperson`, a launchable `MainActivity`, arm64-v8a and armeabi-v7a, signed with the template's debug key.
- Autolinking finds `@findmyperson/encrypted-store`, `@findmyperson/native-location-capture`, op-sqlite, safe-area-context, screens and svg; each one's package class is in the generated `PackageList`, and their native libraries are in the APK.
- Metro bundles the app from `app/index.js` and the Hermes compiler turns it into bytecode, which is in the APK (`assets/index.android.bundle`), beside the three fonts.
- The merged manifest forbids backup and device transfer, and the APK holds one SQLite, in `libop-sqlite.so`, with `libfmp-store-jni.so` linked to it (the two checks the script ends with).
- `FMP_ALLOW_UNSIGNED=1 build/build-android.sh release` builds an unsigned release APK and bundle that pass the same two checks.

**Android, needs a phone:** everything that happens after `adb install`. That the app installs and launches to the onboarding screen; that the debug build runs its bundled JavaScript when no Metro server is reachable; that the fonts render; the permission flow (while-in-use, then background location); capture in the foreground service and after a reboot; the store being created, keyed from the Keystore and written by both JavaScript and Kotlin; the five checks under "Before the Android vacuum is switched on" in `packages/encrypted-store/README.md`.

**Android, not done:** a release signed with a real keystore (no secrets are set, so the signed CI step has never run); R8 (`enableProguardInReleaseBuilds` is `false`, as in the template); the `findmyperson://` URL scheme (no intent filter); `POST_NOTIFICATIONS`, which belongs to the notification task; a launcher icon other than the template's.

**iOS, built and inspected on October 7, 2026:** `build/build-ios.sh unsigned` completed Xcode's **ARCHIVE SUCCEEDED** with Xcode 16.2/iPhoneOS 18.2. The final artifact check passes for `app/ios/build/FindMyPerson.xcarchive`: arm64 only, Hermes bytecode and embedded `hermesvm.framework`, all three exact font files, location declarations, encrypted-store/capture/random modules, and SQLite/SQLCipher symbol definitions in op-sqlite's object. There is no direct system-SQLite dependency and the production legacy opener is absent. The checker recognizes link-map dead-stripped symbols too (the optimizer inlines `sqlcipher_version`). Signing/install and hardware runtime acceptance have not run.

**iOS, source/host checks:** the Foundation capture suite (155 tests); encrypted-store/capture TypeScript and Mac-host suites (190 tests); arm64 iPhone SDK compile of the Swift adapters, H3 and Turbo Module shim; `test-store-integration.sh` exercises real host SQLCipher with the production capture port and engine, both initialization orders, same-process stop/delete/key rotation/reopen/resume, a separate reader, wrong-key refusal, native retention/visit trim/cursor rewind. These are not device results.

**iOS, requires a phone:** signed installation and launch without Metro; font rendering, denied/foreground/Always/settings permission paths, locked/background capture after first unlock and JS reading the same native row, visit reconciliation, reboot/before-first-unlock recovery, pause/resume and delete/resume. The full evidence checklist is in `m0/ios/README.md`. API/CDN origins and trust keys remain unset, so this build does not submit to a deployed service or fetch live reports. Push/TestFlight/App Store distribution and a custom app icon remain outside this first application project.
