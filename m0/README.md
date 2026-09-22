# M0 - background location capture on real phones

M0 proves whether background location capture works on real phones, using barebones native trial apps (Kotlin on Android, Swift on iOS, no React Native). The outcome is a measurement report, not a pass or fail: a weaker capture level can still ship with an honest promise. Live phones only (no simulators or emulators), and trial-app logs carry no coordinates.

## Layout

| Path | Contents |
|---|---|
| `m0/README.md`, `m0/env.sh`, `m0/.gitignore` | this file and the toolchain setup (fmp-m0-tooling) |
| `m0/docs/` | log format (analyser task) |
| `m0/analyser/` | log analyser |
| `m0/android/` | Android trial app |
| `m0/ios/` | iOS trial app |
| `m0/store-proof/` | on-device store proof |
| `m0/kit/` | tester kit |

## Using the toolchain

    source ~/.fmp-m0-env.sh     # machine-local, fixed paths
    # or: source m0/env.sh      # repo copy, detects the Homebrew prefix

This sets JAVA_HOME, ANDROID_HOME, ANDROID_SDK_ROOT and puts sdkmanager and adb on PATH. Your shell profile is not touched.

Gradle is not installed system-wide. Each Android project should use a Gradle wrapper (`gradle-wrapper.properties` pointing at Gradle 8.9 or newer). The verification build used Gradle 8.9, Android Gradle Plugin 8.7.3 and Kotlin 2.0.21. Gotcha: set Java and Kotlin to the same JVM target (17), otherwise Kotlin compile fails with "Inconsistent JVM-target compatibility":

    android { compileOptions { sourceCompatibility = JavaVersion.VERSION_17; targetCompatibility = JavaVersion.VERSION_17 } }
    kotlin { jvmToolchain(17) }

Also create `local.properties` with `sdk.dir=/opt/homebrew/share/android-commandlinetools` if ANDROID_HOME is not set (it is git-ignored).

## Installed versions (verified 2026-09-21)

- OpenJDK 17.0.20.1 (Homebrew `openjdk@17`)
- Android command-line tools (Homebrew cask `android-commandlinetools`), SDK root `/opt/homebrew/share/android-commandlinetools`
- platform-tools 37.0.1 (adb 1.0.41, 37.0.1-15733141; Homebrew cask `android-platform-tools` also installed)
- platforms;android-35 (rev 2), build-tools;35.0.0
- Xcode 16.2 (16C5032a), iOS device SDK 18.2 (`iphoneos18.2`); simulator SDK ships with Xcode but is not used
- No emulator package or system image installed

A throwaway Kotlin project built with `assembleDebug` successfully using this setup, then was deleted.
