#!/bin/sh
# Builds the public Android download: a signed release APK with Gmail left out (WANDIKA_PUBLIC=1).
# Once: create the release key and src-tauri/gen/android/keystore.properties (docs/setup.md).
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

if [ ! -f src-tauri/gen/android/keystore.properties ]; then
  echo "No src-tauri/gen/android/keystore.properties, so the APK can't be signed. See docs/setup.md."
  exit 1
fi
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export NDK_HOME="${NDK_HOME:-$(ls -d "$ANDROID_HOME"/ndk/* | tail -1)}"
export JAVA_HOME="${JAVA_HOME:-/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home}"
T="$NDK_HOME/toolchains/llvm/prebuilt/darwin-x86_64/bin"
export RANLIB_aarch64_linux_android="$T/llvm-ranlib" AR_aarch64_linux_android="$T/llvm-ar"
export PATH="$HOME/.cargo/bin:$PATH"

WANDIKA_PUBLIC=1 npm run tauri android build -- --apk --target aarch64
apk=$(ls -t src-tauri/gen/android/app/build/outputs/apk/universal/release/*.apk | head -1)
"$(ls -d "$ANDROID_HOME"/build-tools/* | tail -1)/apksigner" verify --print-certs "$apk" | head -3
(cd src-tauri/gen/android && ./gradlew --stop >/dev/null)
echo "Ready: $apk"
