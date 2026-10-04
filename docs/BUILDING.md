# Building installable apps

Plain-language guide to getting an installable Android or iOS build of the real app (`app/`). The same scripts in `build/` run on your machine and in CI, so a local build is a faithful rehearsal of CI.

> **Status:** `app/android` exists and builds: the Android sections below are real. `app/ios` does not exist yet (it waits on an Apple developer team); until it does, the iOS script and CI job detect that, say so, and skip. The iOS sections apply once that folder exists (Xcode project plus Podfile in `app/ios`, scheme named `FindMyPerson` unless `FMP_IOS_SCHEME` says otherwise).

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

The command-line build below is unsigned, so it proves the code compiles but cannot be installed. To put it on your phone, open `app/ios/FindMyPerson.xcworkspace` in Xcode, tick **Automatically manage signing** with your Personal Team, pick the plugged-in iPhone and press Run, exactly as in `m0/ios/README.md`.

```sh
build/build-ios.sh unsigned
```

Output: `app/ios/build/FindMyPerson.xcarchive`. The script also runs `pod install` first (CocoaPods; `bundle exec` if there is a `Gemfile`).

### If `xcodebuild` does not work on your Mac

On the machine M0 was built on, `xcodebuild` could not start (Xcode's CoreSimulator plug-in failed to load). `sudo xcodebuild -runFirstLaunch` partly fixed it. `build/build-ios.sh` checks `xcodebuild -version` first and exits with code 4 and a pointer here if it fails. The fallback is to type-check the Swift sources against the real iPhone SDK, without Xcode's build system (same method as `m0/ios/README.md`):

```sh
xcrun --sdk iphoneos swiftc -sdk "$(xcrun --sdk iphoneos --show-sdk-path)" -target arm64-apple-ios15.0 -swift-version 5 -parse-as-library -typecheck -module-name FindMyPerson app/ios/FindMyPerson/*.swift
```

The iOS capture module has this fallback as a script of its own, which also compiles its C, Objective-C and Objective-C++ sources: `sh packages/native-location-capture/ios/scripts/check-ios.sh` (see that package's `ios/README.md`).

Adjust the source path and `-target` to the project. This catches Swift errors only; it does not cover CocoaPods, linking, resources or signing. Those are verified by the `ios` CI job on `main`, so treat a green iOS job as the real proof when your Mac cannot run `xcodebuild`.

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

**iOS:** no project exists in `app/ios`, so `build/build-ios.sh` and the `ios` job have never run against the real app. The script was syntax-checked only. The task that adds `app/ios` should run it and fix whatever differs (scheme name, Podfile location).
