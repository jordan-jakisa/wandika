//! Gmail, Google Calendar and Google Tasks.
//!
//! Mac: "Desktop app" OAuth client with a loopback redirect. iPhone and Android: "iOS" OAuth client
//! with its reversed-client-ID URL scheme, caught by the deep-link plugin.

use super::oauth::{self, Pkce, TokenSet};
use super::{CalEvent, MailBody, MailItem, RemoteTask};
use crate::config;
#[cfg(desktop)]
use crate::error::msg;
use crate::error::Result;
use crate::secrets::Secrets;
use base64::Engine;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};

pub const KEY: &str = "google";
const SCOPES: &str = "openid email https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/tasks";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";

fn client() -> Result<(&'static str, Option<&'static str>)> {
    if cfg!(mobile) {
        Ok((config::google_mobile_client_id()?, None))
    } else {
        let (id, secret) = config::google_desktop()?;
        Ok((id, Some(secret)))
    }
}

/// `123-abc.apps.googleusercontent.com` → `com.googleusercontent.apps.123-abc:/oauth2redirect`
#[cfg(mobile)]
pub fn mobile_redirect() -> Result<String> {
    let id = config::google_mobile_client_id()?;
    let prefix = id.trim_end_matches(".apps.googleusercontent.com");
    Ok(format!("com.googleusercontent.apps.{prefix}:/oauth2redirect"))
}

pub fn auth_url(redirect_uri: &str, pkce: &Pkce, state: &str) -> Result<String> {
    let (client_id, _) = client()?;
    let mut url = url::Url::parse("https://accounts.google.com/o/oauth2/v2/auth").unwrap();
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", SCOPES)
        .append_pair("code_challenge", &pkce.challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", state)
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent");
    Ok(url.into())
}

pub async fn exchange(http: &reqwest::Client, code: &str, verifier: &str, redirect_uri: &str) -> Result<TokenSet> {
    let (client_id, secret) = client()?;
    let mut form = vec![
        ("client_id", client_id),
        ("code", code),
        ("code_verifier", verifier),
        ("grant_type", "authorization_code"),
        ("redirect_uri", redirect_uri),
    ];
    if let Some(s) = secret {
        form.push(("client_secret", s));
    }
    let v = oauth::post_form(http, TOKEN_URL, &form).await?;
    let mut tokens = oauth::token_from("Google", &v, None)?;
    let me: Value = http
        .get("https://openidconnect.googleapis.com/v1/userinfo")
        .bearer_auth(&tokens.access_token)
        .send()
        .await?
        .json()
        .await
        .unwrap_or(Value::Null);
    tokens.account = me["email"].as_str().map(str::to_string);
    Ok(tokens)
}

async fn refresh(http: &reqwest::Client, refresh_token: String) -> Result<TokenSet> {
    let (client_id, secret) = client()?;
    let mut form = vec![
        ("client_id", client_id),
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token.as_str()),
    ];
    if let Some(s) = secret {
        form.push(("client_secret", s));
    }
    let v = oauth::post_form(http, TOKEN_URL, &form).await?;
    oauth::token_from("Google", &v, Some(refresh_token.clone()))
}

async fn token(http: &reqwest::Client, secrets: &Secrets) -> Result<String> {
    oauth::access_token(secrets, KEY, |rt| refresh(http, rt)).await
}

async fn get(http: &reqwest::Client, secrets: &Secrets, url: &str) -> Result<Value> {
    let t = token(http, secrets).await?;
    oauth::check_json("Google", http.get(url).bearer_auth(t).send().await?).await
}

/// Waits for the browser to come back to `http://127.0.0.1:<port>` with the code (Mac only).
#[cfg(desktop)]
pub async fn loopback() -> Result<(tokio::net::TcpListener, String)> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
    let port = listener.local_addr()?.port();
    Ok((listener, format!("http://127.0.0.1:{port}")))
}

/// The page the browser shows when Google sends it back: Wandika's colours, light or dark.
#[cfg(desktop)]
fn done_page(ok: bool) -> String {
    let (title, line, mark) = if ok {
        ("Google is connected", "Wandika is showing your mail, calendar and tasks. You can close this tab.", "<path d=\"M7 12.5l3.2 3.2L17 9\"/>")
    } else {
        ("Google wasn't connected", "Nothing was shared. Go back to Wandika and try again.", "<path d=\"M9 9l6 6M15 9l-6 6\"/>")
    };
    format!(
        r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{title} · Wandika</title>
<style>
:root{{--paper:#f2f3ef;--ink:#1c2320;--graphite:#59635e;--rule:#d6dad4;--accent:#2e6a4e;color-scheme:light dark}}
@media (prefers-color-scheme:dark){{:root{{--paper:#151917;--ink:#e3e7e2;--graphite:#9aa49e;--rule:#2c332f;--accent:#7fc19c}}}}
html,body{{height:100%;margin:0}}
body{{display:grid;place-items:center;background:var(--paper);color:var(--ink);font:17px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:24px;box-sizing:border-box}}
main{{max-width:30rem;text-align:center}}
svg{{width:56px;height:56px;fill:none;stroke:var(--accent);stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}}
circle{{stroke:var(--rule)}}
h1{{font-size:1.6rem;font-weight:650;letter-spacing:-0.01em;margin:20px 0 8px}}
p{{color:var(--graphite);margin:0}}
</style></head><body><main><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10.5"/>{mark}</svg><h1>{title}</h1><p>{line}</p></main></body></html>"#
    )
}

#[cfg(desktop)]
pub async fn await_code(listener: tokio::net::TcpListener, state: &str) -> Result<String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let accept = async {
        loop {
            let (mut sock, _) = listener.accept().await?;
            let mut buf = vec![0u8; 8192];
            let n = sock.read(&mut buf).await?;
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            let Some(target) = req.split_whitespace().nth(1) else { continue };
            let url = url::Url::parse(&format!("http://127.0.0.1{target}")).map_err(|_| msg("Google sent back an address Wandika couldn't read. Try connecting again."))?;
            let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
            if !q.contains_key("code") && !q.contains_key("error") {
                // Favicon and other stray requests.
                let _ = sock.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n").await;
                continue;
            }
            let ok = q.get("state").map(String::as_str) == Some(state) && q.contains_key("code");
            let body = done_page(ok);
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = sock.write_all(resp.as_bytes()).await;
            return if ok {
                Ok(q["code"].clone())
            } else {
                Err(msg("Google sign-in was cancelled."))
            };
        }
    };
    tokio::time::timeout(std::time::Duration::from_secs(300), accept)
        .await
        .map_err(|_| msg("Google sign-in timed out. Try again."))?
}

fn parse_time(v: &Value) -> (String, bool) {
    if let Some(dt) = v["dateTime"].as_str() {
        (dt.to_string(), false)
    } else {
        (format!("{}T00:00:00", v["date"].as_str().unwrap_or_default()), true)
    }
}

pub async fn events(http: &reqwest::Client, secrets: &Secrets, from: DateTime<Utc>, to: DateTime<Utc>) -> Result<Vec<CalEvent>> {
    let lists = get(http, secrets, "https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader").await?;
    let mut out = Vec::new();
    for cal in lists["items"].as_array().cloned().unwrap_or_default() {
        let Some((id, name)) = shown_calendar(&cal) else { continue };
        let v = get(http, secrets, events_url(&id, from, to).as_str()).await?;
        out.extend(v["items"].as_array().into_iter().flatten().filter_map(|e| event(e, &name)));
    }
    Ok(out)
}

/// A calendar's id and name, when it is ticked in Google Calendar (or is the main one).
fn shown_calendar(cal: &Value) -> Option<(String, String)> {
    if cal["selected"].as_bool() != Some(true) && cal["primary"].as_bool() != Some(true) {
        return None;
    }
    let name = cal["summaryOverride"].as_str().or(cal["summary"].as_str()).unwrap_or("Calendar").to_string();
    Some((cal["id"].as_str().unwrap_or_default().to_string(), name))
}

fn events_url(calendar_id: &str, from: DateTime<Utc>, to: DateTime<Utc>) -> url::Url {
    let mut url = url::Url::parse(&format!(
        "https://www.googleapis.com/calendar/v3/calendars/{}/events",
        url::form_urlencoded::byte_serialize(calendar_id.as_bytes()).collect::<String>()
    ))
    .unwrap();
    url.query_pairs_mut()
        .append_pair("timeMin", &from.to_rfc3339())
        .append_pair("timeMax", &to.to_rfc3339())
        .append_pair("singleEvents", "true")
        .append_pair("orderBy", "startTime")
        .append_pair("maxResults", "100");
    url
}

/// One event from the Calendar API; None for cancelled events and ones Jordan declined.
fn event(e: &Value, calendar: &str) -> Option<CalEvent> {
    if e["status"].as_str() == Some("cancelled") {
        return None;
    }
    let declined = e["attendees"].as_array().is_some_and(|a| {
        a.iter().any(|p| p["self"].as_bool() == Some(true) && p["responseStatus"].as_str() == Some("declined"))
    });
    if declined {
        return None;
    }
    let (start, all_day) = parse_time(&e["start"]);
    let (end, _) = parse_time(&e["end"]);
    Some(CalEvent {
        id: e["id"].as_str().unwrap_or_default().to_string(),
        source: "google".into(),
        calendar: calendar.to_string(),
        title: e["summary"].as_str().unwrap_or("(No title)").to_string(),
        start,
        end,
        all_day,
        location: e["location"].as_str().map(str::to_string),
        url: e["hangoutLink"].as_str().or(e["htmlLink"].as_str()).map(str::to_string),
        attendees: e["attendees"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter(|p| p["self"].as_bool() != Some(true))
                    .filter_map(|p| p["displayName"].as_str().or(p["email"].as_str()).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
    })
}

fn header(msg: &Value, name: &str) -> String {
    msg["payload"]["headers"]
        .as_array()
        .and_then(|h| h.iter().find(|x| x["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(name))))
        .and_then(|x| x["value"].as_str())
        .unwrap_or_default()
        .to_string()
}

pub async fn mail(http: &reqwest::Client, secrets: &Secrets) -> Result<Vec<MailItem>> {
    let list = get(http, secrets, "https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=INBOX&maxResults=15").await?;
    let ids: Vec<String> = list["messages"]
        .as_array()
        .map(|a| a.iter().filter_map(|m| m["id"].as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let fetches = ids.iter().map(|id| {
        let url = format!("https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date");
        async move { get(http, secrets, &url).await }
    });
    let msgs = futures::future::try_join_all(fetches).await?;
    Ok(msgs.iter().map(mail_item).collect())
}

fn thread_url(m: &Value) -> Option<String> {
    m["threadId"].as_str().map(|t| format!("https://mail.google.com/mail/u/0/#inbox/{t}"))
}

/// One inbox message, read with `format=metadata`.
fn mail_item(m: &Value) -> MailItem {
    MailItem {
        id: m["id"].as_str().unwrap_or_default().to_string(),
        source: "google".into(),
        subject: header(m, "Subject"),
        from: header(m, "From"),
        date: m["internalDate"]
            .as_str()
            .and_then(|s| s.parse::<i64>().ok())
            .and_then(DateTime::from_timestamp_millis)
            .map(|d| d.to_rfc3339())
            .unwrap_or_default(),
        snippet: html_unescape(m["snippet"].as_str().unwrap_or_default()),
        url: thread_url(m),
        unread: m["labelIds"].as_array().is_some_and(|l| l.iter().any(|x| x == "UNREAD")),
    }
}

fn find_part(payload: &Value, mime: &str) -> Option<String> {
    if payload["mimeType"].as_str() == Some(mime)
        && let Some(data) = payload["body"]["data"].as_str()
    {
        let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .decode(data.trim_end_matches('='))
            .ok()?;
        return String::from_utf8(bytes).ok();
    }
    payload["parts"].as_array()?.iter().find_map(|p| find_part(p, mime))
}

pub async fn mail_body(http: &reqwest::Client, secrets: &Secrets, id: &str) -> Result<MailBody> {
    let m = get(http, secrets, &format!("https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}?format=full")).await?;
    Ok(mail_body_of(&m))
}

/// A whole message (`format=full`): the plain text part, else the HTML one as text, else the snippet.
fn mail_body_of(m: &Value) -> MailBody {
    let text = find_part(&m["payload"], "text/plain")
        .or_else(|| find_part(&m["payload"], "text/html").map(|h| strip_html(&h)))
        .unwrap_or_else(|| html_unescape(m["snippet"].as_str().unwrap_or_default()));
    MailBody {
        subject: header(m, "Subject"),
        from: header(m, "From"),
        to: header(m, "To"),
        date: header(m, "Date"),
        text,
        html: find_part(&m["payload"], "text/html"),
        url: thread_url(m),
    }
}

pub async fn tasks(http: &reqwest::Client, secrets: &Secrets) -> Result<Vec<RemoteTask>> {
    let lists = get(http, secrets, "https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=20").await?;
    let mut out = Vec::new();
    for l in lists["items"].as_array().cloned().unwrap_or_default() {
        let list_id = l["id"].as_str().unwrap_or_default().to_string();
        let list = l["title"].as_str().unwrap_or("Tasks").to_string();
        let v = get(
            http,
            secrets,
            &format!("https://tasks.googleapis.com/tasks/v1/lists/{list_id}/tasks?showCompleted=false&maxResults=100"),
        )
        .await?;
        out.extend(v["items"].as_array().into_iter().flatten().filter_map(|t| task(t, &list_id, &list)));
    }
    Ok(out)
}

/// One Google task; None for the blank rows Google Tasks keeps.
fn task(t: &Value, list_id: &str, list: &str) -> Option<RemoteTask> {
    let title = t["title"].as_str().unwrap_or_default().trim().to_string();
    if title.is_empty() {
        return None;
    }
    Some(RemoteTask {
        id: t["id"].as_str().unwrap_or_default().to_string(),
        source: "google".into(),
        list_id: list_id.to_string(),
        list: list.to_string(),
        title,
        done: t["status"].as_str() == Some("completed"),
        due: t["due"].as_str().map(|d| d.chars().take(10).collect()),
    })
}

pub async fn set_task_done(http: &reqwest::Client, secrets: &Secrets, list_id: &str, id: &str, done: bool) -> Result<()> {
    let t = token(http, secrets).await?;
    let body = if done { json!({ "status": "completed" }) } else { json!({ "status": "needsAction", "completed": null }) };
    let res = http
        .patch(format!("https://tasks.googleapis.com/tasks/v1/lists/{list_id}/tasks/{id}"))
        .bearer_auth(t)
        .json(&body)
        .send()
        .await?;
    oauth::check_json("Google", res).await?;
    Ok(())
}

pub fn html_unescape(s: &str) -> String {
    s.replace("&#39;", "'").replace("&quot;", "\"").replace("&lt;", "<").replace("&gt;", ">").replace("&nbsp;", " ").replace("&amp;", "&")
}

/// Good enough to keep the words of an HTML-only email in a note.
pub fn strip_html(html: &str) -> String {
    // The regex crate has no backreferences, so each block element gets its own pattern.
    let mut no_blocks = html.to_string();
    for tag in ["script", "style", "head"] {
        let re = regex::Regex::new(&format!(r"(?is)<{tag}[^>]*>.*?</{tag}>")).unwrap();
        no_blocks = re.replace_all(&no_blocks, "").to_string();
    }
    let breaks = regex::Regex::new(r"(?i)<(br|/p|/div|/tr|/li|/h\d)[^>]*>").unwrap().replace_all(&no_blocks, "\n");
    let text = regex::Regex::new(r"<[^>]+>").unwrap().replace_all(&breaks, "");
    let text = html_unescape(&text);
    let blank = regex::Regex::new(r"\n\s*\n\s*\n+").unwrap();
    blank.replace_all(text.trim(), "\n\n").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_html_email() {
        let html = "<html><head><title>x</title></head><style>p{}</style><p>Hi &amp; welcome</p><div>Line two<br>three</div></html>";
        assert_eq!(strip_html(html), "Hi & welcome\nLine two\nthree");
    }

    fn b64(s: &str) -> String {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(s)
    }

    #[test]
    fn strip_html_drops_scripts_keeps_escaped_text_and_collapses_blank_lines() {
        let html = "<SCRIPT type=x>alert(1)</SCRIPT><p>1 &lt; 2 &amp;&amp; 3 &gt; 2</p>\n\n\n\n<h2>Next</h2><table><tr><td>a</td></tr></table><li>item</li>";
        assert_eq!(strip_html(html), "1 < 2 && 3 > 2\n\nNext\na\nitem");
        assert_eq!(strip_html("   "), "");
        assert_eq!(strip_html("plain text"), "plain text");
    }

    #[test]
    fn unescapes_gmail_entities_once() {
        assert_eq!(html_unescape("It&#39;s &quot;fine&quot; &lt;ok&gt;&nbsp;now"), "It's \"fine\" <ok> now");
        assert_eq!(html_unescape("&amp;lt; stays literal"), "&lt; stays literal", "never unescaped twice");
    }

    #[test]
    fn calendars_shown_are_the_ticked_ones_and_the_main_one() {
        assert_eq!(shown_calendar(&json!({ "id": "a@x", "summary": "Work", "selected": true })), Some(("a@x".into(), "Work".into())));
        assert_eq!(shown_calendar(&json!({ "id": "me", "summary": "Me", "summaryOverride": "Mine", "primary": true })), Some(("me".into(), "Mine".into())));
        assert_eq!(shown_calendar(&json!({ "id": "h", "selected": true })).unwrap().1, "Calendar");
        assert_eq!(shown_calendar(&json!({ "id": "holidays", "summary": "Holidays", "selected": false })), None);
        assert_eq!(shown_calendar(&json!({ "id": "other" })), None);
    }

    #[test]
    fn event_urls_escape_the_calendar_id_and_ask_for_one_day() {
        let from = DateTime::parse_from_rfc3339("2026-11-02T21:00:00Z").unwrap().to_utc();
        let to = from + chrono::Duration::days(1);
        let url = events_url("en.ug#holiday@group.v.calendar.google.com", from, to);
        assert_eq!(url.path(), "/calendar/v3/calendars/en.ug%23holiday%40group.v.calendar.google.com/events");
        let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(q["timeMin"], "2026-11-02T21:00:00+00:00");
        assert_eq!(q["timeMax"], "2026-11-03T21:00:00+00:00");
        assert_eq!((q["singleEvents"].as_str(), q["orderBy"].as_str(), q["maxResults"].as_str()), ("true", "startTime", "100"));
    }

    #[test]
    fn reads_events_and_skips_cancelled_and_declined_ones() {
        let e = event(
            &json!({
                "id": "e1", "summary": "Standup", "location": "Kampala office",
                "start": { "dateTime": "2026-11-03T09:00:00+03:00" }, "end": { "dateTime": "2026-11-03T09:15:00+03:00" },
                "hangoutLink": "https://meet.google.com/abc", "htmlLink": "https://calendar.google.com/e1",
                "attendees": [
                    { "email": "me@x", "self": true, "responseStatus": "accepted" },
                    { "email": "amina@x", "displayName": "Amina" },
                    { "email": "bob@x" }
                ]
            }),
            "Work",
        )
        .unwrap();
        assert_eq!((e.id.as_str(), e.source.as_str(), e.calendar.as_str(), e.title.as_str()), ("e1", "google", "Work", "Standup"));
        assert_eq!((e.start.as_str(), e.end.as_str(), e.all_day), ("2026-11-03T09:00:00+03:00", "2026-11-03T09:15:00+03:00", false));
        assert_eq!(e.url.as_deref(), Some("https://meet.google.com/abc"), "the meeting link before the calendar page");
        assert_eq!(e.attendees, ["Amina", "bob@x"], "everyone but me, by name when there is one");
        assert_eq!(e.location.as_deref(), Some("Kampala office"));

        let all_day = event(&json!({ "id": "e2", "start": { "date": "2026-11-03" }, "end": { "date": "2026-11-04" }, "htmlLink": "h" }), "Me").unwrap();
        assert_eq!((all_day.start.as_str(), all_day.end.as_str(), all_day.all_day), ("2026-11-03T00:00:00", "2026-11-04T00:00:00", true));
        assert_eq!(all_day.title, "(No title)");
        assert_eq!(all_day.url.as_deref(), Some("h"));
        assert!(all_day.attendees.is_empty() && all_day.location.is_none());

        assert!(event(&json!({ "status": "cancelled", "start": {}, "end": {} }), "Me").is_none());
        let declined = json!({ "start": {}, "end": {}, "attendees": [{ "self": true, "responseStatus": "declined" }] });
        assert!(event(&declined, "Me").is_none());
        let someone_else_declined = json!({ "start": {}, "end": {}, "attendees": [{ "email": "a", "responseStatus": "declined" }] });
        assert!(event(&someone_else_declined, "Me").is_some());
    }

    #[test]
    fn reads_inbox_items() {
        let m = json!({
            "id": "m1", "threadId": "t1", "labelIds": ["INBOX", "UNREAD"], "snippet": "Tom &amp; Jerry&#39;s plan",
            "internalDate": "1762156800000",
            "payload": { "headers": [{ "name": "subject", "value": "Plan" }, { "name": "From", "value": "Amina <a@x>" }] }
        });
        let item = mail_item(&m);
        assert_eq!((item.id.as_str(), item.source.as_str(), item.subject.as_str(), item.from.as_str()), ("m1", "google", "Plan", "Amina <a@x>"));
        assert_eq!(item.snippet, "Tom & Jerry's plan");
        assert_eq!(item.date, "2025-11-03T08:00:00+00:00");
        assert_eq!(item.url.as_deref(), Some("https://mail.google.com/mail/u/0/#inbox/t1"));
        assert!(item.unread);
        let bare = mail_item(&json!({ "id": "m2", "internalDate": "soon" }));
        assert_eq!((bare.subject.as_str(), bare.date.as_str(), bare.url, bare.unread), ("", "", None, false));
    }

    #[test]
    fn reads_the_plain_part_then_the_html_part_then_the_snippet() {
        let headers = json!([{ "name": "Subject", "value": "Hi" }, { "name": "To", "value": "me@x" }, { "name": "Date", "value": "Mon, 3 Nov 2026" }]);
        let nested = json!({ "threadId": "t", "payload": { "headers": headers, "mimeType": "multipart/mixed", "parts": [
            { "mimeType": "multipart/alternative", "parts": [
                { "mimeType": "text/html", "body": { "data": b64("<p>html</p>") } },
                { "mimeType": "text/plain", "body": { "data": b64("plain ✓ text") } }
            ]},
            { "mimeType": "application/pdf", "body": { "attachmentId": "a" } }
        ]}});
        let body = mail_body_of(&nested);
        assert_eq!(body.text, "plain ✓ text");
        assert_eq!(body.html.as_deref(), Some("<p>html</p>"), "the HTML part is kept for reading in the app");
        assert_eq!((body.subject.as_str(), body.to.as_str(), body.date.as_str()), ("Hi", "me@x", "Mon, 3 Nov 2026"));
        assert_eq!(body.url.as_deref(), Some("https://mail.google.com/mail/u/0/#inbox/t"));

        let padded = format!("{}==", b64("<div>Only</div><div>html</div>"));
        let html_only = json!({ "payload": { "mimeType": "text/html", "body": { "data": padded } } });
        assert_eq!(mail_body_of(&html_only).text, "Only\nhtml");
        assert!(mail_body_of(&json!({ "payload": { "mimeType": "text/plain", "body": { "data": b64("x") } } })).html.is_none());

        let empty = json!({ "snippet": "Just the &quot;snippet&quot;", "payload": { "mimeType": "text/plain", "body": { "size": 0 } } });
        assert_eq!(mail_body_of(&empty).text, "Just the \"snippet\"");
        let broken = json!({ "snippet": "fallback", "payload": { "mimeType": "text/plain", "body": { "data": "%%%" } } });
        assert_eq!(mail_body_of(&broken).text, "fallback", "an unreadable part falls back to the snippet");
    }

    #[test]
    fn reads_tasks_and_skips_blank_ones() {
        let t = task(&json!({ "id": "1", "title": "  Pay rent ", "status": "needsAction", "due": "2026-11-05T00:00:00.000Z" }), "L", "My Tasks").unwrap();
        assert_eq!((t.id.as_str(), t.title.as_str(), t.list_id.as_str(), t.list.as_str()), ("1", "Pay rent", "L", "My Tasks"));
        assert_eq!((t.done, t.due.as_deref(), t.source.as_str()), (false, Some("2026-11-05"), "google"));
        assert!(task(&json!({ "id": "2", "title": "Done", "status": "completed" }), "L", "x").unwrap().done);
        assert!(task(&json!({ "id": "3", "title": "   " }), "L", "x").is_none());
        assert!(task(&json!({ "id": "4" }), "L", "x").is_none());
    }

    #[test]
    fn the_sign_in_address_asks_for_offline_access_with_pkce() {
        let p = Pkce { verifier: "v".into(), challenge: "c".into() };
        match auth_url("http://127.0.0.1:5555", &p, "st") {
            Ok(url) => {
                let url = url::Url::parse(&url).unwrap();
                assert_eq!(url.host_str(), Some("accounts.google.com"));
                let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
                assert_eq!(q["client_id"], client().unwrap().0);
                assert_eq!(q["redirect_uri"], "http://127.0.0.1:5555");
                assert_eq!((q["code_challenge"].as_str(), q["code_challenge_method"].as_str()), ("c", "S256"));
                assert_eq!((q["state"].as_str(), q["access_type"].as_str(), q["prompt"].as_str()), ("st", "offline", "consent"));
                assert_eq!(q["scope"], SCOPES);
                assert!(SCOPES.contains("gmail.readonly") && SCOPES.contains("calendar.readonly") && SCOPES.contains("/auth/tasks"));
            }
            Err(e) => assert!(e.to_string().starts_with("Google isn't set up in this build yet."), "{e}"),
        }
    }

    /// The browser's side of the loopback sign-in.
    fn browser(port: u16, requests: Vec<&'static str>) -> std::thread::JoinHandle<Vec<String>> {
        std::thread::spawn(move || {
            use std::io::{Read, Write};
            requests
                .into_iter()
                .map(|r| {
                    let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
                    s.write_all(r.as_bytes()).unwrap();
                    let mut out = String::new();
                    let _ = s.read_to_string(&mut out);
                    out
                })
                .collect()
        })
    }

    #[test]
    fn the_loopback_sign_in_takes_the_code_and_ignores_stray_requests() {
        crate::test_http::block_on(async {
            let (listener, redirect) = loopback().await.unwrap();
            let port: u16 = redirect.rsplit(':').next().unwrap().parse().unwrap();
            assert_eq!(redirect, format!("http://127.0.0.1:{port}"));
            let b = browser(port, vec!["GET /favicon.ico HTTP/1.1\r\n\r\n", "GET /?state=good&code=4%2Fabc HTTP/1.1\r\n\r\n"]);
            assert_eq!(await_code(listener, "good").await.unwrap(), "4/abc");
            let pages = b.join().unwrap();
            assert!(pages[0].starts_with("HTTP/1.1 404"));
            assert!(pages[1].starts_with("HTTP/1.1 200") && pages[1].contains("Google is connected"));
        });
    }

    #[test]
    fn the_return_page_is_a_whole_page_in_wandika_colours_both_ways() {
        let ok = done_page(true);
        assert!(ok.starts_with("<!doctype html>") && ok.contains("<meta name=\"viewport\""));
        assert!(ok.contains("prefers-color-scheme:dark") && ok.contains("#2e6a4e") && ok.contains("#7fc19c"));
        assert!(ok.contains("<h1>Google is connected</h1>") && ok.contains("You can close this tab."));
        let failed = done_page(false);
        assert!(failed.contains("<h1>Google wasn't connected</h1>") && failed.contains("try again"));
        assert!(!ok.contains('—') && !failed.contains('—'), "no em dashes");
    }

    #[test]
    fn the_loopback_sign_in_refuses_a_wrong_state_or_a_refusal() {
        crate::test_http::block_on(async {
            for request in ["GET /?state=forged&code=abc HTTP/1.1\r\n\r\n", "GET /?error=access_denied&state=good HTTP/1.1\r\n\r\n"] {
                let (listener, redirect) = loopback().await.unwrap();
                let port: u16 = redirect.rsplit(':').next().unwrap().parse().unwrap();
                let b = browser(port, vec![request]);
                assert_eq!(await_code(listener, "good").await.unwrap_err().to_string(), "Google sign-in was cancelled.");
                assert!(b.join().unwrap()[0].contains("Google wasn't connected"));
            }
        });
    }
}
