#!/usr/bin/env bash
# CI only: put the distribution certificate and provisioning profile (from secrets, as base64 in
# environment variables) into a throwaway keychain on the runner. Never run this on your own Mac.
# Needs: FMP_IOS_CERT_P12_BASE64, FMP_IOS_CERT_PASSWORD, FMP_IOS_PROFILE_BASE64, RUNNER_TEMP.
set -euo pipefail

keychain="$RUNNER_TEMP/fmp-build.keychain-db"
keychain_password="$(uuidgen)"

security create-keychain -p "$keychain_password" "$keychain"
security set-keychain-settings -lut 3600 "$keychain"
security unlock-keychain -p "$keychain_password" "$keychain"

printf '%s' "$FMP_IOS_CERT_P12_BASE64" | base64 --decode > "$RUNNER_TEMP/cert.p12"
security import "$RUNNER_TEMP/cert.p12" -P "$FMP_IOS_CERT_PASSWORD" -A -t cert -f pkcs12 -k "$keychain"
security set-key-partition-list -S apple-tool:,apple: -k "$keychain_password" "$keychain" >/dev/null
security list-keychains -d user -s "$keychain" login.keychain-db

mkdir -p "$HOME/Library/MobileDevice/Provisioning Profiles"
printf '%s' "$FMP_IOS_PROFILE_BASE64" | base64 --decode > "$HOME/Library/MobileDevice/Provisioning Profiles/fmp.mobileprovision"
rm -f "$RUNNER_TEMP/cert.p12"
