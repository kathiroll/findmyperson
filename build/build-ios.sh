#!/usr/bin/env bash
# Build the iOS app from app/ios into an .xcarchive. Same script locally and in CI.
#   build/build-ios.sh unsigned   Release archive with code signing off; needs no Apple account or secrets
#   build/build-ios.sh signed     signed archive + .ipa; needs the FMP_IOS_* variables (see docs/BUILDING.md)
# Output lands in app/ios/build/. Override the scheme with FMP_IOS_SCHEME (default FindMyPerson).
set -euo pipefail

mode="${1:-unsigned}"
case "$mode" in unsigned|signed|device) ;; *) echo "usage: build/build-ios.sh unsigned|signed|device" >&2; exit 64 ;; esac
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
project="$repo_root/app/ios"
scheme="${FMP_IOS_SCHEME:-FindMyPerson}"

if [ ! -d "$project" ] || [ -z "$(ls -d "$project"/*.xcodeproj 2>/dev/null)" ]; then
  echo "Missing app/ios Xcode project; this is a build failure, not a skipped acceptance check." >&2
  exit 3
fi

if ! xcodebuild -version >/dev/null 2>&1; then
  echo "xcodebuild does not run on this machine. Use the swiftc type-check fallback in docs/BUILDING.md." >&2
  exit 4
fi

cd "$project"
if [ -f Podfile ]; then
  if [ -f Gemfile ]; then bundle install && bundle exec pod install; else pod install; fi
fi

if [ -d "$scheme.xcworkspace" ]; then target=(-workspace "$scheme.xcworkspace"); else target=(-project "$scheme.xcodeproj"); fi
archive="$project/build/$scheme.xcarchive"
mkdir -p "$project/build"
# The link map lets the artifact check prove which object supplies SQLite/SQLCipher symbols.
build_options=(-derivedDataPath "$project/build/DerivedData" LD_GENERATE_MAP_FILE=YES
  "LD_MAP_FILE_PATH=$project/build/$scheme-LinkMap-\$(CURRENT_ARCH).txt")

case "$mode" in
  unsigned)
    xcodebuild "${target[@]}" "${build_options[@]}" -scheme "$scheme" -configuration Release -destination 'generic/platform=iOS' \
      -archivePath "$archive" CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO archive
    "$repo_root/build/check-ios-archive.sh" "$archive" "$project/build/$scheme-LinkMap-arm64.txt"
    echo "Archive (unsigned, not installable on a phone): app/ios/build/$scheme.xcarchive"
    ;;
  signed)
    : "${FMP_IOS_TEAM_ID:?set FMP_IOS_TEAM_ID}" "${FMP_IOS_BUNDLE_ID:?set FMP_IOS_BUNDLE_ID}" "${FMP_IOS_PROFILE_NAME:?set FMP_IOS_PROFILE_NAME}"
    export_plist="$project/build/ExportOptions.plist"
    mkdir -p "$project/build"
    sed -e "s/__TEAM_ID__/$FMP_IOS_TEAM_ID/g" -e "s/__BUNDLE_ID__/$FMP_IOS_BUNDLE_ID/g" \
        -e "s/__PROFILE_NAME__/$FMP_IOS_PROFILE_NAME/g" -e "s/__METHOD__/${FMP_IOS_EXPORT_METHOD:-app-store-connect}/g" \
        "$repo_root/build/ExportOptions.plist.template" > "$export_plist"
    xcodebuild "${target[@]}" "${build_options[@]}" -scheme "$scheme" -configuration Release -destination 'generic/platform=iOS' \
      -archivePath "$archive" CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM="$FMP_IOS_TEAM_ID" \
      PROVISIONING_PROFILE_SPECIFIER="$FMP_IOS_PROFILE_NAME" PRODUCT_BUNDLE_IDENTIFIER="$FMP_IOS_BUNDLE_ID" CODE_SIGN_IDENTITY="Apple Distribution" archive
    "$repo_root/build/check-ios-archive.sh" "$archive" "$project/build/$scheme-LinkMap-arm64.txt"
    xcodebuild -exportArchive -archivePath "$archive" -exportOptionsPlist "$export_plist" -exportPath "$project/build/export"
    echo "IPA: app/ios/build/export/"
    ;;
  device)
    : "${FMP_IOS_TEAM_ID:?set your local Personal Team id in FMP_IOS_TEAM_ID}"
    xcodebuild "${target[@]}" "${build_options[@]}" -scheme "$scheme" -configuration Release \
      -destination 'generic/platform=iOS' -allowProvisioningUpdates CODE_SIGN_STYLE=Automatic \
      DEVELOPMENT_TEAM="$FMP_IOS_TEAM_ID" PRODUCT_BUNDLE_IDENTIFIER="${FMP_IOS_BUNDLE_ID:-dev.findmyperson.app}" build
    echo "Signed device app: app/ios/build/DerivedData/Build/Products/Release-iphoneos/$scheme.app"
    ;;
esac
