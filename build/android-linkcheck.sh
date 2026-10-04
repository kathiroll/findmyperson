#!/usr/bin/env bash
# Build the link check and read what it packaged. Same script locally and in CI.
#   build/android-linkcheck.sh
# The link check (packages/encrypted-store/android-linkcheck) is a React Native Android app with
# no screen: op-sqlite, the store and the capture module, linked and packaged as the app will
# package them. This builds its debug APK and then fails unless the APK holds exactly one SQLite,
# the SQLCipher inside libop-sqlite.so, with the Kotlin side's library linked to it, and unless
# the merged manifest forbids backup. Nothing is installed or run: no phone, no emulator.
# Needs `pnpm install`, JDK 17, and an Android SDK that has or can download NDK 27 and CMake.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
store="$repo_root/packages/encrypted-store"
project="$store/android-linkcheck/android"

# shellcheck source=build/env.sh
source "$repo_root/build/env.sh"
cd "$project"

./gradlew :app:assembleDebug --console=plain
node "$store/scripts/check-native-libs.ts" "$project/app/build/outputs/apk"
node "$store/scripts/check-merged-manifest.ts" "$project/app/build/intermediates"
echo "APK: packages/encrypted-store/android-linkcheck/android/app/build/outputs/apk/debug/app-debug.apk"
