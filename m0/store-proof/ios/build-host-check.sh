#!/bin/sh
# Builds the macOS host check: SQLCipher compiled from op-sqlite's vendored C source plus the
# app's real Store/*.swift. Output: ios/build/host-check. Needs Xcode command line tools and
# `npm install` (for node_modules). No simulator, no device.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
pkg="$here/../node_modules/@op-engineering/op-sqlite/cpp/sqlcipher"
out="$here/build"
mkdir -p "$out"

# Same defines as op-sqlite's podspec, except the crypto provider: iOS links OpenSSL-Universal,
# this host build uses CommonCrypto. Same SQLCipher 4.19.0 logic and on-disk format.
# (the ~1 minute C compile is skipped while the object is newer than the vendored source)
if [ ! -f "$out/sqlcipher.o" ] || [ "$pkg/sqlite3.c" -nt "$out/sqlcipher.o" ]; then
  clang -c -O1 -w -I"$pkg" \
    -DSQLITE_HAS_CODEC -DSQLITE_TEMP_STORE=3 -DHAVE_FULLFSYNC=1 -DSQLCIPHER_CRYPTO_CC \
    -DSQLITE_EXTRA_INIT=sqlcipher_extra_init -DSQLITE_EXTRA_SHUTDOWN=sqlcipher_extra_shutdown \
    "$pkg/sqlite3.c" -o "$out/sqlcipher.o"
fi

swiftc -swift-version 5 -module-name HostCheck \
  -import-objc-header "$here/StoreProof/StoreProof-Bridging-Header.h" -Xcc -I"$pkg" \
  "$here/StoreProof/Store/CipherParams.swift" \
  "$here/StoreProof/Store/StoreKeys.swift" \
  "$here/StoreProof/Store/ParamCheck.swift" \
  "$here/StoreProof/Store/NativeStoreWriter.swift" \
  "$here/HostCheck/main.swift" \
  "$out/sqlcipher.o" -framework Security -framework Foundation \
  -o "$out/host-check"
echo "built $out/host-check"
