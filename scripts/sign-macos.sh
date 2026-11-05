#!/bin/sh
# Signs and notarizes the macOS builds in dist/, so Gatekeeper opens them.
#   SIGN_IDENTITY   "Developer ID Application: Draugr LLC (TEAMID)" (security find-identity -v -p codesigning)
#   NOTARY_PROFILE  a profile saved with `xcrun notarytool store-credentials` (default: swarmfu)
# A Mac with only an "Apple Development" certificate can't do this: that one
# signs builds for development, not downloads.
set -eu
: "${SIGN_IDENTITY:?set SIGN_IDENTITY to your Developer ID Application identity}"
profile="${NOTARY_PROFILE:-swarmfu}"
for bin in dist/swarmfu*-darwin-*; do
  case "$bin" in *.map|*.zip) continue ;; esac
  codesign --force --timestamp --options runtime --entitlements entitlements.plist --sign "$SIGN_IDENTITY" "$bin"
  codesign --verify --strict --verbose=2 "$bin"
  # The notary takes a zip; a bare binary can't be stapled, so Gatekeeper checks online on first run.
  zip -j "$bin.zip" "$bin"
  xcrun notarytool submit "$bin.zip" --keychain-profile "$profile" --wait
done
