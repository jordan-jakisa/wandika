// Voice notes made away from the app wait here as small files until Wandika adds them to the
// vault. Each is removed only after the vault has it, so nothing is lost if the app is closed.
//
// Compiled into the capture plugin and into the app target; both use the same folder.

import Foundation

struct PendingCapture: Codable {
  let id: String
  /// When it started, local time, "YYYY-MM-DD HH:MM".
  let at: String
  let text: String
}

enum CaptureQueue {
  static var folder: URL {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    return base.appendingPathComponent("VoiceCaptures", isDirectory: true)
  }

  static func stamp(_ date: Date) -> String {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyy-MM-dd HH:mm"
    return f.string(from: date)
  }

  static func save(text: String, started: Date) throws {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let item = PendingCapture(id: "\(Int(started.timeIntervalSince1970))-\(UUID().uuidString)", at: stamp(started), text: trimmed)
    let data = try JSONEncoder().encode(item)
    try data.write(to: folder.appendingPathComponent("\(item.id).json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
  }

  static func pending() -> [PendingCapture] {
    let files = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
    return files.filter { $0.pathExtension == "json" }
      .compactMap { try? JSONDecoder().decode(PendingCapture.self, from: Data(contentsOf: $0)) }
      .sorted { $0.id < $1.id }
  }

  static func clear(_ ids: [String]) {
    for id in ids where !id.contains("/") {
      try? FileManager.default.removeItem(at: folder.appendingPathComponent("\(id).json"))
    }
  }
}
