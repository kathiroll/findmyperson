#!/bin/sh
# Runs the test suite against real SQLCipher, on a Mac.
#
# Plain `swift test` links the system SQLite, which is not SQLCipher, so it cannot show that the
# store opens an encrypted file, refuses a wrong key, or leaves no plaintext on disk. This
# builds SQLCipher from the C source op-sqlite vendors, which is the source the app compiles
# (same version, same on-disk format), and runs the tests against it, including
# SQLCipherStoreTests. Needs `pnpm install` and Xcode's command line tools.
#
# One difference from the app: the crypto provider. The app links OpenSSL through the
# op-sqlite pod; this host build uses CommonCrypto, as m0/store-proof/ios/build-host-check.sh
# did. The file format does not depend on the provider.
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"
source=""
for candidate in "$root/../../../app/node_modules/@op-engineering/op-sqlite/cpp/sqlcipher"; do
  if [ -f "$candidate/sqlite3.c" ]; then
    source="$(cd "$candidate" && pwd -P)"
  fi
done
if [ -z "$source" ]; then
  echo "op-sqlite's SQLCipher source was not found under app/node_modules; run pnpm install" >&2
  exit 3
fi

out="$root/.build/sqlcipher-host"
mkdir -p "$out"
# The C compile takes about a minute; skipped while the object is newer than the source.
if [ ! -f "$out/libfmpsqlcipher.a" ] || [ "$source/sqlite3.c" -nt "$out/libfmpsqlcipher.a" ]; then
  # op-sqlite's defines (op-sqlite.podspec), except the crypto provider.
  clang -c -O1 -w -mmacosx-version-min=12.0 -I"$source" \
    -DSQLITE_HAS_CODEC -DSQLITE_TEMP_STORE=3 -DHAVE_FULLFSYNC=1 -DSQLCIPHER_CRYPTO_CC \
    -DSQLITE_EXTRA_INIT=sqlcipher_extra_init -DSQLITE_EXTRA_SHUTDOWN=sqlcipher_extra_shutdown \
    "$source/sqlite3.c" -o "$out/sqlcipher.o"
  rm -f "$out/libfmpsqlcipher.a"
  ar rcs "$out/libfmpsqlcipher.a" "$out/sqlcipher.o"
fi

cd "$root"
# A build directory of its own: the plain build links a different library.
FMP_HOST_SQLCIPHER_DIR="$out" swift test --scratch-path "$root/.build/with-sqlcipher" "$@"
