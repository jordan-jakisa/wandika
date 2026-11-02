//! OAuth client IDs, baked in at build time from `.env` (see `.env.example` and docs/setup.md).

use crate::error::{msg, Result};

fn need(value: Option<&'static str>, what: &str) -> Result<&'static str> {
    value.filter(|v| !v.trim().is_empty()).ok_or_else(|| {
        msg(format!(
            "{what} isn't set up in this build yet. Add its client ID to .env and rebuild (docs/setup.md)."
        ))
    })
}

pub fn github_client_id() -> Result<&'static str> {
    need(option_env!("WANDIKA_GITHUB_CLIENT_ID"), "GitHub sign-in")
}

/// Google "Desktop app" client: used on the Mac with a loopback redirect.
pub fn google_desktop() -> Result<(&'static str, &'static str)> {
    Ok((
        need(option_env!("WANDIKA_GOOGLE_DESKTOP_CLIENT_ID"), "Google")?,
        need(option_env!("WANDIKA_GOOGLE_DESKTOP_CLIENT_SECRET"), "Google")?,
    ))
}

/// Google "iOS" client: used on iPhone and Android with its reversed-client-ID URL scheme.
pub fn google_mobile_client_id() -> Result<&'static str> {
    need(option_env!("WANDIKA_GOOGLE_IOS_CLIENT_ID"), "Google")
}

pub fn microsoft_client_id() -> Result<&'static str> {
    need(option_env!("WANDIKA_MICROSOFT_CLIENT_ID"), "Outlook")
}

pub fn configured() -> serde_json::Value {
    serde_json::json!({
        "github": github_client_id().is_ok(),
        "google": if cfg!(mobile) { google_mobile_client_id().is_ok() } else { google_desktop().is_ok() },
        "microsoft": microsoft_client_id().is_ok(),
        "apple": cfg!(any(target_os = "macos", target_os = "ios")),
    })
}
