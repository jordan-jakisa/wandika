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
    if v["error_description"].is_string() {
        return Err(msg("Outlook didn't start sign-in. Try again in a minute."));
    }
    Ok(serde_json::from_value(v)?)
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
    match v["error"].as_str() {
        Some("authorization_pending") | Some("slow_down") => Ok(Poll::Pending),
        Some("expired_token") => Err(msg("The code expired. Connect Outlook again.")),
        Some("authorization_declined") | Some("access_denied") => Err(msg("Outlook sign-in was cancelled.")),
        _ => {
            let mut tokens = oauth::token_from("Outlook", &v, None)?;
            let me: Value = http
                .get(format!("{GRAPH}/me?$select=mail,userPrincipalName"))
                .bearer_auth(&tokens.access_token)
                .send()
                .await?
                .json()
                .await
                .unwrap_or(Value::Null);
            tokens.account = me["mail"].as_str().or(me["userPrincipalName"].as_str()).map(str::to_string);
            Ok(Poll::Done(tokens))
        }
    }
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
    let mut url = url::Url::parse(&format!("{GRAPH}/me/calendarView")).unwrap();
    url.query_pairs_mut()
        .append_pair("startDateTime", &from.to_rfc3339())
        .append_pair("endDateTime", &to.to_rfc3339())
        .append_pair("$orderby", "start/dateTime")
        .append_pair("$top", "100")
        .append_pair("$select", "id,subject,start,end,isAllDay,location,onlineMeeting,webLink,attendees,isCancelled,responseStatus");
    let v = get(http, secrets, url.as_str(), "outlook.timezone=\"UTC\"").await?;
    Ok(v["value"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|e| e["isCancelled"].as_bool() != Some(true) && e["responseStatus"]["response"].as_str() != Some("declined"))
        .map(|e| {
            let all_day = e["isAllDay"].as_bool().unwrap_or(false);
            let (start, end) = (graph_time(&e["start"]), graph_time(&e["end"]));
            CalEvent {
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
                            .filter_map(|p| {
                                p["emailAddress"]["name"].as_str().or(p["emailAddress"]["address"].as_str()).map(str::to_string)
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
            }
        })
        .collect())
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
    Ok(v["value"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|m| MailItem {
            id: m["id"].as_str().unwrap_or_default().to_string(),
            source: "microsoft".into(),
            subject: m["subject"].as_str().unwrap_or_default().to_string(),
            from: sender(&m),
            date: m["receivedDateTime"].as_str().unwrap_or_default().to_string(),
            snippet: m["bodyPreview"].as_str().unwrap_or_default().to_string(),
            url: m["webLink"].as_str().map(str::to_string),
            unread: m["isRead"].as_bool() == Some(false),
        })
        .collect())
}

pub async fn mail_body(http: &reqwest::Client, secrets: &Secrets, id: &str) -> Result<MailBody> {
    let m = get(
        http,
        secrets,
        &format!("{GRAPH}/me/messages/{id}?$select=subject,from,toRecipients,receivedDateTime,body,webLink"),
        "outlook.body-content-type=\"text\"",
    )
    .await?;
    Ok(MailBody {
        subject: m["subject"].as_str().unwrap_or_default().to_string(),
        from: sender(&m),
        to: m["toRecipients"]
            .as_array()
            .map(|a| a.iter().filter_map(|r| r["emailAddress"]["address"].as_str()).collect::<Vec<_>>().join(", "))
            .unwrap_or_default(),
        date: m["receivedDateTime"].as_str().unwrap_or_default().to_string(),
        text: m["body"]["content"].as_str().unwrap_or_default().trim().to_string(),
        url: m["webLink"].as_str().map(str::to_string),
    })
}
