#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "$0")/.." && pwd)"
trap 'adb pull /sdcard/Android/data/com.gitvault.app.debug/files "$project_root/android-device-screenshots" || true' EXIT
cd "$project_root/android"
./gradlew --no-daemon :app:connectedDebugAndroidTest
