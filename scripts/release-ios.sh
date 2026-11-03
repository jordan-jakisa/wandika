#!/bin/sh
# Builds the public iPhone app (no Gmail; Google only after Google's review) as an archive for
# App Store Connect. Upload it from Xcode: Window, Organizer, the archive, Distribute App,
# App Store Connect, Upload. Xcode signs in with its own account, so no API key is needed.
# Raise bundle > iOS > bundleVersion in src-tauri/tauri.conf.json before every upload.
set -e
cd "$(dirname "$0")/.."
. scripts/release-common.sh

export PATH="$HOME/.cargo/bin:$PATH"
# The export at the end needs Xcode's account; the archive is what counts here.
npm run tauri ios build -- --export-method app-store-connect || true
archive=src-tauri/gen/apple/build/wandika_iOS.xcarchive
[ -d "$archive" ] || { echo "No archive was built."; exit 1; }
check_public "$archive/Products/Applications/Wandika.app/Wandika"
/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" -c "Print :CFBundleVersion" "$archive/Products/Applications/Wandika.app/Info.plist"
open "$archive"
echo "Ready: $archive (opened in Xcode's Organizer)"
