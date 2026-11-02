//! Gmail, Google Calendar and Google Tasks.
//!
//! Mac: "Desktop app" OAuth client with a loopback redirect. iPhone and Android: "iOS" OAuth client
//! with its reversed-client-ID URL scheme, caught by the deep-link plugin.

use super::oauth::{self, Pkce, TokenSet};
use super::{CalEvent, MailBody, MailItem, RemoteTask};
use crate::config;
use crate::error::{msg, Result};
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
            let url = url::Url::parse(&format!("http://127.0.0.1{target}")).map_err(|e| msg(e.to_string()))?;
            let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
            if q.get("code").is_none() && q.get("error").is_none() {
                // Favicon and other stray requests.
                let _ = sock.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n").await;
                continue;
            }
            let ok = q.get("state").map(String::as_str) == Some(state) && q.contains_key("code");
            let body = if ok {
                "<html><body style=\"font-family:system-ui;padding:3rem\"><h1>Google is connected</h1><p>Go back to Wandika. You can close this tab.</p></body></html>"
            } else {
                "<html><body style=\"font-family:system-ui;padding:3rem\"><h1>Google wasn't connected</h1><p>Go back to Wandika and try again.</p></body></html>"
            };
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
        if cal["selected"].as_bool() != Some(true) && cal["primary"].as_bool() != Some(true) {
            continue;
        }
        let id = cal["id"].as_str().unwrap_or_default();
        let name = cal["summaryOverride"].as_str().or(cal["summary"].as_str()).unwrap_or("Calendar").to_string();
        let mut url = url::Url::parse(&format!(
            "https://www.googleapis.com/calendar/v3/calendars/{}/events",
            url::form_urlencoded::byte_serialize(id.as_bytes()).collect::<String>()
        ))
        .unwrap();
        url.query_pairs_mut()
            .append_pair("timeMin", &from.to_rfc3339())
            .append_pair("timeMax", &to.to_rfc3339())
            .append_pair("singleEvents", "true")
            .append_pair("orderBy", "startTime")
            .append_pair("maxResults", "100");
        let v = get(http, secrets, url.as_str()).await?;
        for e in v["items"].as_array().cloned().unwrap_or_default() {
            if e["status"].as_str() == Some("cancelled") {
                continue;
            }
            // Skip events Jordan declined.
            let declined = e["attendees"].as_array().is_some_and(|a| {
                a.iter().any(|p| p["self"].as_bool() == Some(true) && p["responseStatus"].as_str() == Some("declined"))
            });
            if declined {
                continue;
            }
            let (start, all_day) = parse_time(&e["start"]);
            let (end, _) = parse_time(&e["end"]);
            out.push(CalEvent {
                id: e["id"].as_str().unwrap_or_default().to_string(),
                source: "google".into(),
                calendar: name.clone(),
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
            });
        }
    }
    Ok(out)
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
    Ok(msgs
        .into_iter()
        .map(|m| MailItem {
            id: m["id"].as_str().unwrap_or_default().to_string(),
            source: "google".into(),
            subject: header(&m, "Subject"),
            from: header(&m, "From"),
            date: m["internalDate"]
                .as_str()
                .and_then(|s| s.parse::<i64>().ok())
                .and_then(DateTime::from_timestamp_millis)
                .map(|d| d.to_rfc3339())
                .unwrap_or_default(),
            snippet: html_unescape(m["snippet"].as_str().unwrap_or_default()),
            url: m["threadId"].as_str().map(|t| format!("https://mail.google.com/mail/u/0/#inbox/{t}")),
            unread: m["labelIds"].as_array().is_some_and(|l| l.iter().any(|x| x == "UNREAD")),
        })
        .collect())
}

fn find_part(payload: &Value, mime: &str) -> Option<String> {
    if payload["mimeType"].as_str() == Some(mime) {
        if let Some(data) = payload["body"]["data"].as_str() {
            let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(data.trim_end_matches('='))
                .ok()?;
            return String::from_utf8(bytes).ok();
        }
    }
    payload["parts"].as_array()?.iter().find_map(|p| find_part(p, mime))
}

pub async fn mail_body(http: &reqwest::Client, secrets: &Secrets, id: &str) -> Result<MailBody> {
    let m = get(http, secrets, &format!("https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}?format=full")).await?;
    let text = find_part(&m["payload"], "text/plain")
        .or_else(|| find_part(&m["payload"], "text/html").map(|h| strip_html(&h)))
        .unwrap_or_else(|| html_unescape(m["snippet"].as_str().unwrap_or_default()));
    Ok(MailBody {
        subject: header(&m, "Subject"),
        from: header(&m, "From"),
        to: header(&m, "To"),
        date: header(&m, "Date"),
        text,
        url: m["threadId"].as_str().map(|t| format!("https://mail.google.com/mail/u/0/#inbox/{t}")),
    })
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
        for t in v["items"].as_array().cloned().unwrap_or_default() {
            let title = t["title"].as_str().unwrap_or_default().trim().to_string();
            if title.is_empty() {
                continue;
            }
            out.push(RemoteTask {
                id: t["id"].as_str().unwrap_or_default().to_string(),
                source: "google".into(),
                list_id: list_id.clone(),
                list: list.clone(),
                title,
                done: t["status"].as_str() == Some("completed"),
                due: t["due"].as_str().map(|d| d.chars().take(10).collect()),
            });
        }
    }
    Ok(out)
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
    let no_blocks = regex::Regex::new(r"(?is)<(script|style|head)[^>]*>.*?</\1>").unwrap().replace_all(html, "");
    let breaks = regex::Regex::new(r"(?i)<(br|/p|/div|/tr|/li|/h\d)[^>]*>").unwrap().replace_all(&no_blocks, "\n");
    let text = regex::Regex::new(r"<[^>]+>").unwrap().replace_all(&breaks, "");
    let text = html_unescape(&text);
    let blank = regex::Regex::new(r"\n\s*\n\s*\n+").unwrap();
    blank.replace_all(text.trim(), "\n\n").to_string()
}
