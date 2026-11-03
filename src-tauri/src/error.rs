use serde::{Serialize, Serializer};
use std::io::ErrorKind;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Msg(String),
    #[error("GitHub returned {status}: {message}")]
    GitHub { status: u16, message: String },
    #[error("{provider} returned {status}: {message}")]
    Provider {
        provider: &'static str,
        status: u16,
        message: String,
    },
    #[error("No connection. Check your internet and try again.")]
    Offline,
    #[error("Encrypted notes are locked. Unlock them with your passphrase.")]
    Locked,
    #[error("A sync is already running.")]
    SyncBusy,
    #[error("Sync stopped.")]
    Cancelled,
    #[error("Git: {0}")]
    Git(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("Network error: {0}")]
    Http(reqwest::Error),
}

impl From<reqwest::Error> for Error {
    fn from(e: reqwest::Error) -> Self {
        if e.is_connect() || e.is_timeout() {
            Error::Offline
        } else {
            Error::Http(e)
        }
    }
}

impl Error {
    /// A stable code for the interface to act on, and the sentence a person reads: what happened
    /// and what to do next. Raw service and system text stays in `detail`.
    pub fn friendly(&self) -> (&'static str, String) {
        match self {
            Error::Msg(m) => ("message", m.clone()),
            Error::Offline => ("offline", self.to_string()),
            Error::Locked => ("locked", self.to_string()),
            Error::SyncBusy => ("sync_busy", self.to_string()),
            Error::Cancelled => (
                "cancelled",
                "Sync stopped. Nothing changed on GitHub; the next sync picks up from here.".into(),
            ),
            Error::GitHub { status, message } => {
                let lower = message.to_lowercase();
                match status {
                    403 | 429 if lower.contains("rate limit") || *status == 429 => (
                        "github_rate_limit",
                        "GitHub is limiting requests right now. Wandika will try again in a few minutes.".into(),
                    ),
                    403 => ("github_forbidden", "GitHub didn't allow that. Check that your account can write to this repository.".into()),
                    404 => (
                        "github_not_found",
                        "GitHub can't find that repository. It may have been renamed, deleted or made private.".into(),
                    ),
                    409 => ("github_conflict", "The repository changed while Wandika was working. Try again.".into()),
                    422 if lower.contains("already exists") || lower.contains("creation failed") => (
                        "github_name_taken",
                        "You already have a repository with that name. Pick another name, or choose it from the list.".into(),
                    ),
                    422 => ("github_invalid", "GitHub couldn't do that. Check the name and try again.".into()),
                    500.. => ("github_down", "GitHub is having trouble. Your notes are safe here, and sync will try again.".into()),
                    _ => ("github", "GitHub couldn't finish that. Try again in a minute.".into()),
                }
            }
            Error::Provider { provider, status, .. } => match status {
                400 | 401 => ("provider_auth", format!("{provider} needs you to sign in again. Reconnect it in Settings, under Connections.")),
                403 => ("provider_forbidden", format!("{provider} didn't allow that. Reconnect it in Settings and allow access.")),
                429 => ("provider_rate_limit", format!("{provider} is busy. Try again in a few minutes.")),
                500.. => ("provider_down", format!("{provider} is having trouble. Try again in a few minutes.")),
                _ => ("provider", format!("{provider} couldn't finish that. Try again.")),
            },
            Error::Io(e) => match e.kind() {
                ErrorKind::StorageFull => ("disk_full", "This device is out of space. Free up some space and try again.".into()),
                ErrorKind::PermissionDenied | ErrorKind::ReadOnlyFilesystem => (
                    "no_access",
                    "Wandika isn't allowed to change that folder. Allow access in System Settings, or choose the folder again.".into(),
                ),
                ErrorKind::NotFound => (
                    "not_found",
                    "That file isn't there any more. It may have been moved or deleted on another device.".into(),
                ),
                _ => ("io", "Wandika couldn't read or write a file. Try again.".into()),
            },
            Error::Git(_) => ("git", "Sync couldn't finish. Your notes are safe here; it will try again shortly.".into()),
            Error::Json(_) => ("bad_response", "A service sent a reply Wandika didn't expect. Try again in a minute.".into()),
            Error::Http(_) => ("network", "Couldn't reach the service. Check your connection and try again.".into()),
        }
    }
}

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let (code, message) = self.friendly();
        let mut st = s.serialize_struct("Error", 3)?;
        st.serialize_field("code", code)?;
        st.serialize_field("message", &message)?;
        st.serialize_field("detail", &self.to_string())?;
        st.end()
    }
}

pub type Result<T> = std::result::Result<T, Error>;

pub fn msg(s: impl Into<String>) -> Error {
    Error::Msg(s.into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_service_text_never_reaches_the_message() {
        let e = Error::GitHub { status: 422, message: "Repository creation failed.".into() };
        assert_eq!(e.friendly().0, "github_name_taken");
        let e = Error::GitHub { status: 403, message: "API rate limit exceeded for user ID 1".into() };
        assert_eq!(e.friendly().0, "github_rate_limit");
        let e = Error::Io(std::io::Error::from(ErrorKind::PermissionDenied));
        let (code, text) = e.friendly();
        assert_eq!(code, "no_access");
        assert!(!text.contains("os error"));
        let json = serde_json::to_value(Error::Offline).unwrap();
        assert_eq!(json["code"], "offline");
    }

    fn code(e: Error) -> &'static str {
        e.friendly().0
    }

    fn github(status: u16, message: &str) -> Error {
        Error::GitHub { status, message: message.into() }
    }

    #[test]
    fn every_github_status_gets_its_own_code() {
        assert_eq!(code(github(429, "slow down")), "github_rate_limit", "429 is a limit whatever it says");
        assert_eq!(code(github(403, "You have exceeded a secondary RATE LIMIT")), "github_rate_limit");
        assert_eq!(code(github(403, "Resource not accessible by integration")), "github_forbidden");
        assert_eq!(code(github(404, "Not Found")), "github_not_found");
        assert_eq!(code(github(409, "Git Repository is empty.")), "github_conflict");
        assert_eq!(code(github(422, "name already exists on this account")), "github_name_taken");
        assert_eq!(code(github(422, "Validation Failed")), "github_invalid");
        assert_eq!(code(github(500, "Server Error")), "github_down");
        assert_eq!(code(github(503, "Unavailable")), "github_down");
        assert_eq!(code(github(400, "Bad request")), "github");
        assert_eq!(code(github(418, "teapot")), "github");
    }

    #[test]
    fn provider_errors_name_the_provider_and_say_what_to_do() {
        let p = |status| Error::Provider { provider: "Outlook", status, message: "invalid_grant".into() };
        for (status, want) in [
            (400, "provider_auth"),
            (401, "provider_auth"),
            (403, "provider_forbidden"),
            (429, "provider_rate_limit"),
            (500, "provider_down"),
            (502, "provider_down"),
            (404, "provider"),
        ] {
            let (code, text) = p(status).friendly();
            assert_eq!(code, want, "status {status}");
            assert!(text.starts_with("Outlook "), "{text}");
            assert!(!text.contains("invalid_grant"), "raw provider text stays in detail");
        }
        assert_eq!(p(401).to_string(), "Outlook returned 401: invalid_grant");
    }

    #[test]
    fn file_errors_say_what_happened_without_os_text() {
        for (kind, want) in [
            (ErrorKind::StorageFull, "disk_full"),
            (ErrorKind::PermissionDenied, "no_access"),
            (ErrorKind::ReadOnlyFilesystem, "no_access"),
            (ErrorKind::NotFound, "not_found"),
            (ErrorKind::Interrupted, "io"),
        ] {
            let (code, text) = Error::Io(std::io::Error::from(kind)).friendly();
            assert_eq!(code, want, "{kind:?}");
            assert!(!text.contains("os error"));
        }
    }

    #[test]
    fn plain_states_have_stable_codes() {
        assert_eq!(msg("Give the note a name.").friendly(), ("message", "Give the note a name.".to_string()));
        assert_eq!(code(Error::Offline), "offline");
        assert_eq!(code(Error::Locked), "locked");
        assert_eq!(code(Error::SyncBusy), "sync_busy");
        let (c, text) = Error::Cancelled.friendly();
        assert_eq!(c, "cancelled");
        assert!(text.contains("Nothing changed on GitHub"));
        let (c, text) = Error::Git("object not found - no match for id".into()).friendly();
        assert_eq!(c, "git");
        assert!(!text.contains("object not found"));
        let bad: Error = serde_json::from_str::<serde_json::Value>("{").unwrap_err().into();
        assert_eq!(code(bad), "bad_response");
    }

    #[test]
    fn serializes_code_message_and_raw_detail() {
        let json = serde_json::to_value(github(404, "Not Found")).unwrap();
        assert_eq!(json["code"], "github_not_found");
        assert!(json["message"].as_str().unwrap().contains("can't find that repository"));
        assert_eq!(json["detail"], "GitHub returned 404: Not Found");
        assert_eq!(json.as_object().unwrap().len(), 3);
        let json = serde_json::to_value(Error::Git("bad pack".into())).unwrap();
        assert_eq!(json["detail"], "Git: bad pack");
    }

    #[test]
    fn a_refused_connection_reads_as_offline_and_a_bad_request_as_network() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        // Nothing listens on a port that was just freed.
        let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
        let refused = rt.block_on(reqwest::get(format!("http://127.0.0.1:{port}/"))).unwrap_err();
        assert!(matches!(Error::from(refused), Error::Offline));
        let bad = rt.block_on(reqwest::Client::new().get("not a url").send()).unwrap_err();
        let e = Error::from(bad);
        assert!(matches!(e, Error::Http(_)));
        assert_eq!(code(e), "network");
    }
}
