#!/bin/sh
# Compiles the module's own sources for a real iPhone (arm64, iPhoneOS SDK) without Xcode's
# build system, CocoaPods, a simulator or a phone. It is the fallback docs/BUILDING.md
# describes for a Mac where xcodebuild does not work, applied to this package:
#
#   1. every Swift file, Sources/CaptureCore and Sources/Platform together, as the one module
#      the podspec builds, against CoreLocation, UIKit and Security;
#   2. the vendored H3 and the SQLite declarations, as C for iOS;
#   3. FMPCaptureLaunchObserver.m against the Objective-C header Swift generates in step 1;
#   4. RCTNativeLocationCapture.mm against that header, the committed codegen header
#      (contracts/ios/NativeLocationCaptureSpec.h) and React Native's own headers from
#      node_modules. A spec method the shim does not implement, or a Swift selector it
#      misspells, is an error. Skipped with a notice if `pnpm install` has not been run.
#
# These are compile checks. Not covered: the podspec, linking (which SQLite the module binds
# to), and anything about behaviour on a device. Those are first exercised by the iOS job of
# .github/workflows/build.yml once app/ios exists.
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"
package="$(cd "$root/.." && pwd)"
out="${TMPDIR:-/tmp}/fmp-capture-check-ios"
target="arm64-apple-ios15.1"
sdk="$(xcrun --sdk iphoneos --show-sdk-path)"
rm -rf "$out"
mkdir -p "$out/module"

# What CocoaPods gives the pod's Swift: its own public C headers, as the underlying module.
cat > "$out/module/module.modulemap" <<EOF
module FindMyPersonEncryptedStore {
  header "$package/../encrypted-store/ios/FMPSqlcipher.h"
  export *
}
module FMPLocationCapture {
  header "$root/Sources/CH3/include/h3api.h"
  export *
}
EOF

echo "1/4 Swift (encrypted-store dependency + CaptureCore + Platform) for $target"
xcrun --sdk iphoneos swiftc -sdk "$sdk" -target "$target" -swift-version 5 -parse-as-library \
  -emit-module -module-name FindMyPersonEncryptedStore -import-underlying-module -I"$out/module" \
  -emit-module-path "$out/module/FindMyPersonEncryptedStore.swiftmodule" \
  "$package"/../encrypted-store/ios/*.swift
# The legacy test opener is excluded from the production pod.
core_sources=$(find "$root/Sources/CaptureCore" -name '*.swift' ! -name 'SQLiteCaptureStore.swift')
xcrun --sdk iphoneos swiftc -sdk "$sdk" -target "$target" -swift-version 5 -parse-as-library \
  -typecheck -module-name FMPLocationCapture -import-underlying-module -I"$out/module" \
  -emit-objc-header-path "$out/FMPLocationCapture-Swift.h" \
  $core_sources "$root"/Sources/Platform/*.swift

echo "2/4 C (H3) for $target"
for file in "$root"/Sources/CH3/h3lib/lib/*.c; do
  xcrun --sdk iphoneos clang -isysroot "$sdk" -target "$target" -fsyntax-only -w \
    -I"$root/Sources/CH3/include" -I"$root/Sources/CH3/h3lib/include" \
    -I"$root/Sources/FMPSQLite/include" "$file"
done

echo "3/4 Objective-C launch observer for $target"
xcrun --sdk iphoneos clang -isysroot "$sdk" -target "$target" -fsyntax-only -fobjc-arc -fmodules \
  -Werror -I"$out" "$root/Sources/Bridge/FMPCaptureLaunchObserver.m"

# React Native, wherever pnpm put it for this package.
rn=""
for candidate in "$package/node_modules/react-native" "$package/../../app/node_modules/react-native"; do
  if [ -d "$candidate/React/Base" ]; then
    rn="$(cd "$candidate" && pwd -P)"
    break
  fi
done
if [ -z "$rn" ]; then
  echo "4/4 SKIPPED: react-native is not installed (run pnpm install); the Turbo Module shim was not compiled"
  echo "ok: the capture module's Swift, C and Objective-C compile for iOS (shim not checked)"
  exit 0
fi

echo "4/4 Objective-C++ Turbo Module shim for $target"
# The <React/...> style imports are header maps in a real build. Here: a tree of symlinks.
tree="$out/rn-headers"
mkdir -p "$tree/React" "$tree/RCTRequired" "$tree/RCTTypeSafety" "$tree/FBLazyVector" \
  "$tree/RCTDeprecation" "$tree/ReactCommon" "$tree/NativeLocationCaptureSpec"
find "$rn/React" -name '*.h' -exec ln -sf {} "$tree/React/" \;
ln -sf "$rn"/Libraries/Required/*.h "$tree/RCTRequired/"
ln -sf "$rn"/Libraries/TypeSafety/*.h "$tree/RCTTypeSafety/"
ln -sf "$rn"/Libraries/FBLazyVector/FBLazyVector/*.h "$tree/FBLazyVector/"
find "$rn/ReactApple" -name 'RCTDeprecation.h' -exec ln -sf {} "$tree/RCTDeprecation/" \;
ln -sf "$rn"/ReactCommon/callinvoker/ReactCommon/*.h "$tree/ReactCommon/"
ln -sf "$rn"/ReactCommon/react/nativemodule/core/ReactCommon/*.h "$tree/ReactCommon/"
ln -sf "$rn"/ReactCommon/react/nativemodule/core/platform/ios/ReactCommon/*.h "$tree/ReactCommon/"
ln -sf "$package/contracts/ios/NativeLocationCaptureSpec.h" "$tree/NativeLocationCaptureSpec/"

xcrun --sdk iphoneos clang++ -isysroot "$sdk" -target "$target" -fsyntax-only -fobjc-arc \
  -std=c++20 -x objective-c++ -Werror=incomplete-implementation -Werror=protocol \
  -Werror=objc-method-access -Werror=incompatible-pointer-types \
  -I"$tree" -I"$rn/ReactCommon" -I"$rn/ReactCommon/jsi" -I"$out" \
  "$root/Sources/Bridge/RCTNativeLocationCapture.mm"

echo "ok: the capture module's Swift, C, Objective-C and Objective-C++ compile for iOS"
