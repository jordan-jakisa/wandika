#!/bin/sh
# Builds the public Android download: a signed release APK with Gmail left out (WANDIKA_PUBLIC=1).
# Once: create the release key and src-tauri/gen/android/keystore.properties (docs/setup.md).
set -e
cd "$(dirname "$0")/.."

. scripts/release-common.sh

if [ ! -f src-tauri/gen/android/keystore.properties ]; then
  echo "No src-tauri/gen/android/keystore.properties, so the APK can't be signed. See docs/setup.md."
  exit 1
fi
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
export NDK_HOME="${NDK_HOME:-$(ls -d "$ANDROID_HOME"/ndk/* | tail -1)}"
export JAVA_HOME="${JAVA_HOME:-/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home}"
T="$NDK_HOME/toolchains/llvm/prebuilt/darwin-x86_64/bin"
# OpenSSL's build looks for these per target: 64-bit and 32-bit ARM phones.
export RANLIB_aarch64_linux_android="$T/llvm-ranlib" AR_aarch64_linux_android="$T/llvm-ar"
export RANLIB_armv7_linux_androideabi="$T/llvm-ranlib" AR_armv7_linux_androideabi="$T/llvm-ar"
export PATH="$HOME/.cargo/bin:$PATH"

# Both ARM targets: many affordable phones still run 32-bit Android.
WANDIKA_PUBLIC=1 npm run tauri android build -- --apk --target aarch64 armv7
apk=$(ls -t src-tauri/gen/android/app/build/outputs/apk/universal/release/*.apk | head -1)
for lib in $(unzip -Z1 "$apk" 'lib/*/libwandika_lib.so'); do
  unzip -p "$apk" "$lib" > .release-lib.so
  check_public .release-lib.so
done
rm -f .release-lib.so
"$(ls -d "$ANDROID_HOME"/build-tools/* | tail -1)/apksigner" verify --print-certs "$apk" | grep -i "SHA-256"
shasum -a 256 "$apk"
(cd src-tauri/gen/android && ./gradlew --stop >/dev/null)
echo "Ready: $apk"
