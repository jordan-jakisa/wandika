//! Native pieces Wandika's web view can't do alone, on iPhone and Android:
//! - PDF export of the print page (iPhone: a PDF in the share sheet; Android: the print dialog,
//!   where Save as PDF is a printer);
//! - voice notes transcribed on the device, with partial text sent while you speak.
//!
//! On the Mac, PDF export is the web view's own print panel and voice lives in the app crate.

use serde::{Deserialize, Serialize};
use tauri::{
    Runtime,
    plugin::{Builder, TauriPlugin},
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfArgs<'a> {
    pub title: &'a str,
}

/// What the transcriber sends while it listens.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum VoiceEvent {
    /// The text so far: finished lines and the line being spoken.
    Text { text: String },
    /// Listening stopped; `text` is the whole transcript.
    Done { text: String },
    /// Listening couldn't start or broke off, with a sentence for the person.
    Failed { message: String, code: String },
}

#[cfg(mobile)]
mod mobile {
    use tauri::{
        AppHandle, Runtime,
        ipc::Channel,
        plugin::{PluginApi, PluginHandle},
    };

    #[cfg(target_os = "ios")]
    tauri::ios_plugin_binding!(init_plugin_capture);

    pub struct Capture<R: Runtime>(PluginHandle<R>);

    pub fn init<R: Runtime>(_app: &AppHandle<R>, api: PluginApi<R, ()>) -> Result<Capture<R>, tauri::plugin::mobile::PluginInvokeError> {
        #[cfg(target_os = "android")]
        let handle = api.register_android_plugin("me.jordanjakisa.wandika.capture", "CapturePlugin")?;
        #[cfg(target_os = "ios")]
        let handle = api.register_ios_plugin(init_plugin_capture)?;
        Ok(Capture(handle))
    }

    #[derive(serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct VoiceArgs {
        on_event: Channel<serde_json::Value>,
    }

    impl<R: Runtime> Capture<R> {
        pub fn export_pdf(&self, title: &str) -> Result<(), String> {
            self.0.run_mobile_plugin::<()>("exportPdf", super::PdfArgs { title }).map_err(|e| e.to_string())
        }

        /// Starts listening; partial and final text arrive on `on_event` as [`super::VoiceEvent`]s.
        pub fn voice_start(&self, on_event: Channel<serde_json::Value>) -> Result<(), String> {
            self.0.run_mobile_plugin::<()>("voiceStart", VoiceArgs { on_event }).map_err(|e| e.to_string())
        }

        pub fn voice_stop(&self) -> Result<(), String> {
            self.0.run_mobile_plugin::<()>("voiceStop", ()).map_err(|e| e.to_string())
        }

        /// Voice notes recorded from the Lock Screen or Control Center, waiting to go into the vault.
        pub fn pending_captures(&self) -> Result<Vec<super::Captured>, String> {
            #[derive(serde::Deserialize)]
            struct Out {
                captures: Vec<super::Captured>,
            }
            self.0.run_mobile_plugin::<Out>("pendingCaptures", ()).map(|o| o.captures).map_err(|e| e.to_string())
        }

        /// Forgets voice notes the vault now holds.
        pub fn clear_captures(&self, ids: Vec<String>) -> Result<(), String> {
            #[derive(serde::Serialize)]
            struct Ids {
                ids: Vec<String>,
            }
            self.0.run_mobile_plugin::<()>("clearCaptures", Ids { ids }).map_err(|e| e.to_string())
        }
    }
}

/// A voice note made away from the app: when it started (local time, `YYYY-MM-DD HH:MM`) and its text.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Captured {
    pub id: String,
    pub at: String,
    pub text: String,
}

#[cfg(mobile)]
pub use mobile::Capture;

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("capture")
        .setup(|_app, _api| {
            #[cfg(mobile)]
            {
                use tauri::Manager;
                let capture = mobile::init(_app, _api)?;
                _app.manage(capture);
            }
            Ok(())
        })
        .build()
}
