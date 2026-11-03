#!/bin/sh
# Builds Wandika for this Mac, signs it with your Apple Development certificate, and installs it in
# /Applications. A stable signature lets the keychain recognise every new build as the same app, so
# your sign-ins don't ask for the login password again after each build.
set -e
cd "$(dirname "$0")/.."

identity=$(security find-identity -v -p codesigning | sed -n 's/.*"\(Apple Development: .*\)"/\1/p' | head -1)
if [ -z "$identity" ]; then
  echo "No Apple Development certificate found. Sign in to Xcode with your Apple ID (Settings, Accounts), then try again."
  exit 1
fi

export PATH="$HOME/.cargo/bin:$PATH"
APPLE_SIGNING_IDENTITY="$identity" npm run tauri build -- --bundles app

# Every library must be built in or come with macOS; anything from Homebrew stops a signed app at launch.
app=src-tauri/target/release/bundle/macos/Wandika.app
if otool -L "$app/Contents/MacOS/wandika" | tail -n +2 | grep -v -e "^[[:space:]]*/System/" -e "^[[:space:]]*/usr/lib/"; then
  echo "The build links the libraries above from outside macOS, so it wouldn't start. Not installed."
  exit 1
fi

if pgrep -f "/Applications/Wandika.app/Contents/MacOS" >/dev/null; then
  echo "Quit Wandika, then run this again to install."
  exit 1
fi
rm -rf /Applications/Wandika.app
ditto "$app" /Applications/Wandika.app
echo "Installed /Applications/Wandika.app"
