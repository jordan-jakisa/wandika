//! Voice notes and PDF export.
//!
//! - In a note, the mic turns speech into text on the device: the capture plugin on iPhone and
//!   Android, Apple's Speech framework on the Mac. Text arrives on a channel while you speak.
//! - On iPhone, voice notes recorded from the Lock Screen or Control Center wait in the app until
//!   it opens, then go into that day's daily note.
//! - PDF export prints the page the interface laid out: the Mac's print panel (Save as PDF), a PDF
//!   in the iPhone's share sheet, or Android's print dialog (Save as PDF).

use crate::commands::S;
use crate::error::{Error, Result};
use serde_json::Value;
#[cfg(not(mobile))]
use serde_json::json;
use tauri::ipc::Channel;

fn msg(m: impl Into<String>) -> Error {
    Error::Msg(m.into())
}

#[tauri::command]
pub async fn note_print(window: tauri::WebviewWindow, title: String) -> Result<()> {
    #[cfg(mobile)]
    {
        use tauri::Manager;
        let _ = &window;
        window.state::<tauri_plugin_capture::Capture<tauri::Wry>>().export_pdf(&title).map_err(msg)
    }
    #[cfg(desktop)]
    {
        let _ = title;
        window.print().map_err(|e| msg(format!("The print panel didn't open: {e}")))
    }
}

#[tauri::command]
pub async fn voice_start(window: tauri::WebviewWindow, on_event: Channel<Value>) -> Result<()> {
    #[cfg(mobile)]
    {
        use tauri::Manager;
        window.state::<tauri_plugin_capture::Capture<tauri::Wry>>().voice_start(on_event).map_err(msg)
    }
    #[cfg(target_os = "macos")]
    {
        let _ = window;
        mac::start(on_event).await
    }
    #[cfg(not(any(mobile, target_os = "macos")))]
    {
        let _ = window;
        let _ = on_event.send(json!({ "kind": "failed", "code": "voice_offline", "message": "Voice notes need a Mac, an iPhone or an Android phone." }));
        Ok(())
    }
}

#[tauri::command]
pub async fn voice_stop(window: tauri::WebviewWindow) -> Result<()> {
    #[cfg(mobile)]
    {
        use tauri::Manager;
        window.state::<tauri_plugin_capture::Capture<tauri::Wry>>().voice_stop().map_err(msg)
    }
    #[cfg(not(mobile))]
    {
        let _ = window;
        #[cfg(target_os = "macos")]
        mac::stop().await;
        Ok(())
    }
}

/// Puts voice notes made from the Lock Screen or Control Center into their daily notes, and
/// returns the daily notes that changed. Each note is forgotten only once the vault has it.
#[tauri::command]
pub async fn captures_import(app: S<'_>, window: tauri::WebviewWindow) -> Result<Vec<String>> {
    #[cfg(mobile)]
    {
        use tauri::Manager;
        let capture = window.state::<tauri_plugin_capture::Capture<tauri::Wry>>();
        let pending = capture.pending_captures().map_err(msg)?;
        if pending.is_empty() {
            return Ok(Vec::new());
        }
        let (root, crypto) = (app.root()?, app.crypto()?);
        let mut done = Vec::new();
        let mut paths: Vec<String> = Vec::new();
        for c in pending {
            let Ok(at) = chrono::NaiveDateTime::parse_from_str(&c.at, "%Y-%m-%d %H:%M") else { continue };
            let rel = crate::vault::add_voice_note(&root, at, &c.text, &crypto)?;
            done.push(c.id);
            if !paths.contains(&rel) {
                paths.push(rel);
            }
        }
        capture.clear_captures(done).map_err(msg)?;
        crate::commands::changed(&app);
        Ok(paths)
    }
    #[cfg(not(mobile))]
    {
        let _ = (app, window);
        Ok(Vec::new())
    }
}

#[cfg(target_os = "macos")]
mod mac {
    //! The Mac's microphone and on-device speech recognition, through Apple's own frameworks.
    //! A pause of two seconds starts a new line, as on iPhone.

    use super::*;
    use block2::RcBlock;
    use objc2::AnyThread;
    use objc2::rc::Retained;
    use objc2::runtime::Bool;
    use objc2_avf_audio::{AVAudioApplication, AVAudioEngine, AVAudioPCMBuffer, AVAudioTime};
    use objc2_foundation::{NSError, NSLocale, NSString};
    use objc2_speech::{
        SFSpeechAudioBufferRecognitionRequest, SFSpeechRecognitionResult, SFSpeechRecognitionTask, SFSpeechRecognizer,
        SFSpeechRecognizerAuthorizationStatus,
    };
    use std::ptr::NonNull;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    /// Objective-C objects owned by one listening session; they are only touched under the lock.
    struct Objc {
        engine: Retained<AVAudioEngine>,
        recognizer: Retained<SFSpeechRecognizer>,
        request: Retained<SFSpeechAudioBufferRecognitionRequest>,
        tasks: Vec<Retained<SFSpeechRecognitionTask>>,
    }
    // SAFETY: AVAudioEngine and the Speech objects are thread-safe for these calls, and every use
    // goes through the session's mutex.
    unsafe impl Send for Objc {}

    struct Session {
        objc: Objc,
        lines: Vec<String>,
        changed: Instant,
        running: bool,
        channel: Channel<Value>,
    }

    type Shared = Arc<Mutex<Option<Session>>>;
    static SESSION: Mutex<Option<Shared>> = Mutex::new(None);

    fn text(lines: &[String]) -> String {
        lines.iter().map(|l| l.trim()).filter(|l| !l.is_empty()).collect::<Vec<_>>().join("\n")
    }

    fn fail(channel: &Channel<Value>, code: &str, message: &str) {
        let _ = channel.send(json!({ "kind": "failed", "code": code, "message": message }));
    }

    async fn ask_mic() -> bool {
        let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
        {
            let tx = Mutex::new(Some(tx));
            let block = RcBlock::new(move |ok: Bool| {
                if let Some(tx) = tx.lock().unwrap().take() {
                    let _ = tx.send(ok.as_bool());
                }
            });
            unsafe { AVAudioApplication::requestRecordPermissionWithCompletionHandler(&block) };
        }
        rx.await.unwrap_or(false)
    }

    async fn ask_speech() -> bool {
        let (tx, rx) = tokio::sync::oneshot::channel::<bool>();
        {
            let tx = Mutex::new(Some(tx));
            let block = RcBlock::new(move |status: SFSpeechRecognizerAuthorizationStatus| {
                if let Some(tx) = tx.lock().unwrap().take() {
                    let _ = tx.send(status == SFSpeechRecognizerAuthorizationStatus::Authorized);
                }
            });
            unsafe { SFSpeechRecognizer::requestAuthorization(&block) };
        }
        rx.await.unwrap_or(false)
    }

    /// The person's language when the Mac can recognize it offline, else English if it can.
    fn recognizer() -> Option<Retained<SFSpeechRecognizer>> {
        let current = NSLocale::currentLocale();
        let english = NSLocale::initWithLocaleIdentifier(NSLocale::alloc(), &NSString::from_str("en-US"));
        for locale in [current, english] {
            let r = unsafe { SFSpeechRecognizer::initWithLocale(SFSpeechRecognizer::alloc(), &locale) }?;
            if unsafe { r.supportsOnDeviceRecognition() && r.isAvailable() } {
                return Some(r);
            }
        }
        None
    }

    /// Ends the current line's audio and starts the next line's recognition.
    fn new_line(shared: &Shared, s: &mut Session) {
        unsafe { s.objc.request.endAudio() };
        let request = unsafe { SFSpeechAudioBufferRecognitionRequest::new() };
        unsafe {
            request.setShouldReportPartialResults(true);
            request.setRequiresOnDeviceRecognition(true);
            request.setAddsPunctuation(true);
        }
        let index = s.lines.len();
        s.lines.push(String::new());
        let weak = Arc::downgrade(shared);
        let handler = RcBlock::new(move |result: *mut SFSpeechRecognitionResult, _error: *mut NSError| {
            let Some(result) = (unsafe { result.as_ref() }) else { return };
            let words = unsafe { result.bestTranscription().formattedString() }.to_string();
            let Some(shared) = weak.upgrade() else { return };
            let mut guard = shared.lock().unwrap();
            let Some(s) = guard.as_mut() else { return };
            if let Some(line) = s.lines.get_mut(index) {
                *line = words;
                s.changed = Instant::now();
                let _ = s.channel.send(json!({ "kind": "text", "text": text(&s.lines) }));
            }
        });
        let task = unsafe { s.objc.recognizer.recognitionTaskWithRequest_resultHandler(&request, &handler) };
        s.objc.tasks.push(task);
        s.objc.request = request;
    }

    pub async fn start(channel: Channel<Value>) -> Result<()> {
        stop().await;
        if !ask_mic().await {
            fail(&channel, "voice_denied", "Wandika can't use the microphone. Turn it on in System Settings, Privacy & Security, Microphone.");
            return Ok(());
        }
        if !ask_speech().await {
            fail(&channel, "voice_denied", "Wandika can't turn speech into text. Turn it on in System Settings, Privacy & Security, Speech Recognition.");
            return Ok(());
        }
        begin(channel);
        Ok(())
    }

    /// Starts the microphone and the first line's recognition. Everything Objective-C stays here,
    /// out of the async command.
    fn begin(channel: Channel<Value>) {
        let Some(recognizer) = recognizer() else {
            fail(&channel, "voice_offline", "This Mac can't turn speech into text offline yet. In System Settings, Keyboard, turn on Dictation, then try again.");
            return;
        };
        let engine = unsafe { AVAudioEngine::new() };
        let input = unsafe { engine.inputNode() };
        let format = unsafe { input.outputFormatForBus(0) };
        if unsafe { format.sampleRate() } <= 0.0 {
            fail(&channel, "voice_mic", "No microphone is available right now.");
            return;
        }
        let shared: Shared = Arc::new(Mutex::new(Some(Session {
            objc: Objc { engine: engine.clone(), recognizer, request: unsafe { SFSpeechAudioBufferRecognitionRequest::new() }, tasks: Vec::new() },
            lines: Vec::new(),
            changed: Instant::now(),
            running: true,
            channel: channel.clone(),
        })));
        {
            let mut guard = shared.lock().unwrap();
            new_line(&shared, guard.as_mut().unwrap());
        }
        let tap_target = Arc::downgrade(&shared);
        let tap = RcBlock::new(move |buffer: NonNull<AVAudioPCMBuffer>, _when: NonNull<AVAudioTime>| {
            let Some(shared) = tap_target.upgrade() else { return };
            let guard = shared.lock().unwrap();
            if let Some(s) = guard.as_ref() {
                unsafe { s.objc.request.appendAudioPCMBuffer(buffer.as_ref()) };
            }
        });
        unsafe {
            input.installTapOnBus_bufferSize_format_block(0, 1024, Some(&format), RcBlock::as_ptr(&tap));
            engine.prepare();
        }
        if let Err(e) = unsafe { engine.startAndReturnError() } {
            unsafe { input.removeTapOnBus(0) };
            fail(&channel, "voice_mic", &format!("The microphone didn't start: {}", e.localizedDescription()));
            return;
        }
        *SESSION.lock().unwrap() = Some(shared.clone());
        // Two seconds without new words ends the line.
        let watched = Arc::downgrade(&shared);
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(Duration::from_millis(250));
                let Some(shared) = watched.upgrade() else { return };
                let mut guard = shared.lock().unwrap();
                let Some(s) = guard.as_mut() else { return };
                if !s.running {
                    return;
                }
                let spoken = s.lines.last().is_some_and(|l| !l.trim().is_empty());
                if spoken && s.changed.elapsed() >= Duration::from_secs(2) {
                    new_line(&shared, s);
                }
            }
        });
    }

    /// Stops listening and sends the whole transcript once the last words are recognized.
    pub async fn stop() {
        let Some(shared) = halt() else { return };
        tokio::time::sleep(Duration::from_millis(1200)).await;
        finish(&shared);
    }

    /// Stops the microphone; recognition of the last words carries on for a moment.
    fn halt() -> Option<Shared> {
        let shared = SESSION.lock().unwrap().take()?;
        // The engine is stopped outside the lock: its audio thread may be waiting on the lock.
        let engine = {
            let mut guard = shared.lock().unwrap();
            let s = guard.as_mut()?;
            s.running = false;
            s.objc.engine.clone()
        };
        unsafe {
            engine.inputNode().removeTapOnBus(0);
            engine.stop();
        }
        if let Some(s) = shared.lock().unwrap().as_ref() {
            unsafe { s.objc.request.endAudio() };
        }
        Some(shared)
    }

    fn finish(shared: &Shared) {
        let session = shared.lock().unwrap().take();
        if let Some(s) = session {
            for t in &s.objc.tasks {
                unsafe { t.cancel() };
            }
            let _ = s.channel.send(json!({ "kind": "done", "text": text(&s.lines) }));
        }
    }
}
