#!/bin/sh
# Builds the public Mac download: Gmail left out (WANDIKA_PUBLIC=1), signed with the Developer ID
# certificate, and notarized with an App Store Connect API key, so no Apple Account password is
# used. Tauri notarizes and staples the app; this script then notarizes and staples the .dmg too,
# so both open without a warning, also offline.
#
# Once (docs/setup.md, "Releases"): a Developer ID Application certificate in the keychain, and an
# App Store Connect team API key saved as ~/.appstoreconnect/private_keys/AuthKey_<KEY ID>.p8 with
# WANDIKA_APPLE_API_KEY_ID and WANDIKA_APPLE_API_ISSUER in .env.
set -e
cd "$(dirname "$0")/.."

# Released binaries must be built from source that is public on GitHub: that's what keeps them
# outside the US export rules for encryption (15 CFR 734.3(b)(3) and 742.15(b)).
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Commit your changes first: a release is built only from code that's on GitHub."
  exit 1
fi
git fetch -q origin
if [ -n "$(git log --oneline origin/main..HEAD)" ]; then
  echo "Push first: a release is built only from code that's on GitHub."
  exit 1
fi

identity=$(security find-identity -v -p codesigning | sed -n 's/.*"\(Developer ID Application: .*\)"/\1/p' | head -1)
if [ -z "$identity" ]; then
  echo "No Developer ID Application certificate in the keychain (docs/setup.md, Releases)."
  exit 1
fi
key_id=$(sed -n 's/^WANDIKA_APPLE_API_KEY_ID=//p' .env | tr -d '[:space:]')
issuer=$(sed -n 's/^WANDIKA_APPLE_API_ISSUER=//p' .env | tr -d '[:space:]')
key="$HOME/.appstoreconnect/private_keys/AuthKey_$key_id.p8"
if [ -z "$key_id" ] || [ -z "$issuer" ] || [ ! -f "$key" ]; then
  echo "No App Store Connect API key set up for notarizing (docs/setup.md, Releases)."
  exit 1
fi

export PATH="$HOME/.cargo/bin:$PATH"
WANDIKA_PUBLIC=1 APPLE_SIGNING_IDENTITY="$identity" APPLE_API_KEY="$key_id" APPLE_API_ISSUER="$issuer" APPLE_API_KEY_PATH="$key" \
  npm run tauri build -- --bundles app,dmg

app=src-tauri/target/release/bundle/macos/Wandika.app
if otool -L "$app/Contents/MacOS/wandika" | tail -n +2 | grep -v -e "^[[:space:]]*/System/" -e "^[[:space:]]*/usr/lib/"; then
  echo "The build links the libraries above from outside macOS, so it wouldn't start elsewhere."
  exit 1
fi
xcrun stapler validate "$app"

dmg=$(ls -t src-tauri/target/release/bundle/dmg/*.dmg | head -1)
xcrun notarytool submit "$dmg" --key "$key" --key-id "$key_id" --issuer "$issuer" --wait
xcrun stapler staple "$dmg"
spctl --assess --type open --context context:primary-signature -v "$dmg"
shasum -a 256 "$dmg"
echo "Ready: $dmg"
