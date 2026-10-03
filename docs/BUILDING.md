# Building installable apps

Plain-language guide to getting an installable Android or iOS build of the real app (`app/`). The same scripts in `build/` run on your machine and in CI, so a local build is a faithful rehearsal of CI.

> **Status:** `app/` does not contain `android/` or `ios/` projects yet; a later task adds them. Until then the scripts and CI jobs detect that, say so, and skip. Everything below applies once those folders exist (Gradle wrapper in `app/android`, Xcode project plus Podfile in `app/ios`, scheme named `FindMyPerson` unless `FMP_IOS_SCHEME` says otherwise).

## What CI builds, and when

| Job     | Runs on                                  | Produces                                                      | Why                                                |
| ------- | ---------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------- |
| Android | every pull request, `main`, `v*` tags    | signed release APK + AAB (debug APK if no secrets)            | Linux runners are cheap                            |
| iOS     | only pushes to `main`, `v*` tags, manual | signed `.ipa` + `.xcarchive` (unsigned archive if no secrets) | macOS runners cost roughly 10x Linux; never on PRs |

Definition: `.github/workflows/build.yml`. Built files are attached to the run as artifacts. The existing `ci.yml` (typecheck, lint, tests) is unchanged.

Two more checks in the same workflow need no app project and run today. `store-android` (every pull request) runs the Kotlin unit tests of `packages/encrypted-store`. The `ios` job first runs that package's Swift host check on the Mac, on `main` only.

`build/build-android.sh` ends by checking the manifest Gradle merged: if it would let Android back up or transfer the app's data, the build fails. See "Backup exclusion" in `packages/encrypted-store/README.md`.

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

`source build/env.sh` points the shell at the JDK and Android SDK (like `m0/env.sh`; your shell profile is untouched). The APK is `app/android/app/build/outputs/apk/debug/app-debug.apk`. Enable USB debugging on the phone as in `m0/android/README.md`, then `adb install -r` that file.

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

## Not verified yet

No native project exists in `app/`, so none of these scripts or workflow jobs has run against the real app. The shell scripts were syntax-checked only, and the workflow is validated by GitHub when it first runs. The first task that adds `app/android` and `app/ios` should run both build scripts and fix whatever differs (scheme name, Podfile location, Gradle module name `app`).
