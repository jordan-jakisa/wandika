#!/bin/sh
# Builds the public Mac download: Gmail left out (WANDIKA_PUBLIC=1), signed with the Developer ID
# certificate, notarized by Apple and stapled, so it opens on any Mac without a warning.
# Once: create a "Developer ID Application" certificate (Xcode, Settings, Accounts, Manage
# Certificates) and store notary credentials as the keychain profile "wandika-notary":
#   xcrun notarytool store-credentials wandika-notary --apple-id <you> --team-id <team>
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
  echo "No Developer ID Application certificate in the keychain. See the top of this script."
  exit 1
fi
xcrun notarytool history --keychain-profile wandika-notary >/dev/null 2>&1 || {
  echo "No notary credentials saved as \"wandika-notary\". See the top of this script."
  exit 1
}

export PATH="$HOME/.cargo/bin:$PATH"
WANDIKA_PUBLIC=1 APPLE_SIGNING_IDENTITY="$identity" npm run tauri build -- --bundles app,dmg

app=src-tauri/target/release/bundle/macos/Wandika.app
if otool -L "$app/Contents/MacOS/wandika" | tail -n +2 | grep -v -e "^[[:space:]]*/System/" -e "^[[:space:]]*/usr/lib/"; then
  echo "The build links the libraries above from outside macOS, so it wouldn't start elsewhere."
  exit 1
fi

dmg=$(ls -t src-tauri/target/release/bundle/dmg/*.dmg | head -1)
xcrun notarytool submit "$dmg" --keychain-profile wandika-notary --wait
xcrun stapler staple "$dmg"
spctl --assess --type open --context context:primary-signature -v "$dmg"
echo "Ready: $dmg"
