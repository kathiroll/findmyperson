# The Android link check

A React Native Android app with no screen and no JavaScript. It exists to be built and read, never installed: it links the three native modules that touch the store file, the way the app will, so that there is a real APK to check on every pull request while `app/android` does not exist.

```sh
build/android-linkcheck.sh   # from the repo root, after `pnpm install`
```

That builds the debug APK for arm64-v8a and armeabi-v7a and then runs two checks on it, both of which fail the build:

| Check                                 | What it reads                               | Rule                                                                                                                                                                       |
| ------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `../scripts/check-native-libs.ts`     | every `.so` in the APK                      | exactly one SQLite, the SQLCipher in `libop-sqlite.so`; `libfmp-store-jni.so` holds none and is linked to it ("One SQLite library in the Android process", `../README.md`) |
| `../scripts/check-merged-manifest.ts` | the manifest Gradle merged from all modules | backup and device transfer are forbidden ("Backup exclusion", `../README.md`)                                                                                              |

It needs JDK 17 and an Android SDK that has, or may download, platform 37, build tools 37.0.0, NDK 27.1.12297006 and CMake 3.22.1 (`source build/env.sh` points at the SDK; see `docs/BUILDING.md`). The first build takes a few minutes, most of it op-sqlite compiling SQLCipher.

## What is in it

| Path                    | What                                                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `android/`              | The Gradle project: the React Native 0.87 app template with the app's code removed. Versions in `android/build.gradle` are the template's                                      |
| `autolinking.mjs`       | Prints the list of modules to link, in the format React Native's Gradle plugin reads. It replaces `@react-native-community/cli config`, which this repository does not install |
| `package.json`          | Read by op-sqlite's Android build, which looks for its settings (`"sqlcipher": true`) in the `package.json` beside the Android project. Not a workspace member                 |
| `android/gradlew`, etc. | Gradle 9.4.1's wrapper, the version React Native 0.87 uses                                                                                                                     |

The modules are op-sqlite, `@findmyperson/encrypted-store` and `@findmyperson/native-location-capture`: the three that open the store. The app's other native dependencies (screens, safe-area-context, svg) are not linked here. The same check runs on the real APK from `build/build-android.sh`, which is where they are covered.

React Native and its Gradle plugin are found in `node_modules` the way Node finds them from this package, because pnpm does not put them at the paths React Native's templates assume. The app's own Android project will need the same (`android/settings.gradle` and `android/app/build.gradle` here show how).

## What it does and does not prove

It proves the build: that op-sqlite exports the SQLite functions the Kotlin side needs, that the JNI library links against it and against nothing else, that no dependency brings a second SQLite into the APK, that both libraries autolink, generate their Turbo Native Module code and merge their manifests into an app.

It proves nothing about a phone. The APK has no activity and is never run, so whether the libraries load in a process with no React Native, and how the two sides behave when they write at the same time, is still to be seen on a device: `../README.md`, "Before the Android vacuum is switched on".

`app/android` now exists, and `build/build-android.sh` runs the same two checks on its APK. Delete this directory, `build/android-linkcheck.sh` and the `android-linkcheck` CI job (and the lines of `../src/policy.test.ts` that name them) once the `android` job has been green on `main`.
