// swift-tools-version:5.9

import PackageDescription

let package = Package(
  name: "tauri-plugin-capture",
  platforms: [
    .iOS(.v17)
  ],
  products: [
    .library(name: "tauri-plugin-capture", type: .static, targets: ["tauri-plugin-capture"])
  ],
  dependencies: [
    .package(name: "Tauri", path: "../.tauri/tauri-api")
  ],
  targets: [
    .target(name: "tauri-plugin-capture", dependencies: [.byName(name: "Tauri")], path: "Sources")
  ]
)
