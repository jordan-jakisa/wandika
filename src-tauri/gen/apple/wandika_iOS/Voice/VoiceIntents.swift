// The actions behind the Voice note control and the Stop button on the Live Activity. iOS runs
// them in the app's own process, without opening the app. Compiled into the app and the widget
// extension; only the app does the recording.

import AppIntents

struct StartVoiceNoteIntent: AudioRecordingIntent {
  static let title: LocalizedStringResource = "New voice note"
  static let description = IntentDescription(
    "Records a voice note and turns it into text on your iPhone. The words go into today's daily note in Wandika.")
  static let openAppWhenRun = false

  func perform() async throws -> some IntentResult {
    #if !WIDGET_EXTENSION
      try await LockCapture.shared.toggle()
    #endif
    return .result()
  }
}

struct StopVoiceNoteIntent: LiveActivityIntent {
  static let title: LocalizedStringResource = "Stop voice note"
  static let description = IntentDescription("Stops the voice note and keeps what was said.")
  static let isDiscoverable = false

  func perform() async throws -> some IntentResult {
    #if !WIDGET_EXTENSION
      await LockCapture.shared.stop()
    #endif
    return .result()
  }
}
