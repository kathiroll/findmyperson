#!/bin/sh
# Builds the macOS host check of the iOS store: SQLCipher compiled from op-sqlite's vendored C
# source, FMPSqlcipher.c, and the real ios/*.swift. Output: ios/build/host-check.
# Needs the Xcode command line tools and `pnpm install`. No simulator, no device.
#
#   ios/build-host-check.sh              build and link the host check
#   ios/build-host-check.sh typecheck    also type-check the same Swift against the iPhone SDK
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
package="$(dirname "$here")"
out="$here/build"
sqlcipher="$(cd "$package" && node -p "require('node:path').dirname(require.resolve('@op-engineering/op-sqlite/package.json'))")/cpp/sqlcipher"
mkdir -p "$out"

sources="$here/StoreContract.swift $here/StoreError.swift $here/StoreKeys.swift $here/KeyStorage.swift \
  $here/StoreKeyVault.swift $here/StoreLocation.swift $here/SqlcipherDatabase.swift $here/EncryptedStore.swift \
  $here/EncryptedStoreBridge.swift"

# Same defines as op-sqlite's podspec, except the crypto provider: the app links OpenSSL, this
# host build uses CommonCrypto. Same SQLCipher logic and on-disk format. The C compile takes
# about a minute and is skipped while the object is newer than the vendored source.
if [ ! -f "$out/sqlcipher.o" ] || [ "$sqlcipher/sqlite3.c" -nt "$out/sqlcipher.o" ]; then
  clang -c -O1 -w -I"$sqlcipher" \
    -DSQLITE_HAS_CODEC -DSQLITE_TEMP_STORE=3 -DHAVE_FULLFSYNC=1 -DSQLCIPHER_CRYPTO_CC \
    -DSQLITE_EXTRA_INIT=sqlcipher_extra_init -DSQLITE_EXTRA_SHUTDOWN=sqlcipher_extra_shutdown \
    "$sqlcipher/sqlite3.c" -o "$out/sqlcipher.o"
fi
clang -c -O1 -Wall -Werror -I"$sqlcipher" "$here/FMPSqlcipher.c" -o "$out/FMPSqlcipher.o"

# shellcheck disable=SC2086
swiftc -swift-version 5 -module-name HostCheck -import-objc-header "$here/FMPSqlcipher.h" \
  $sources "$here/HostCheck/main.swift" "$out/sqlcipher.o" "$out/FMPSqlcipher.o" \
  -framework Security -framework Foundation -o "$out/host-check"
echo "built $out/host-check"

if [ "${1:-}" = "typecheck" ]; then
  # The same Swift, as it will be compiled for a phone. Catches iOS-only code paths
  # (file protection) and API that exists on macOS but not on iOS.
  sdk="$(xcrun --sdk iphoneos --show-sdk-path)"
  # shellcheck disable=SC2086
  xcrun --sdk iphoneos swiftc -typecheck -sdk "$sdk" -target arm64-apple-ios15.1 -swift-version 5 \
    -module-name FindMyPersonEncryptedStore -import-objc-header "$here/FMPSqlcipher.h" $sources
  echo "type-checked against $sdk"
fi
