#!/usr/bin/env bash
set -euo pipefail
base_apk="$RUNNER_TEMP/gitvault-upgrade-base.apk"
cp app/build/outputs/apk/debug/app-debug.apk "$base_apk"
trap 'cp "$base_apk" app/build/outputs/apk/debug/app-debug.apk' EXIT
adb install -r "$base_apk"
adb shell "run-as com.gitvault.app.debug sh -c 'mkdir -p files && echo preserved > files/update-probe'"
GITVAULT_VERSION_CODE="$((GITVAULT_VERSION_CODE + 1))" GITVAULT_VERSION_NAME="$GITVAULT_VERSION_NAME-upgrade-check" ./gradlew --no-daemon :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
result="$(adb shell run-as com.gitvault.app.debug cat files/update-probe | tr -d '\r')"
test "$result" = preserved
echo 'APK replacement installed successfully and retained app-private data.'
