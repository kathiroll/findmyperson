#!/bin/sh
# Re-creates Sources/CH3 from the upstream H3 release, unmodified.
#
# The version is the H3 core that h3-js bundles (packages/shared uses h3-js; its H3_VERSION file
# names the core), so the Swift module and the TypeScript side compute cells with the same code.
# Change H3_VERSION and H3_SHA256 together, run this, then run `swift test`: the cell vectors in
# packages/shared/contracts/geo-vectors.json decide whether the new version is acceptable.
set -eu

H3_VERSION=4.5.0
H3_SHA256=0da8a392a6ff77e76b60e6a331a49497d0935b6b7b6899da7a3e2786139b0441

here="$(cd "$(dirname "$0")" && pwd)"
dest="$here/../Sources/CH3"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

curl -sSfL -o "$work/h3.tar.gz" "https://codeload.github.com/uber/h3/tar.gz/refs/tags/v$H3_VERSION"
echo "$H3_SHA256  $work/h3.tar.gz" | shasum -a 256 -c -
tar -xzf "$work/h3.tar.gz" -C "$work"
src="$work/h3-$H3_VERSION"

rm -rf "$dest/h3lib" "$dest/include"
mkdir -p "$dest/h3lib/lib" "$dest/h3lib/include" "$dest/include"
cp "$src"/src/h3lib/lib/*.c "$dest/h3lib/lib/"
cp "$src"/src/h3lib/include/*.h "$dest/h3lib/include/"
cp "$src/LICENSE" "$src/NOTICE" "$dest/"

# h3api.h is the one generated file: upstream's CMake fills the version into h3api.h.in.
major="${H3_VERSION%%.*}"
rest="${H3_VERSION#*.}"
sed -e "s/@H3_VERSION_MAJOR@/$major/" -e "s/@H3_VERSION_MINOR@/${rest%%.*}/" \
  -e "s/@H3_VERSION_PATCH@/${rest#*.}/" "$src/src/h3lib/include/h3api.h.in" > "$dest/include/h3api.h"

echo "vendored H3 $H3_VERSION into $dest"
