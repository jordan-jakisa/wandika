import Tauri
import UIKit
import WebKit

class PdfArgs: Decodable {
  let title: String
}

class VoiceArgs: Decodable {
  let onEvent: Channel
}

class ClearArgs: Decodable {
  let ids: [String]
}

struct VoiceMessage: Encodable {
  let kind: String
  var text: String? = nil
  var message: String? = nil
  var code: String? = nil
}

/// A page renderer with a set paper size: US Letter in the US, A4 elsewhere, with print margins.
final class PaperRenderer: UIPrintPageRenderer {
  private let paper: CGRect
  init(paper: CGRect) {
    self.paper = paper
    super.init()
  }
  override var paperRect: CGRect { paper }
  override var printableRect: CGRect { paper.insetBy(dx: 54, dy: 60) }
}

class CapturePlugin: Plugin {
  private weak var webview: WKWebView?
  private var recorder: VoiceRecorder?
  private var channel: Channel?

  override func load(webview: WKWebView) {
    self.webview = webview
  }

  /// Lays the print page out as a PDF and offers it in the share sheet: Files, Mail, AirDrop, Print.
  @objc public func exportPdf(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(PdfArgs.self)
    DispatchQueue.main.async {
      guard let webview = self.webview else { return invoke.reject("The note isn't ready to export yet.") }
      let region: String?
      if #available(iOS 16, *) { region = Locale.current.region?.identifier } else { region = Locale.current.regionCode }
      let letter = region == "US"
      let renderer = PaperRenderer(paper: letter ? CGRect(x: 0, y: 0, width: 612, height: 792) : CGRect(x: 0, y: 0, width: 595.2, height: 841.8))
      renderer.addPrintFormatter(webview.viewPrintFormatter(), startingAtPageAt: 0)
      let data = NSMutableData()
      UIGraphicsBeginPDFContextToData(data, renderer.paperRect, [kCGPDFContextTitle as String: args.title])
      renderer.prepare(forDrawingPages: NSRange(location: 0, length: renderer.numberOfPages))
      for page in 0..<renderer.numberOfPages {
        UIGraphicsBeginPDFPage()
        renderer.drawPage(at: page, in: UIGraphicsGetPDFContextBounds())
      }
      UIGraphicsEndPDFContext()

      let name = args.title.replacingOccurrences(of: "/", with: "-").trimmingCharacters(in: .whitespaces)
      let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(name.isEmpty ? "Note" : name).pdf")
      do {
        try data.write(to: url, options: .atomic)
      } catch {
        return invoke.reject("The PDF couldn't be saved: \(error.localizedDescription)")
      }
      let share = UIActivityViewController(activityItems: [url], applicationActivities: nil)
      if let pop = share.popoverPresentationController {
        pop.sourceView = webview
        pop.sourceRect = CGRect(x: webview.bounds.maxX - 56, y: webview.safeAreaInsets.top + 8, width: 44, height: 44)
      }
      var top = webview.window?.rootViewController
      while let next = top?.presentedViewController { top = next }
      top?.present(share, animated: true)
      invoke.resolve()
    }
  }

  @objc public func voiceStart(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(VoiceArgs.self)
    Task { @MainActor [weak self] in
      guard let self else { return invoke.resolve() }
      if let message = await VoiceRecorder.authorize() {
        try? args.onEvent.send(VoiceMessage(kind: "failed", message: message, code: "voice_denied"))
        return invoke.resolve()
      }
      self.recorder?.stop { _ in }
      let recorder = VoiceRecorder()
      recorder.onText = { text in try? args.onEvent.send(VoiceMessage(kind: "text", text: text)) }
      recorder.onEnd = { [weak self] text, failure in
        if let failure {
          try? args.onEvent.send(VoiceMessage(kind: "failed", text: text, message: failure, code: "voice_failed"))
        } else {
          try? args.onEvent.send(VoiceMessage(kind: "done", text: text))
        }
        self?.recorder = nil
      }
      do {
        try recorder.start()
        self.recorder = recorder
        self.channel = args.onEvent
      } catch {
        let code = (error as? VoiceError)?.code ?? "voice_failed"
        try? args.onEvent.send(VoiceMessage(kind: "failed", message: error.localizedDescription, code: code))
      }
      invoke.resolve()
    }
  }

  @objc public func voiceStop(_ invoke: Invoke) throws {
    DispatchQueue.main.async {
      guard let recorder = self.recorder, let channel = self.channel else { return invoke.resolve() }
      self.recorder = nil
      recorder.stop { text in
        try? channel.send(VoiceMessage(kind: "done", text: text))
        invoke.resolve()
      }
    }
  }

  @objc public func pendingCaptures(_ invoke: Invoke) throws {
    invoke.resolve(["captures": CaptureQueue.pending().map { ["id": $0.id, "at": $0.at, "text": $0.text] }])
  }

  @objc public func clearCaptures(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ClearArgs.self)
    CaptureQueue.clear(args.ids)
    invoke.resolve()
  }
}

@_cdecl("init_plugin_capture")
func initPlugin() -> Plugin {
  return CapturePlugin()
}
