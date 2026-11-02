use serde::{Serialize, Serializer};

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

impl Serialize for Error {
    fn serialize<S: Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type Result<T> = std::result::Result<T, Error>;

pub fn msg(s: impl Into<String>) -> Error {
    Error::Msg(s.into())
}
