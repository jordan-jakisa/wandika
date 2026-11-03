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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_event_round_trips_through_the_interface() {
        // The shape the interface sends back to "Make a note" for an event.
        let sent = json!({
            "id": "e1", "source": "google", "calendar": "Work", "title": "Standup",
            "start": "2026-11-03T09:00:00+03:00", "end": "2026-11-03T09:15:00+03:00", "all_day": false,
            "location": null, "url": "https://meet.google.com/abc", "attendees": ["Amina"]
        });
        let e: CalEvent = serde_json::from_value(sent.clone()).unwrap();
        assert_eq!(e.location, None);
        assert_eq!(serde_json::to_value(&e).unwrap(), sent);
        let missing = json!({ "id": "e1", "title": "No times" });
        assert!(serde_json::from_value::<CalEvent>(missing).is_err(), "every field is required");
    }

    #[test]
    fn mail_and_tasks_reach_the_interface_with_these_names() {
        let mail = MailItem {
            id: "m".into(), source: "microsoft".into(), subject: "s".into(), from: "f".into(), date: "d".into(),
            snippet: "p".into(), url: None, unread: true,
        };
        assert_eq!(
            serde_json::to_value(mail).unwrap(),
            json!({ "id": "m", "source": "microsoft", "subject": "s", "from": "f", "date": "d", "snippet": "p", "url": null, "unread": true })
        );
        let task = RemoteTask {
            id: "t".into(), source: "apple".into(), list_id: "l".into(), list: "Reminders".into(), title: "Pay".into(), done: false,
            due: Some("2026-11-05".into()),
        };
        assert_eq!(
            serde_json::to_value(task).unwrap(),
            json!({ "id": "t", "source": "apple", "list_id": "l", "list": "Reminders", "title": "Pay", "done": false, "due": "2026-11-05" })
        );
        let body = MailBody { subject: "s".into(), from: "f".into(), to: "t".into(), date: "d".into(), text: "x".into(), url: None };
        assert_eq!(serde_json::to_value(body).unwrap().as_object().unwrap().len(), 6);
    }
}
