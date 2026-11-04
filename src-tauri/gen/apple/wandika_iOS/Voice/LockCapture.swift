// Records a voice note started from the Lock Screen, Control Center, the Action button or Siri.
// The words are turned into text on the iPhone, shown in the Live Activity while you speak, and
// kept in the capture queue until Wandika opens and adds them to that day's daily note.

import ActivityKit
import AppIntents
import Foundation

@MainActor
final class LockCapture {
  static let shared = LockCapture()

  private var recorder: VoiceRecorder?
  private var activity: Activity<VoiceNoteAttributes>?
  private var started = Date()
  private var lastUpdate = Date.distantPast

  func toggle() async throws {
    if recorder != nil {
      await stop()
    } else {
      try await start()
    }
  }

  private func start() async throws {
    if let message = await VoiceRecorder.authorize() { throw VoiceError(message, code: "voice_denied") }
    started = Date()
    // The Live Activity comes first: iOS stops recording started by an intent without one.
    activity = try Activity.request(
      attributes: VoiceNoteAttributes(started: started),
      content: .init(state: .init(text: "", listening: true), staleDate: nil))
    let recorder = VoiceRecorder()
    recorder.onText = { [weak self] text in self?.show(text) }
    recorder.onEnd = { [weak self] text, _ in
      Task { await self?.keep(text) }
    }
    do {
      try recorder.start()
    } catch {
      await end("Voice note didn't start.")
      throw error
    }
    self.recorder = recorder
  }

  /// The last words, about once a second: Live Activity updates are rationed.
  private func show(_ text: String) {
    guard Date().timeIntervalSince(lastUpdate) >= 1 else { return }
    lastUpdate = Date()
    let tail = String(text.split(separator: "\n").last ?? "").suffix(120)
    Task { await activity?.update(.init(state: .init(text: String(tail), listening: true), staleDate: nil)) }
  }

  func stop() async {
    guard let recorder else { return await end(nil) }
    self.recorder = nil
    let text = await withCheckedContinuation { done in recorder.stop { done.resume(returning: $0) } }
    await keep(text)
  }

  private func keep(_ text: String) async {
    recorder = nil
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return await end("Nothing was heard.") }
    do {
      try CaptureQueue.save(text: trimmed, started: started)
      await end("Saved. It goes into today's note when you open Wandika.")
    } catch {
      await end("The voice note couldn't be saved.")
    }
  }

  private func end(_ message: String?) async {
    let state = VoiceNoteAttributes.ContentState(text: message ?? "", listening: false)
    await activity?.end(.init(state: state, staleDate: nil), dismissalPolicy: .after(Date().addingTimeInterval(5)))
    activity = nil
  }
}

/// "Hey Siri, new voice note in Wandika", and the same in Shortcuts and on the Action button.
struct WandikaShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: StartVoiceNoteIntent(),
      phrases: ["New voice note in \(.applicationName)", "Record a voice note in \(.applicationName)"],
      shortTitle: "Voice note",
      systemImageName: "mic")
  }
}
