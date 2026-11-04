// The Live Activity a voice note shows while it records from the Lock Screen or Control Center.
// iOS requires one for recording started by an intent, and it shows the person the mic is on.
// Compiled into the app and the widget extension.

import ActivityKit
import Foundation

struct VoiceNoteAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    /// The last words heard, or what happened once it ends.
    var text: String
    var listening: Bool
  }

  var started: Date
}
