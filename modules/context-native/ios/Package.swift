// swift-tools-version: 5.9

import PackageDescription

let package = Package(
  name: "ContextNativeRecovery",
  platforms: [.macOS(.v13)],
  products: [
    .library(name: "ContextNativeRecovery", targets: ["ContextNativeRecovery"]),
  ],
  targets: [
    .target(
      name: "ContextNativeRecovery",
      path: ".",
      exclude: ["ContextNative.podspec", "ContextNativeModule.swift", "Tests"],
      sources: [
        "InboxArtifactHandoff.swift",
        "InboxManifestValidator.swift",
        "InboxRecoverySupport.swift",
        "InboxWriterOwnership.swift",
        "OwnedArtifactStore.swift",
        "PrivacySafeLogger.swift",
      ]
    ),
    .testTarget(
      name: "ContextNativeRecoveryTests",
      dependencies: ["ContextNativeRecovery"],
      path: "Tests"
    ),
  ]
)
