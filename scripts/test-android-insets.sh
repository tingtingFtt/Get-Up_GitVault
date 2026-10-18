#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "$0")/.." && pwd)"
collect_screenshots() {
  mkdir -p "$project_root/android-device-screenshots"
  for name in portrait landscape keyboard; do
    adb pull "/data/local/tmp/gitvault-insets-$name.png" "$project_root/android-device-screenshots/" || true
  done
  local report="$project_root/android-device-screenshots/native-transfer-benchmark.txt"
  adb exec-out run-as com.gitvault.app.debug cat files/gitvault-transfer-benchmark.txt > "$report" || true
  if test -s "$report"; then cat "$report"; fi
}
trap collect_screenshots EXIT
cd "$project_root/android"
./gradlew --no-daemon :app:connectedDebugAndroidTest

bash "$project_root/scripts/test-android-upgrade.sh"
