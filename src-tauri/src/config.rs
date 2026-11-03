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

/// Google "iOS" client: used on iPhone with its reversed-client-ID URL scheme. Google doesn't
/// allow custom-scheme redirects for Android clients, so Android needs its own sign-in.
pub fn google_mobile_client_id() -> Result<&'static str> {
    if cfg!(target_os = "android") {
        return Err(msg("Google can't connect on Android in this version. Connect it on your Mac or iPhone; Outlook works here."));
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_or_blank_client_id_says_how_to_set_it_up() {
        assert_eq!(need(Some("abc.apps.googleusercontent.com"), "Google").unwrap(), "abc.apps.googleusercontent.com");
        for missing in [None, Some(""), Some("   ")] {
            let e = need(missing, "GitHub sign-in").unwrap_err();
            assert_eq!(e.friendly().0, "message");
            assert!(e.to_string().starts_with("GitHub sign-in isn't set up in this build yet."), "{e}");
            assert!(e.to_string().contains(".env"));
        }
    }

    #[test]
    fn configured_reports_each_connection_from_the_build() {
        let v = configured();
        assert_eq!(v["github"], github_client_id().is_ok());
        assert_eq!(v["microsoft"], microsoft_client_id().is_ok());
        assert_eq!(v["google"], google_desktop().is_ok(), "the Mac uses the desktop client");
        assert_eq!(v["apple"], cfg!(any(target_os = "macos", target_os = "ios")));
        assert_eq!(v.as_object().unwrap().len(), 4);
    }

    #[test]
    fn google_on_this_mac_needs_both_desktop_values() {
        // Either both halves are baked in, or the error names Google.
        match google_desktop() {
            Ok((id, secret)) => assert!(!id.trim().is_empty() && !secret.trim().is_empty()),
            Err(e) => assert!(e.to_string().starts_with("Google isn't set up")),
        }
        assert_eq!(google_mobile_client_id().is_ok(), option_env!("WANDIKA_GOOGLE_IOS_CLIENT_ID").is_some_and(|v| !v.trim().is_empty()));
    }
}
