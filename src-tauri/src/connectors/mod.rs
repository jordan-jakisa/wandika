//! Mail, calendar and task sources shown beside the notes.

pub mod apple;
pub mod google;
pub mod microsoft;
pub mod oauth;

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct CalEvent {
    pub id: String,
    pub source: String,
    pub calendar: String,
    pub title: String,
    /// RFC 3339; for all-day events, the date at local midnight.
    pub start: String,
    pub end: String,
    pub all_day: bool,
    pub location: Option<String>,
    pub url: Option<String>,
    pub attendees: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct MailItem {
    pub id: String,
    pub source: String,
    pub subject: String,
    pub from: String,
    pub date: String,
    pub snippet: String,
    pub url: Option<String>,
    pub unread: bool,
}

#[derive(Serialize, Clone, Debug)]
pub struct MailBody {
    pub subject: String,
    pub from: String,
    pub to: String,
    pub date: String,
    pub text: String,
    pub url: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct RemoteTask {
    pub id: String,
    pub source: String,
    pub list_id: String,
    pub list: String,
    pub title: String,
    pub done: bool,
    pub due: Option<String>,
}
