#!/usr/bin/env bash
# Build the Android app from app/android. Same script locally and in CI.
#   build/build-android.sh debug     debug APK, needs no secrets (what a fork or the captain runs)
#   build/build-android.sh release   signed release APK + AAB; needs the FMP_ANDROID_* variables
# Set FMP_ALLOW_UNSIGNED=1 to let `release` run without them (output is unsigned, not installable).
set -euo pipefail

variant="${1:-debug}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project="$repo_root/app/android"

if [ ! -x "$project/gradlew" ]; then
  echo "No Android project at app/android yet (no gradlew). The native projects are added by a later task." >&2
  exit 3
fi

# shellcheck source=build/env.sh
source "$repo_root/build/env.sh"
cd "$project"

# Fails the build if the manifest Gradle merged lets Android back up or transfer app data
# (location history must never leave the phone; packages/encrypted-store/README.md).
check_backup_excluded() {
  node "$repo_root/packages/encrypted-store/scripts/check-merged-manifest.ts" "$project/app/build/intermediates"
}

# Fails the build if the app holds a second SQLite beside the SQLCipher in libop-sqlite.so, or
# if the Kotlin store is not linked to that one (two copies in one process do not see each
# other's file locks; packages/encrypted-store/README.md).
check_one_sqlite() {
  node "$repo_root/packages/encrypted-store/scripts/check-native-libs.ts" "$@"
}

case "$variant" in
  debug)
    ./gradlew assembleDebug
    check_backup_excluded
    check_one_sqlite "$project/app/build/outputs/apk/debug"
    echo "APK: app/android/app/build/outputs/apk/debug/app-debug.apk"
    ;;
  release)
    if [ -z "${FMP_ANDROID_KEYSTORE_FILE:-}" ] && [ "${FMP_ALLOW_UNSIGNED:-}" != "1" ]; then
      echo "Release needs signing: set FMP_ANDROID_KEYSTORE_FILE, FMP_ANDROID_KEYSTORE_PASSWORD," >&2
      echo "FMP_ANDROID_KEY_ALIAS, FMP_ANDROID_KEY_PASSWORD (see docs/BUILDING.md), or run: build/build-android.sh debug" >&2
      exit 2
    fi
    ./gradlew --init-script "$repo_root/build/android-signing.init.gradle" assembleRelease bundleRelease
    check_backup_excluded
    check_one_sqlite "$project/app/build/outputs/apk/release" "$project/app/build/outputs/bundle/release"
    echo "APK: app/android/app/build/outputs/apk/release/"
    echo "AAB: app/android/app/build/outputs/bundle/release/app-release.aab"
    ;;
  *)
    echo "usage: build/build-android.sh debug|release" >&2
    exit 64
    ;;
esac
