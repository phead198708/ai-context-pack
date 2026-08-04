# Local development setup

AI Context Pack uses committed native projects. Expo Go and destructive native regeneration are not supported.

## Required tools

- Node 22.13.x-compatible pinned Node 22 (`.nvmrc` is 22.13.1).
- Xcode 26 or newer (Swift tools 6.2+) with an iOS 16.4+ simulator runtime and CocoaPods. Expo SDK 57's `expo-modules-jsi` package cannot build with Xcode 16 / Swift 6.0.
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
xcodebuild -workspace ios/AIContextPack.xcworkspace -scheme AIContextPack -configuration Debug -sdk iphonesimulator CODE_SIGNING_ALLOWED=NO build
./android/gradlew -p android :app:testDebugUnitTest :context-native:testDebugUnitTest :app:assembleDebug

# With an API 35+ emulator/device attached, execute the real text/scanned PDF fixtures.
./android/gradlew -p android :context-native:connectedDebugAndroidTest
```

Run development builds with `npm run ios` or `npm run android`. These use Expo CLI and a custom development client, not Expo Go.

Expo Doctor's app-config synchronization check is intentionally disabled in `package.json`: this repository commits and reviews its native projects, and every native field (including the URL scheme) must be mirrored explicitly instead of regenerated with Prebuild.

After installing the Android development build, verify its committed native URL registration with:

```sh
adb shell am start -W -a android.intent.action.VIEW -c android.intent.category.BROWSABLE -d 'aicontextpack://' -p com.aicontextpack
```

Package resolution must select `com.aicontextpack/.MainActivity`; after that handoff, a Debug build may report Expo's `DevLauncherActivity` as the displayed development-client activity. The `aicontextpack` filter intentionally has no host or path wildcard.

The iOS placeholder identifiers `com.example.aicontextpack` and `group.com.example.aicontextpack` intentionally do not contain a team ID. Replace them only through an approved release configuration; never commit certificates, profiles, keystores, or private team values.

Do not run `expo prebuild --clean`. The Swift/Kotlin projects, Share Extension, entitlements, and native module are maintained source.

CI check names, branch-protection settings, pinned toolchains, artifact retention, and local equivalents are documented in [CI and merge checks](ci.md).
