//! Outlook mail and calendar through Microsoft Graph. Sign-in uses the device-code flow, so it
//! works the same on every platform with no redirect to catch.

use super::oauth::{self, TokenSet};
use super::{CalEvent, MailBody, MailItem};
use crate::config;
use crate::error::{msg, Result};
use crate::secrets::Secrets;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const KEY: &str = "microsoft";
const SCOPES: &str = "offline_access User.Read Mail.Read Calendars.Read";
const AUTHORITY: &str = "https://login.microsoftonline.com/common/oauth2/v2.0";
const GRAPH: &str = "https://graph.microsoft.com/v1.0";

#[derive(Serialize, Deserialize, Clone)]
pub struct DeviceStart {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub interval: u64,
    pub expires_in: u64,
}

pub enum Poll {
    Pending,
    Done(TokenSet),
}

pub async fn start(http: &reqwest::Client) -> Result<DeviceStart> {
    let client_id = config::microsoft_client_id()?;
    let v = oauth::post_form(http, &format!("{AUTHORITY}/devicecode"), &[("client_id", client_id), ("scope", SCOPES)]).await?;
    start_answer(v)
}

fn start_answer(v: Value) -> Result<DeviceStart> {
    if v["error_description"].is_string() {
        return Err(msg("Outlook didn't start sign-in. Try again in a minute."));
    }
    Ok(serde_json::from_value(v)?)
}

/// One poll's answer: None while Jordan hasn't finished signing in, then the tokens.
fn poll_answer(v: &Value) -> Result<Option<TokenSet>> {
    match v["error"].as_str() {
        Some("authorization_pending") | Some("slow_down") => Ok(None),
        Some("expired_token") => Err(msg("The code expired. Connect Outlook again.")),
        Some("authorization_declined") | Some("access_denied") => Err(msg("Outlook sign-in was cancelled.")),
        _ => oauth::token_from("Outlook", v, None).map(Some),
    }
}

pub async fn poll(http: &reqwest::Client, device_code: &str) -> Result<Poll> {
    let client_id = config::microsoft_client_id()?;
    let v = oauth::post_form(
        http,
        &format!("{AUTHORITY}/token"),
        &[
            ("client_id", client_id),
            ("device_code", device_code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ],
    )
    .await?;
    let Some(mut tokens) = poll_answer(&v)? else { return Ok(Poll::Pending) };
    let me: Value = http
        .get(format!("{GRAPH}/me?$select=mail,userPrincipalName"))
        .bearer_auth(&tokens.access_token)
        .send()
        .await?
        .json()
        .await
        .unwrap_or(Value::Null);
    tokens.account = account_of(&me);
    Ok(Poll::Done(tokens))
}

/// The address shown for the account: its mailbox, or the sign-in name when it has none.
fn account_of(me: &Value) -> Option<String> {
    me["mail"].as_str().or(me["userPrincipalName"].as_str()).map(str::to_string)
}

async fn refresh(http: &reqwest::Client, refresh_token: String) -> Result<TokenSet> {
    let client_id = config::microsoft_client_id()?;
    let v = oauth::post_form(
        http,
        &format!("{AUTHORITY}/token"),
        &[
            ("client_id", client_id),
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token.as_str()),
            ("scope", SCOPES),
        ],
    )
    .await?;
    oauth::token_from("Outlook", &v, Some(refresh_token.clone()))
}

async fn get(http: &reqwest::Client, secrets: &Secrets, url: &str, prefer: &str) -> Result<Value> {
    let t = oauth::access_token(secrets, KEY, |rt| refresh(http, rt)).await?;
    let res = http.get(url).bearer_auth(t).header("Prefer", prefer).send().await?;
    oauth::check_json("Outlook", res).await
}

fn graph_time(v: &Value) -> String {
    // Graph returns "2026-11-02T09:00:00.0000000" in the zone we asked for (UTC).
    let s = v["dateTime"].as_str().unwrap_or_default();
    let trimmed = s.split('.').next().unwrap_or(s);
    format!("{trimmed}Z")
}

pub async fn events(http: &reqwest::Client, secrets: &Secrets, from: DateTime<Utc>, to: DateTime<Utc>) -> Result<Vec<CalEvent>> {
    let v = get(http, secrets, calendar_view_url(from, to).as_str(), "outlook.timezone=\"UTC\"").await?;
    Ok(v["value"].as_array().into_iter().flatten().filter_map(event).collect())
}

fn calendar_view_url(from: DateTime<Utc>, to: DateTime<Utc>) -> url::Url {
    let mut url = url::Url::parse(&format!("{GRAPH}/me/calendarView")).unwrap();
    url.query_pairs_mut()
        .append_pair("startDateTime", &from.to_rfc3339())
        .append_pair("endDateTime", &to.to_rfc3339())
        .append_pair("$orderby", "start/dateTime")
        .append_pair("$top", "100")
        .append_pair("$select", "id,subject,start,end,isAllDay,location,onlineMeeting,webLink,attendees,isCancelled,responseStatus");
    url
}

/// One calendar event from Graph; None for cancelled events and ones Jordan declined.
fn event(e: &Value) -> Option<CalEvent> {
    if e["isCancelled"].as_bool() == Some(true) || e["responseStatus"]["response"].as_str() == Some("declined") {
        return None;
    }
    let all_day = e["isAllDay"].as_bool().unwrap_or(false);
    let (start, end) = (graph_time(&e["start"]), graph_time(&e["end"]));
    Some(CalEvent {
        id: e["id"].as_str().unwrap_or_default().to_string(),
        source: "microsoft".into(),
        calendar: "Outlook".into(),
        title: e["subject"].as_str().filter(|s| !s.is_empty()).unwrap_or("(No title)").to_string(),
        // All-day events are dates, not instants; drop the zone so they stay on their day.
        start: if all_day { start.trim_end_matches('Z').to_string() } else { start },
        end: if all_day { end.trim_end_matches('Z').to_string() } else { end },
        all_day,
        location: e["location"]["displayName"].as_str().filter(|s| !s.is_empty()).map(str::to_string),
        url: e["onlineMeeting"]["joinUrl"].as_str().or(e["webLink"].as_str()).map(str::to_string),
        attendees: e["attendees"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|p| p["emailAddress"]["name"].as_str().or(p["emailAddress"]["address"].as_str()).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
    })
}

fn sender(m: &Value) -> String {
    let name = m["from"]["emailAddress"]["name"].as_str().unwrap_or_default();
    let addr = m["from"]["emailAddress"]["address"].as_str().unwrap_or_default();
    if name.is_empty() { addr.to_string() } else { format!("{name} <{addr}>") }
}

pub async fn mail(http: &reqwest::Client, secrets: &Secrets) -> Result<Vec<MailItem>> {
    let v = get(
        http,
        secrets,
        &format!("{GRAPH}/me/mailFolders/inbox/messages?$top=15&$select=id,subject,from,receivedDateTime,bodyPreview,webLink,isRead&$orderby=receivedDateTime desc"),
        "outlook.body-content-type=\"text\"",
    )
    .await?;
    Ok(v["value"].as_array().into_iter().flatten().map(mail_item).collect())
}

fn mail_item(m: &Value) -> MailItem {
    MailItem {
        id: m["id"].as_str().unwrap_or_default().to_string(),
        source: "microsoft".into(),
        subject: m["subject"].as_str().unwrap_or_default().to_string(),
        from: sender(m),
        date: m["receivedDateTime"].as_str().unwrap_or_default().to_string(),
        snippet: m["bodyPreview"].as_str().unwrap_or_default().to_string(),
        url: m["webLink"].as_str().map(str::to_string),
        unread: m["isRead"].as_bool() == Some(false),
    }
}

pub async fn mail_body(http: &reqwest::Client, secrets: &Secrets, id: &str) -> Result<MailBody> {
    let m = get(
        http,
        secrets,
        &format!("{GRAPH}/me/messages/{id}?$select=subject,from,toRecipients,receivedDateTime,body,webLink"),
        "outlook.body-content-type=\"text\"",
    )
    .await?;
    Ok(mail_body_of(&m))
}

fn mail_body_of(m: &Value) -> MailBody {
    MailBody {
        subject: m["subject"].as_str().unwrap_or_default().to_string(),
        from: sender(m),
        to: m["toRecipients"]
            .as_array()
            .map(|a| a.iter().filter_map(|r| r["emailAddress"]["address"].as_str()).collect::<Vec<_>>().join(", "))
            .unwrap_or_default(),
        date: m["receivedDateTime"].as_str().unwrap_or_default().to_string(),
        text: m["body"]["content"].as_str().unwrap_or_default().trim().to_string(),
        url: m["webLink"].as_str().map(str::to_string),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn device_sign_in_answers() {
        let start = start_answer(json!({ "device_code": "dc", "user_code": "ABC123", "verification_uri": "https://microsoft.com/devicelogin", "interval": 5, "expires_in": 900, "message": "x" })).unwrap();
        assert_eq!((start.user_code.as_str(), start.interval, start.expires_in), ("ABC123", 5, 900));
        let e = start_answer(json!({ "error": "invalid_client", "error_description": "AADSTS700016: app not found" })).err().unwrap();
        assert_eq!(e.to_string(), "Outlook didn't start sign-in. Try again in a minute.", "Microsoft's text stays out of sight");
        assert_eq!(start_answer(json!({ "user_code": "x" })).err().unwrap().friendly().0, "bad_response");

        assert!(poll_answer(&json!({ "error": "authorization_pending" })).unwrap().is_none());
        assert!(poll_answer(&json!({ "error": "slow_down" })).unwrap().is_none());
        let said = |v: Value| poll_answer(&v).err().unwrap().to_string();
        assert_eq!(said(json!({ "error": "expired_token" })), "The code expired. Connect Outlook again.");
        assert_eq!(said(json!({ "error": "authorization_declined" })), "Outlook sign-in was cancelled.");
        assert_eq!(said(json!({ "error": "access_denied" })), "Outlook sign-in was cancelled.");
        let e = poll_answer(&json!({ "error": "bad_verification_code", "error_description": "AADSTS70019" })).err().unwrap();
        assert!(matches!(e, crate::error::Error::Provider { provider: "Outlook", status: 400, .. }));
        let t = poll_answer(&json!({ "access_token": "a", "refresh_token": "r", "expires_in": 3599 })).unwrap().unwrap();
        assert_eq!((t.access_token.as_str(), t.refresh_token.as_deref()), ("a", Some("r")));

        assert_eq!(account_of(&json!({ "mail": "amina@outlook.com", "userPrincipalName": "upn" })).as_deref(), Some("amina@outlook.com"));
        assert_eq!(account_of(&json!({ "mail": null, "userPrincipalName": "amina_live#EXT#" })).as_deref(), Some("amina_live#EXT#"));
        assert_eq!(account_of(&Value::Null), None);
    }

    #[test]
    fn the_calendar_view_asks_for_one_day_in_order() {
        let from = DateTime::parse_from_rfc3339("2026-11-02T21:00:00Z").unwrap().to_utc();
        let url = calendar_view_url(from, from + chrono::Duration::days(1));
        assert_eq!(url.as_str().split('?').next(), Some("https://graph.microsoft.com/v1.0/me/calendarView"));
        let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(q["startDateTime"], "2026-11-02T21:00:00+00:00");
        assert_eq!(q["endDateTime"], "2026-11-03T21:00:00+00:00");
        assert_eq!((q["$orderby"].as_str(), q["$top"].as_str()), ("start/dateTime", "100"));
        assert!(q["$select"].contains("isCancelled") && q["$select"].contains("responseStatus"));
    }

    #[test]
    fn graph_times_become_utc_instants() {
        assert_eq!(graph_time(&json!({ "dateTime": "2026-11-02T09:00:00.0000000", "timeZone": "UTC" })), "2026-11-02T09:00:00Z");
        assert_eq!(graph_time(&json!({ "dateTime": "2026-11-02T09:00:00" })), "2026-11-02T09:00:00Z");
    }

    #[test]
    fn reads_events_and_skips_cancelled_and_declined_ones() {
        let e = event(&json!({
            "id": "e1", "subject": "Board meeting", "isAllDay": false,
            "start": { "dateTime": "2026-11-03T06:00:00.0000000" }, "end": { "dateTime": "2026-11-03T07:00:00.0000000" },
            "location": { "displayName": "Room 4" }, "onlineMeeting": { "joinUrl": "https://teams/join" }, "webLink": "https://outlook/e1",
            "attendees": [{ "emailAddress": { "name": "Amina", "address": "a@x" } }, { "emailAddress": { "address": "b@x" } }, { "type": "resource" }],
            "responseStatus": { "response": "accepted" }
        }))
        .unwrap();
        assert_eq!((e.id.as_str(), e.source.as_str(), e.calendar.as_str(), e.title.as_str()), ("e1", "microsoft", "Outlook", "Board meeting"));
        assert_eq!((e.start.as_str(), e.end.as_str()), ("2026-11-03T06:00:00Z", "2026-11-03T07:00:00Z"));
        assert_eq!(e.url.as_deref(), Some("https://teams/join"));
        assert_eq!(e.location.as_deref(), Some("Room 4"));
        assert_eq!(e.attendees, ["Amina", "b@x"]);

        let all_day = event(&json!({
            "id": "e2", "subject": "", "isAllDay": true, "webLink": "https://outlook/e2", "location": { "displayName": "" },
            "start": { "dateTime": "2026-11-03T00:00:00.0000000" }, "end": { "dateTime": "2026-11-04T00:00:00.0000000" }
        }))
        .unwrap();
        assert_eq!((all_day.start.as_str(), all_day.end.as_str()), ("2026-11-03T00:00:00", "2026-11-04T00:00:00"), "dates stay on their day");
        assert_eq!(all_day.title, "(No title)");
        assert_eq!(all_day.url.as_deref(), Some("https://outlook/e2"));
        assert_eq!(all_day.location, None, "an empty place is no place");

        assert!(event(&json!({ "isCancelled": true })).is_none());
        assert!(event(&json!({ "responseStatus": { "response": "declined" } })).is_none());
        assert!(event(&json!({ "responseStatus": { "response": "tentativelyAccepted" } })).is_some());
    }

    #[test]
    fn reads_inbox_items_and_whole_messages() {
        let m = json!({
            "id": "m1", "subject": "Invoice", "receivedDateTime": "2026-11-03T08:00:00Z", "bodyPreview": "Please find",
            "webLink": "https://outlook/m1", "isRead": false,
            "from": { "emailAddress": { "name": "Amina K", "address": "amina@x" } }
        });
        let item = mail_item(&m);
        assert_eq!((item.id.as_str(), item.source.as_str(), item.subject.as_str()), ("m1", "microsoft", "Invoice"));
        assert_eq!((item.from.as_str(), item.date.as_str(), item.snippet.as_str()), ("Amina K <amina@x>", "2026-11-03T08:00:00Z", "Please find"));
        assert!(item.unread);
        assert!(!mail_item(&json!({ "isRead": true })).unread);
        assert!(!mail_item(&json!({})).unread, "unknown is not unread");
        assert_eq!(sender(&json!({ "from": { "emailAddress": { "name": "", "address": "noreply@x" } } })), "noreply@x");
        assert_eq!(sender(&json!({})), "");

        let body = mail_body_of(&json!({
            "subject": "Invoice", "receivedDateTime": "2026-11-03T08:00:00Z", "webLink": "https://outlook/m1",
            "from": { "emailAddress": { "address": "amina@x" } },
            "toRecipients": [{ "emailAddress": { "address": "me@x" } }, { "emailAddress": { "address": "you@x" } }],
            "body": { "contentType": "text", "content": "\r\n  Please find it attached.  \r\n" }
        }));
        assert_eq!((body.from.as_str(), body.to.as_str()), ("amina@x", "me@x, you@x"));
        assert_eq!(body.text, "Please find it attached.");
        assert_eq!(body.url.as_deref(), Some("https://outlook/m1"));
        let empty = mail_body_of(&json!({}));
        assert_eq!((empty.to.as_str(), empty.text.as_str(), empty.url), ("", "", None));
    }

    #[test]
    fn scopes_ask_to_read_only() {
        assert_eq!(SCOPES, "offline_access User.Read Mail.Read Calendars.Read");
    }
}
