#!/bin/sh
# Builds the public iPhone app (no Gmail; Google only after Google's review) as an archive for
# App Store Connect. With --upload it then uploads the archive with Xcode's own account
# (Xcode, Settings, Apple Accounts), signing automatically; no API key or password is needed.
# Raise bundle > iOS > bundleVersion in src-tauri/tauri.conf.json before every upload.
set -e
cd "$(dirname "$0")/.."
. scripts/release-common.sh

export PATH="$HOME/.cargo/bin:$PATH"
# App Store Connect rejects a widget extension whose version differs from the app's.
version=$(node -p "require('./src-tauri/tauri.conf.json').version")
build=$(node -p "require('./src-tauri/tauri.conf.json').bundle.iOS.bundleVersion")
widgets=src-tauri/gen/apple/WandikaWidgets/Info.plist
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $version" -c "Set :CFBundleVersion $build" "$widgets"
sed -i '' -e "s/^        CFBundleShortVersionString: .*/        CFBundleShortVersionString: $version/" -e "s/^        CFBundleVersion: \"[0-9]*\"/        CFBundleVersion: \"$build\"/" src-tauri/gen/apple/project.yml
# Tauri's own export needs extra setup; the archive is what counts here.
npm run tauri ios build -- --export-method app-store-connect || true
archive=src-tauri/gen/apple/build/wandika_iOS.xcarchive
[ -d "$archive" ] || { echo "No archive was built."; exit 1; }
check_public "$archive/Products/Applications/Wandika.app/Wandika"
[ -d "$archive/Products/Applications/Wandika.app/PlugIns/WandikaWidgets.appex" ] || { echo "The archive has no Voice note widget."; exit 1; }
/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" -c "Print :CFBundleVersion" "$archive/Products/Applications/Wandika.app/Info.plist"
if [ "$1" = "--upload" ]; then
  out=$(mktemp -d)
  xcodebuild -exportArchive -archivePath "$archive" -exportOptionsPlist scripts/ios-export-options.plist -exportPath "$out" -allowProvisioningUpdates
  rm -rf "$out"
  echo "Uploaded: App Store Connect is processing it; TestFlight's Team group gets it when it's ready."
else
  echo "Ready: $archive. Upload with scripts/release-ios.sh --upload."
fi
