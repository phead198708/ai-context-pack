# Local development setup

AI Context Pack uses committed native projects. Expo Go and destructive native regeneration are not supported.

## Required tools

- Node 22.13.x-compatible pinned Node 22 (`.nvmrc` is 22.13.1).
- Xcode 26.6 (the verified toolchain; ADR minimum is 26.4) with Swift tools 6.2+, an iOS 16.4+ simulator runtime, and CocoaPods. Xcode 26.3 cannot compile the locked Expo SDK 57 `expo-modules-jsi` package.
- JDK 17 or 22, Android SDK Platform 36, Build Tools 36.0.0, NDK 27.1.12297006, and an API 24+ emulator/device.
- Ruby and Bundler for the pinned CocoaPods toolchain.

Set `ANDROID_HOME` (and, if required by your shell, `ANDROID_SDK_ROOT`) to the installed Android SDK before invoking Gradle. Keep `android/local.properties` local because it contains a workstation-specific absolute path.

## Install and verify

```sh
npm ci
bundle install
bundle exec ruby -rlogger -S pod install --project-directory=ios
npm run typecheck
npm run lint
npm run format:check
npm test
npm run test:fixtures
npm run test:workflows
```

Build without committing signing data:

```sh
npm run ios -- --no-bundler --device generic --output ./build/ios
./android/gradlew -p android :app:testDebugUnitTest :context-native:testDebugUnitTest :app:assembleDebug

# Provision the minimum supported API 24 image, then run it without emulator snapshots.
"${ANDROID_SDK_ROOT}/cmdline-tools/latest/bin/sdkmanager" "emulator" "system-images;android-24;default;x86_64"
scripts/run-android-api24-instrumentation.sh

# Run the CI-equivalent API 34 and API 35 managed devices when host virtualization is available.
./android/gradlew -p android -PreactNativeArchitectures=x86_64 :context-native:ciApi34DebugAndroidTest :context-native:ciApi35DebugAndroidTest

# Or use attached API 24 and API 35+ emulators/devices to cover both PDF paths.
./android/gradlew -p android :context-native:connectedDebugAndroidTest
```

The API 24 runner rejects pre-existing attached devices so the minimum-version gate cannot silently execute against the wrong target. It creates its AVD under a temporary directory, disables snapshot creation, waits for `sys.boot_completed`, verifies API level 24, builds the x86_64 instrumentation APK, installs it without ddmlib streaming, and invokes the configured AndroidX runner. It runs both the complete suite and the pre-35 PDF fallback explicitly, writes their output under the uploaded Android report tree, and removes the emulator even when the task fails.

Run development builds with `npm run ios` or `npm run android`. These use Expo CLI and a custom development client, not Expo Go. The iOS script gives every Expo/CocoaPods child process the repository's absolute `BUNDLE_GEMFILE`, preloads Ruby's standard `logger` library, and puts the checked-in CocoaPods shim first on `PATH`. The shim loads the `pod` executable from the bundle, so Expo cannot silently fall back to a globally installed CocoaPods after changing its working directory to `ios/`; do not replace the script with a bare `expo run:ios` invocation while this toolchain remains locked.

Expo Doctor's app-config synchronization check is intentionally disabled in `package.json`: this repository commits and reviews its native projects, and every native field (including the URL scheme) must be mirrored explicitly instead of regenerated with Prebuild.

After installing the Android development build, verify its committed native URL registration with:

```sh
adb shell am start -W -a android.intent.action.VIEW -c android.intent.category.BROWSABLE -d 'aicontextpack://' -p com.aicontextpack
```

Package resolution must select `com.aicontextpack/.MainActivity`; after that handoff, a Debug build may report Expo's `DevLauncherActivity` as the displayed development-client activity. The `aicontextpack` filter intentionally has no host or path wildcard.

The iOS placeholder identifiers `com.example.aicontextpack` and `group.com.example.aicontextpack` intentionally do not contain a team ID. Replace them only through an approved release configuration; never commit certificates, profiles, keystores, or private team values.

Do not run `expo prebuild --clean`. The Swift/Kotlin projects, Share Extension, entitlements, and native module are maintained source.

CI check names, branch-protection settings, pinned toolchains, artifact retention, and local equivalents are documented in [CI and merge checks](ci.md).
