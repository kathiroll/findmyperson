#!/bin/sh
# Actual production port adapter + CaptureEngine against real host SQLCipher; no simulator.
set -eu
here="$(cd "$(dirname "$0")/.." && pwd)"
store="$(cd "$here/../../encrypted-store/ios" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
out="$here/build/store-integration"
mkdir -p "$out/modules" "$out/h3"
sh "$store/build-host-check.sh"
cat > "$out/modules/module.modulemap" <<EOF
module FindMyPersonEncryptedStore {
  header "$store/FMPSqlcipher.h"
  export *
}
EOF
swiftc -swift-version 5 -enable-testing -emit-module -emit-library \
  -module-name FindMyPersonEncryptedStore -import-underlying-module -I"$out/modules" \
  -emit-module-path "$out/modules/FindMyPersonEncryptedStore.swiftmodule" \
  "$store"/*.swift "$store/build/sqlcipher.o" "$store/build/FMPSqlcipher.o" \
  -framework Security -framework Foundation -o "$out/modules/libFindMyPersonEncryptedStore.dylib"
for file in "$here"/Sources/CH3/h3lib/lib/*.c; do
  clang -c -O1 -w -I"$here/Sources/CH3/include" -I"$here/Sources/CH3/h3lib/include" \
    "$file" -o "$out/h3/$(basename "$file" .c).o"
done
# Reuse the existing engine's fake phone without importing its SPM module.
sed '/@testable import CaptureCore/d' "$here/Tests/CaptureCoreTests/Support/Fakes.swift" > "$out/Fakes.swift"
core_sources=$(find "$here/Sources/CaptureCore" -name '*.swift' ! -name 'SQLiteCaptureStore.swift')
# shellcheck disable=SC2086
swiftc -swift-version 5 -I"$out/modules" -L"$out/modules" -lFindMyPersonEncryptedStore \
  -Xlinker -rpath -Xlinker "$out/modules" -import-objc-header "$here/Sources/CH3/include/h3api.h" \
  $core_sources "$here/Sources/Platform/EncryptedCaptureStore.swift" "$out/Fakes.swift" \
  "$here/Tests/StoreIntegration/main.swift" "$out"/h3/*.o -o "$out/integration-check"
scratch=$(mktemp -d "${TMPDIR:-/tmp}/fmp-store-integration.XXXXXX")
trap 'rm -rf "$scratch"' EXIT
"$out/integration-check" "$scratch" "$repo/packages/shared/contracts/migration-v1.sql"
