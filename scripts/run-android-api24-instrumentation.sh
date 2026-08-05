#!/usr/bin/env bash

set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
android_sdk_root="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
emulator_port="${AI_CONTEXT_PACK_API24_PORT:-5554}"
avd_name="aiContextPackApi24"

if [[ -z "${android_sdk_root}" ]]; then
  echo "API24_ANDROID_SDK_MISSING: set ANDROID_SDK_ROOT or ANDROID_HOME" >&2
  exit 1
fi
if [[ ! "${emulator_port}" =~ ^[0-9]+$ ]] ||
  ((emulator_port < 5554 || emulator_port > 5682 || emulator_port % 2 != 0)); then
  echo "API24_EMULATOR_PORT_INVALID:${emulator_port}" >&2
  exit 1
fi

adb_path="${android_sdk_root}/platform-tools/adb"
avdmanager_path="${android_sdk_root}/cmdline-tools/latest/bin/avdmanager"
emulator_path="${android_sdk_root}/emulator/emulator"
system_image_path="${android_sdk_root}/system-images/android-24/default/x86_64"
emulator_serial="emulator-${emulator_port}"

for required_tool in "${adb_path}" "${avdmanager_path}" "${emulator_path}"; do
  if [[ ! -x "${required_tool}" ]]; then
    echo "API24_ANDROID_TOOL_MISSING:${required_tool}" >&2
    exit 1
  fi
done
if [[ ! -d "${system_image_path}" ]]; then
  echo "API24_SYSTEM_IMAGE_MISSING:system-images;android-24;default;x86_64" >&2
  exit 1
fi
if [[ -n "$("${adb_path}" devices | awk 'NR > 1 && NF > 0 { print $1 }')" ]]; then
  echo "API24_CONNECTED_DEVICE_CONFLICT: disconnect existing devices before running" >&2
  exit 1
fi

temporary_root="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
emulator_work_dir="$(mktemp -d "${temporary_root%/}/aicontextpack-api24.XXXXXX")"
export ANDROID_AVD_HOME="${emulator_work_dir}/avd"
export ANDROID_EMULATOR_HOME="${emulator_work_dir}/emulator-home"
mkdir -p "${ANDROID_AVD_HOME}" "${ANDROID_EMULATOR_HOME}"
emulator_log="${emulator_work_dir}/emulator.log"
emulator_pid=""

cleanup() {
  local task_status=$?
  trap - EXIT
  set +e
  if [[ -n "${emulator_pid}" ]] && kill -0 "${emulator_pid}" 2>/dev/null; then
    "${adb_path}" -s "${emulator_serial}" emu kill >/dev/null 2>&1
    for ((cleanup_attempt = 1; cleanup_attempt <= 20; cleanup_attempt++)); do
      kill -0 "${emulator_pid}" 2>/dev/null || break
      sleep 1
    done
    kill "${emulator_pid}" >/dev/null 2>&1
    wait "${emulator_pid}" >/dev/null 2>&1
  fi
  case "${emulator_work_dir}" in
    "${temporary_root%/}"/aicontextpack-api24.*)
      rm -rf -- "${emulator_work_dir}"
      ;;
    *)
      echo "API24_TEMP_PATH_INVALID:${emulator_work_dir}" >&2
      task_status=1
      ;;
  esac
  exit "${task_status}"
}
trap cleanup EXIT

printf 'no\n' | "${avdmanager_path}" create avd \
  --force \
  --name "${avd_name}" \
  --package "system-images;android-24;default;x86_64" \
  --device "pixel_2"

"${emulator_path}" \
  -avd "${avd_name}" \
  -port "${emulator_port}" \
  -no-window \
  -no-audio \
  -no-boot-anim \
  -no-snapshot \
  -wipe-data \
  -gpu swiftshader_indirect \
  -accel on \
  -cores 2 \
  -memory 2048 \
  -partition-size 4096 \
  -camera-back none \
  -camera-front none \
  >"${emulator_log}" 2>&1 &
emulator_pid=$!

boot_completed=""
for ((boot_attempt = 1; boot_attempt <= 180; boot_attempt++)); do
  if ! kill -0 "${emulator_pid}" 2>/dev/null; then
    break
  fi
  boot_completed="$(
    "${adb_path}" -s "${emulator_serial}" shell getprop sys.boot_completed 2>/dev/null |
      tr -d '\r' || true
  )"
  if [[ "${boot_completed}" == "1" ]]; then
    break
  fi
  sleep 2
done

if [[ "${boot_completed}" != "1" ]]; then
  echo "API24_EMULATOR_BOOT_TIMEOUT" >&2
  tail -n 200 "${emulator_log}" >&2
  exit 1
fi

"${adb_path}" -s "${emulator_serial}" shell settings put global window_animation_scale 0
"${adb_path}" -s "${emulator_serial}" shell settings put global transition_animation_scale 0
"${adb_path}" -s "${emulator_serial}" shell settings put global animator_duration_scale 0
"${adb_path}" -s "${emulator_serial}" shell input keyevent 82

device_api="$("${adb_path}" -s "${emulator_serial}" shell getprop ro.build.version.sdk | tr -d '\r')"
if [[ "${device_api}" != "24" ]]; then
  echo "API24_DEVICE_VERSION_INVALID:${device_api}" >&2
  exit 1
fi

test_apk="${repository_root}/modules/context-native/android/build/outputs/apk/androidTest/debug/context-native-debug-androidTest.apk"
test_package="com.aicontextpack.nativebridge.test"
test_runner="androidx.test.runner.AndroidJUnitRunner"
instrumentation_component="${test_package}/${test_runner}"
report_directory="${repository_root}/modules/context-native/android/build/reports/androidTests/api24"
mkdir -p "${report_directory}"

"${repository_root}/android/gradlew" \
  -p "${repository_root}/android" \
  --no-daemon \
  --stacktrace \
  -PreactNativeArchitectures=x86_64 \
  :context-native:assembleDebugAndroidTest

if [[ ! -f "${test_apk}" ]]; then
  echo "API24_TEST_APK_MISSING:${test_apk}" >&2
  exit 1
fi

# API 24's package manager can time out while ddmlib streams this large, self-contained
# library test APK through a split-install session. Push it first so installation reads a
# complete local file, then invoke the same configured AndroidX runner directly.
"${adb_path}" -s "${emulator_serial}" install --no-streaming -r -g "${test_apk}"
if ! "${adb_path}" -s "${emulator_serial}" shell pm path "${test_package}" |
  grep -q '^package:'; then
  echo "API24_TEST_PACKAGE_MISSING:${test_package}" >&2
  exit 1
fi

run_instrumentation() {
  local report_name="$1"
  shift
  local report_path="${report_directory}/${report_name}.txt"
  local runner_status

  set +e
  "${adb_path}" -s "${emulator_serial}" shell am instrument -w "$@" \
    "${instrumentation_component}" 2>&1 | tee "${report_path}"
  runner_status="${PIPESTATUS[0]}"
  set -e

  if [[ "${runner_status}" -ne 0 ]] ||
    grep -Eq 'FAILURES!!!|INSTRUMENTATION_(FAILED|ABORTED)|Process crashed' "${report_path}" ||
    ! grep -Eq '^[[:space:]]*OK \([1-9][0-9]* tests?\)[[:space:]]*$' "${report_path}"; then
    echo "API24_INSTRUMENTATION_FAILED:${report_name}" >&2
    return 1
  fi
}

run_instrumentation full-suite
run_instrumentation pdf-fallback \
  -e class \
  'com.aicontextpack.nativebridge.PdfProbeInstrumentedTest#usesRenderedFallbackForAllPagesBeforeApi35'

echo "API24_INSTRUMENTATION device=${emulator_serial} api=${device_api} snapshot=disabled fullSuite=pass pdfFallback=pass"
