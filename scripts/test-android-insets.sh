#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "$0")/.." && pwd)"
collect_screenshots() {
  mkdir -p "$project_root/android-device-screenshots"
  for name in portrait landscape keyboard; do
    adb pull "/data/local/tmp/gitvault-insets-$name.png" "$project_root/android-device-screenshots/" || true
  done
}
trap collect_screenshots EXIT
cd "$project_root/android"
./gradlew --no-daemon :app:connectedDebugAndroidTest
