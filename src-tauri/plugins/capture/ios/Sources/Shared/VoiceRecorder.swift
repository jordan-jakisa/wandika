// Listens to the microphone and turns speech into text on the device. No audio leaves the phone:
// a recognizer that can't run offline isn't used. A pause of two seconds starts a new line.
//
// Compiled twice: into the capture plugin (the mic in a note) and into the app target (voice
// notes from the Lock Screen and Control Center), so the file stands on its own.

import AVFoundation
import Foundation
import Speech

final class VoiceRecorder {
  /// The transcript so far, every time it changes. Called on the main queue.
  var onText: ((String) -> Void)?
  /// Called once when listening ends by itself (a call came in, the recognizer failed).
  var onEnd: ((String, String?) -> Void)?

  private let engine = AVAudioEngine()
  private var recognizer: SFSpeechRecognizer?
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var tasks: [SFSpeechRecognitionTask] = []
  /// One entry per line: a pause ends a line and the next words start another.
  private var lines: [String] = []
  private var silence: Timer?
  private var interruption: NSObjectProtocol?
  private(set) var running = false

  var text: String { lines.map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.joined(separator: "\n") }

  /// Asks for the microphone and speech recognition; returns a sentence for the person when either is off.
  static func authorize() async -> String? {
    let mic: Bool
    if #available(iOS 17, *) {
      mic = await AVAudioApplication.requestRecordPermission()
    } else {
      mic = await withCheckedContinuation { done in AVAudioSession.sharedInstance().requestRecordPermission { done.resume(returning: $0) } }
    }
    if !mic { return "Wandika can't use the microphone. Turn it on in Settings, Wandika, Microphone." }
    let speech = await withCheckedContinuation { (done: CheckedContinuation<SFSpeechRecognizerAuthorizationStatus, Never>) in
      SFSpeechRecognizer.requestAuthorization { done.resume(returning: $0) }
    }
    if speech != .authorized {
      return "Wandika can't turn speech into text. Turn on Speech Recognition in Settings, Wandika."
    }
    return nil
  }

  /// The person's language when the phone can recognize it offline, else English if that can.
  private static func offlineRecognizer() -> SFSpeechRecognizer? {
    for locale in [Locale.current, Locale(identifier: "en-US")] {
      if let r = SFSpeechRecognizer(locale: locale), r.supportsOnDeviceRecognition { return r }
    }
    return nil
  }

  func start() throws {
    guard let r = Self.offlineRecognizer(), r.isAvailable else {
      throw VoiceError(
        "This iPhone can't turn speech into text offline yet. In Settings, General, Keyboard, turn on Dictation and add your language, then try again.",
        code: "voice_offline")
    }
    recognizer = r
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
    try session.setActive(true, options: .notifyOthersOnDeactivation)
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0 else { throw VoiceError("No microphone is available right now.", code: "voice_mic") }
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
      self?.request?.append(buffer)
    }
    engine.prepare()
    try engine.start()
    running = true
    interruption = NotificationCenter.default.addObserver(
      forName: AVAudioSession.interruptionNotification, object: session, queue: .main
    ) { [weak self] note in
      guard let self, self.running,
        let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
        AVAudioSession.InterruptionType(rawValue: raw) == .began
      else { return }
      self.stop { text in self.onEnd?(text, nil) }
    }
    newLine()
  }

  private func newLine() {
    guard let recognizer else { return }
    request?.endAudio()
    let req = SFSpeechAudioBufferRecognitionRequest()
    req.shouldReportPartialResults = true
    req.requiresOnDeviceRecognition = true
    if #available(iOS 16, *) { req.addsPunctuation = true }
    request = req
    let index = lines.count
    lines.append("")
    let task = recognizer.recognitionTask(with: req) { [weak self] result, error in
      DispatchQueue.main.async {
        guard let self else { return }
        if let result {
          self.lines[index] = result.bestTranscription.formattedString
          self.onText?(self.text)
          if index == self.lines.count - 1 && self.running { self.armSilence() }
        }
        // "No speech" on a line that stayed empty isn't a failure; anything else on the live line is.
        if let error, result == nil, index == self.lines.count - 1, self.running, !self.lines[index].isEmpty {
          let text = self.text
          self.finish()
          self.onEnd?(text, error.localizedDescription)
        }
      }
    }
    tasks.append(task)
  }

  private func armSilence() {
    silence?.invalidate()
    silence = Timer.scheduledTimer(withTimeInterval: 2, repeats: false) { [weak self] _ in
      guard let self, self.running, !(self.lines.last ?? "").isEmpty else { return }
      self.newLine()
    }
  }

  /// Stops listening and hands back the whole transcript once the last words are recognized.
  func stop(_ done: @escaping (String) -> Void) {
    guard running else { return done(text) }
    running = false
    silence?.invalidate()
    engine.inputNode.removeTap(onBus: 0)
    engine.stop()
    request?.endAudio()
    // The final result of the last line arrives shortly after the audio ends.
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
      guard let self else { return done("") }
      let text = self.text
      self.finish()
      done(text)
    }
  }

  private func finish() {
    running = false
    silence?.invalidate()
    if engine.isRunning {
      engine.inputNode.removeTap(onBus: 0)
      engine.stop()
    }
    tasks.forEach { $0.cancel() }
    tasks = []
    request = nil
    if let interruption { NotificationCenter.default.removeObserver(interruption) }
    interruption = nil
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }
}

struct VoiceError: LocalizedError {
  let message: String
  let code: String
  init(_ message: String, code: String) {
    self.message = message
    self.code = code
  }
  var errorDescription: String? { message }
}
